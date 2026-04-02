#!/usr/bin/env bun
/**
 * Step 04: Generate per-encounter resource inventories (fan-out)
 *
 * Input:  patients/<slug>/biography.md, patients/<slug>/provider-map.json, patients/<slug>/encounters.json,
 *         patients/<slug>/notes/enc-NNN.txt (clinical notes from step 03)
 * Output: patients/<slug>/inventories/enc-NNN.md + enc-NNN.json (one pair per encounter)
 *
 * Reads the clinical note for each encounter so the resource inventory
 * is consistent with the narrative. Fans out with concurrency control.
 */

import { resolve } from "path";
import { mkdir } from "fs/promises";
import { PIPELINE_ROOT, callClaude, createLimiter, encId } from "./lib.ts";
import {
  generateJsonArtifact,
  loadEncounterTimeline,
  loadProviderMap,
  normalizeInventorySidecar,
} from "./artifacts.ts";

function parseConcurrency(argv = process.argv, fallback = 3): number {
  const idx = argv.indexOf("--concurrency");
  if (idx >= 0 && argv[idx + 1]) return Math.max(1, parseInt(argv[idx + 1], 10) || fallback);
  return fallback;
}

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");
  const MAX_CONCURRENCY = parseConcurrency();

  const encountersFile = `${patientDir}/encounters.json`;
  const bioFile = `${patientDir}/biography.md`;
  const providerMapFile = `${patientDir}/provider-map.json`;
  if (!patientDir || !await Bun.file(encountersFile).exists() || !await Bun.file(bioFile).exists() || !await Bun.file(providerMapFile).exists()) {
    console.error("Usage: bun run steps/04-inventory.ts <patient-dir>");
    console.error("  <patient-dir> must contain biography.md + provider-map.json + encounters.json (run steps 01-02 first)");
    process.exit(1);
  }

  const inventoryDir = `${patientDir}/inventories`;
  const notesDir = `${patientDir}/notes`;
  await mkdir(inventoryDir, { recursive: true });

  const biography = await Bun.file(bioFile).text();
  const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/inventory.md`).text();
  const sidecarPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/inventory-json.md`).text();

  const providerMap = await loadProviderMap(providerMapFile);
  const encounters = (await loadEncounterTimeline(encountersFile, providerMap)).encounters;
  console.log(`[04] Found ${encounters.length} encounters to inventory`);

  if (encounters.length === 0) {
    console.error(`[04] No encounters parsed — expected ### headers with dates`);
    process.exit(1);
  }

  const limit = createLimiter(MAX_CONCURRENCY);
  let completed = 0;

  const results = await Promise.allSettled(
    encounters.map(enc =>
      limit(async () => {
        const id = encId(enc.encounter_index);
        const outFile = `${inventoryDir}/enc-${id}.md`;
        const jsonFile = `${inventoryDir}/enc-${id}.json`;
        const markdownExists = await Bun.file(outFile).exists();
        const jsonExists = await Bun.file(jsonFile).exists();
        if (!force && markdownExists && jsonExists) {
          completed++;
          return;
        }

        const noteFile = `${notesDir}/enc-${id}.txt`;
        let noteContext = "";
        if (await Bun.file(noteFile).exists()) {
          const noteText = await Bun.file(noteFile).text();
          noteContext = `\n\n## Clinical Note for This Encounter\n\n${noteText}\n\nThe resource inventory below MUST be consistent with this clinical note. Every vital sign, lab value, diagnosis, and medication mentioned in the note should have a corresponding FHIR resource.`;
        }

        let markdown = markdownExists ? await Bun.file(outFile).text() : "";
        if (force || !markdownExists) {
          markdown = await callClaude({
            systemPrompt,
            userMessage: [
              `## Encounter Contract\n\`\`\`json\n${JSON.stringify(enc, null, 2)}\n\`\`\``,
              `## This Encounter Narrative\n\n### ${enc.header}\n\n${enc.body_markdown}${noteContext}`,
              `## Patient Background\n\n${biography}`,
            ].join("\n\n"),
          });

          await Bun.write(outFile, markdown);
        }

        if (force || !jsonExists) {
          const sidecarRaw = await generateJsonArtifact({
            systemPrompt: sidecarPrompt,
            userMessage: [
              `## Encounter Contract\n\`\`\`json\n${JSON.stringify(enc, null, 2)}\n\`\`\``,
              `## Inventory Markdown\n\n${markdown}`,
              noteContext ? `## Clinical Note\n\n${noteContext.replace(/^\n+/, "")}` : "",
            ].filter(Boolean).join("\n\n"),
            repairLabel: `inventory JSON for ${enc.encounter_id}`,
          });
          const inventorySidecar = normalizeInventorySidecar(sidecarRaw, enc);
          await Bun.write(jsonFile, JSON.stringify(inventorySidecar, null, 2));
        }

        completed++;
        console.log(`[04] (${completed}/${encounters.length}) enc-${id} — ${enc.header}`);
      })
    )
  );

  const failures = results.filter(r => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`[04] ${failures.length} encounters failed:`);
    for (const f of failures) {
      if (f.status === "rejected") console.error(`  ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`[04] Done — ${encounters.length} inventories in ${inventoryDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
