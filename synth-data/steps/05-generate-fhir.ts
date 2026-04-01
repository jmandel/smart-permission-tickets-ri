#!/usr/bin/env bun
/**
 * Step 05: Generate FHIR resources (two-pass)
 *
 * Pass A: Per site, generate scaffold (Patient, Org, Practitioners,
 *         persistent Conditions, Allergies, Meds) → sites/<slug>/scaffold.json
 * Pass B: Per encounter, generate encounter-specific resources with
 *         scaffold IDs as context → sites/<slug>/resources/<Type>/<id>.json
 *
 * Each call gets:
 *   1. Real FHIR examples from seed data (structural depth reference)
 *   2. Patient biography + encounter context (fractal narrative)
 *   3. Site scaffold (persistent resource IDs for referencing)
 */

import { resolve } from "path";
import { mkdir, readdir } from "fs/promises";
import { PIPELINE_ROOT, callClaude, parseEncounters, createLimiter, encId } from "./lib.ts";

const MAX_CONCURRENCY = 2;

/** Parse the encounters file and group encounters by site */
function groupEncountersBySite(encountersText: string): Map<string, Array<{ index: number; heading: string; text: string }>> {
  const sites = new Map<string, Array<{ index: number; heading: string; text: string }>>();
  let currentSite = "default";

  const allEncounters = parseEncounters(encountersText);

  // Also parse site headers to map encounters to sites
  const lines = encountersText.split("\n");
  let encIdx = 0;
  for (const line of lines) {
    const siteMatch = line.match(/^## Site \d+[^:]*:\s*(.+)/);
    if (siteMatch) {
      currentSite = siteMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    }
    // When we hit an encounter header, assign it to current site
    const encMatch = line.match(/^### \d{4}/);
    if (encMatch && encIdx < allEncounters.length) {
      if (!sites.has(currentSite)) sites.set(currentSite, []);
      sites.get(currentSite)!.push(allEncounters[encIdx]);
      encIdx++;
    }
  }

  return sites;
}

async function loadFewShots(): Promise<string> {
  const fewShotDir = `${PIPELINE_ROOT}/few-shots`;
  let context = "";
  try {
    const files = (await readdir(fewShotDir)).filter(f => f.endsWith(".json")).sort();
    for (const f of files) {
      const content = await Bun.file(`${fewShotDir}/${f}`).text();
      context += `\n### ${f}\n\`\`\`json\n${content}\n\`\`\`\n`;
    }
  } catch { /* no few-shots available */ }
  return context;
}

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const bioFile = `${patientDir}/biography.md`;
  const encountersFile = `${patientDir}/encounters.md`;
  const inventoryDir = `${patientDir}/inventories`;
  const notesDir = `${patientDir}/notes`;
  const sitesDir = `${patientDir}/sites`;

  if (!await Bun.file(bioFile).exists() || !await Bun.file(encountersFile).exists()) {
    console.error("Usage: bun run steps/05-generate-fhir.ts <patient-dir>");
    process.exit(1);
  }

  await mkdir(sitesDir, { recursive: true });

  const biography = await Bun.file(bioFile).text();
  const encountersText = await Bun.file(encountersFile).text();
  const fewShots = await loadFewShots();
  const scaffoldPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/scaffold.md`).text();
  const encounterPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/fhir-generation.md`).text();

  const siteEncounters = groupEncountersBySite(encountersText);
  console.log(`[05] Found ${siteEncounters.size} sites: ${[...siteEncounters.keys()].join(", ")}`);

  // ─── Pass A: Generate scaffolds per site ───

  console.log(`\n[05] === Pass A: Generating site scaffolds ===`);

  for (const [siteSlug, encounters] of siteEncounters) {
    const siteDir = `${sitesDir}/${siteSlug}`;
    await mkdir(`${siteDir}/resources`, { recursive: true });

    const scaffoldFile = `${siteDir}/scaffold.json`;
    if (!force && await Bun.file(scaffoldFile).exists()) {
      console.log(`[05] Scaffold exists for ${siteSlug} — skipping`);
      continue;
    }

    // Build site-specific encounter context
    const siteEncText = encounters.map(e => e.text).join("\n\n");

    const userMessage = [
      `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
      `## Patient Biography\n\n${biography}`,
      `## Encounters at This Site\n\n${siteEncText}`,
      `\nGenerate the scaffold resources for this site. Raw JSON array only.`,
    ].join("\n\n");

    console.log(`[05] Generating scaffold for ${siteSlug} (${encounters.length} encounters)...`);
    const result = await callClaude({ systemPrompt: scaffoldPrompt, userMessage, model: "sonnet" });

    // Parse and save scaffold
    const jsonStr = (result.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? result).trim();
    let resources: any[];
    try {
      const parsed = JSON.parse(jsonStr);
      resources = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      await Bun.write(`${siteDir}/scaffold-raw.txt`, result);
      throw new Error(`Failed to parse scaffold JSON for ${siteSlug} — raw output saved`);
    }

    await Bun.write(scaffoldFile, JSON.stringify(resources, null, 2));

    // Also write individual resource files
    for (const resource of resources) {
      const rType = resource.resourceType;
      if (!rType) continue;
      resource.id = resource.id || crypto.randomUUID();
      const typeDir = `${siteDir}/resources/${rType}`;
      await mkdir(typeDir, { recursive: true });
      await Bun.write(`${typeDir}/${resource.id}.json`, JSON.stringify(resource, null, 2));
    }

    console.log(`[05] Scaffold for ${siteSlug}: ${resources.length} resources (${resources.map(r => r.resourceType).join(", ")})`);
  }

  // ─── Pass B: Generate per-encounter resources ───

  console.log(`\n[05] === Pass B: Generating per-encounter resources ===`);

  const limit = createLimiter(MAX_CONCURRENCY);
  let completed = 0;
  const totalEncounters = [...siteEncounters.values()].reduce((s, e) => s + e.length, 0);

  const tasks: Promise<any>[] = [];

  for (const [siteSlug, encounters] of siteEncounters) {
    const siteDir = `${sitesDir}/${siteSlug}`;
    const scaffoldFile = `${siteDir}/scaffold.json`;

    let scaffold = "[]";
    if (await Bun.file(scaffoldFile).exists()) {
      scaffold = await Bun.file(scaffoldFile).text();
    }

    for (const enc of encounters) {
      tasks.push(
        limit(async () => {
          const id = encId(enc.index);
          const doneMarker = `${siteDir}/.done-${id}`;
          if (!force && await Bun.file(doneMarker).exists()) {
            completed++;
            return;
          }

          // Load inventory and note for this encounter
          const invFile = `${inventoryDir}/enc-${id}.md`;
          const noteFile = `${notesDir}/enc-${id}.txt`;
          const inventory = await Bun.file(invFile).exists() ? await Bun.file(invFile).text() : "(no inventory)";
          const note = await Bun.file(noteFile).exists() ? await Bun.file(noteFile).text() : "";

          const userMessage = [
            `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
            `## Site Scaffold (reference these IDs — do NOT recreate)\n\`\`\`json\n${scaffold}\n\`\`\``,
            `## Resource Inventory\n\n${inventory}`,
            note ? `## Clinical Note\n\n${note}` : "",
            `\nGenerate FHIR R4 resources for this encounter. Reference scaffold IDs for Patient, Org, Practitioner, existing Conditions/Meds. Raw JSON array only.`,
          ].filter(Boolean).join("\n\n");

          const result = await callClaude({ systemPrompt: encounterPrompt, userMessage, model: "sonnet" });

          const jsonStr = (result.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? result).trim();
          let resources: any[];
          try {
            const parsed = JSON.parse(jsonStr);
            resources = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            const debugFile = `${siteDir}/enc-${id}-raw.txt`;
            await Bun.write(debugFile, result);
            throw new Error(`Failed to parse FHIR for enc-${id} at ${siteSlug} — raw saved to ${debugFile}`);
          }

          for (const resource of resources) {
            const rType = resource.resourceType;
            if (!rType) continue;
            resource.id = resource.id || crypto.randomUUID();
            const typeDir = `${siteDir}/resources/${rType}`;
            await mkdir(typeDir, { recursive: true });
            await Bun.write(`${typeDir}/${resource.id}.json`, JSON.stringify(resource, null, 2));
          }

          await Bun.write(doneMarker, new Date().toISOString());
          completed++;
          console.log(`[05] (${completed}/${totalEncounters}) ${siteSlug}/enc-${id} — ${resources.length} resources`);
        })
      );
    }
  }

  const results = await Promise.allSettled(tasks);
  const failures = results.filter(r => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`\n[05] ${failures.length} encounters failed:`);
    for (const f of failures) {
      if (f.status === "rejected") console.error(`  ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`\n[05] Done — all resources in ${sitesDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
