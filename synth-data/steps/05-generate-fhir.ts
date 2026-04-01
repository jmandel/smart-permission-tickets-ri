#!/usr/bin/env bun
/**
 * Step 05: Generate FHIR resources (reference scaffold + chronological encounters)
 *
 * Pass A: Per site, generate the reference scaffold (Patient, Organization,
 *         Practitioners, Locations) -> sites/<slug>/scaffold.json
 * Pass B: Per encounter, in chronological order within each site, generate
 *         encounter resources with:
 *           1. reference scaffold IDs
 *           2. prior resource index from earlier encounters at that site
 *           3. prior resource directory/manifests for agentic lookups
 */

import { resolve } from "path";
import { mkdir, readdir, rm } from "fs/promises";
import { PIPELINE_ROOT, callClaude, parseEncounters, encId } from "./lib.ts";

interface ParsedEncounter {
  index: number;
  heading: string;
  text: string;
}

interface ManifestEntry {
  resourceType: string;
  id: string;
  path: string;
}

interface ResourceFile {
  path: string;
  resource: any;
}

/** Parse the encounters file and group encounters by site */
function groupEncountersBySite(encountersText: string): Map<string, ParsedEncounter[]> {
  const sites = new Map<string, ParsedEncounter[]>();
  let currentSite = "default";

  const allEncounters = parseEncounters(encountersText);

  const lines = encountersText.split("\n");
  let encIdx = 0;
  for (const line of lines) {
    const siteMatch = line.match(/^## Site \d+[^:]*:\s*(.+)/);
    if (siteMatch) {
      currentSite = siteMatch[1]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+$/, "");
    }

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
  } catch {
    // Few-shots are optional in early setup.
  }
  return context;
}

function summarizeHumanName(name: any): string {
  const first = Array.isArray(name) ? name[0] : name;
  if (!first) return "";
  const given = Array.isArray(first.given) ? first.given.join(" ") : "";
  const family = typeof first.family === "string" ? first.family : "";
  return [given, family].filter(Boolean).join(" ") || first.text || "";
}

function summarizeCodeableConcept(value: any): string {
  if (!value) return "";
  if (typeof value.text === "string" && value.text.length > 0) return value.text;
  const coding = Array.isArray(value.coding) ? value.coding[0] : undefined;
  return coding?.display || coding?.code || "";
}

function summarizeMedication(resource: any): string {
  return resource.medicationReference?.display
    || summarizeCodeableConcept(resource.medicationCodeableConcept)
    || resource.medicationReference?.reference
    || "";
}

function summarizeResource(resource: any, filePath: string): string {
  const parts = [`${resource.resourceType}/${resource.id}`];

  switch (resource.resourceType) {
    case "Patient":
      parts.push(`name=${summarizeHumanName(resource.name)}`);
      if (resource.birthDate) parts.push(`birthDate=${resource.birthDate}`);
      break;
    case "Organization":
      if (resource.name) parts.push(`name=${resource.name}`);
      break;
    case "Practitioner":
      parts.push(`name=${summarizeHumanName(resource.name)}`);
      break;
    case "Location":
      if (resource.name) parts.push(`name=${resource.name}`);
      break;
    case "Condition":
      parts.push(`code=${summarizeCodeableConcept(resource.code)}`);
      parts.push(`clinicalStatus=${summarizeCodeableConcept(resource.clinicalStatus)}`);
      if (resource.onsetDateTime) parts.push(`onset=${resource.onsetDateTime}`);
      if (resource.abatementDateTime) parts.push(`abatement=${resource.abatementDateTime}`);
      break;
    case "MedicationRequest":
      parts.push(`medication=${summarizeMedication(resource)}`);
      if (resource.status) parts.push(`status=${resource.status}`);
      if (resource.authoredOn) parts.push(`authoredOn=${resource.authoredOn}`);
      break;
    case "AllergyIntolerance":
      parts.push(`substance=${summarizeCodeableConcept(resource.code)}`);
      if (resource.clinicalStatus) parts.push(`clinicalStatus=${summarizeCodeableConcept(resource.clinicalStatus)}`);
      break;
    case "Encounter":
      parts.push(`type=${summarizeCodeableConcept(resource.type?.[0])}`);
      if (resource.period?.start) parts.push(`start=${resource.period.start}`);
      break;
    case "Observation":
      parts.push(`code=${summarizeCodeableConcept(resource.code)}`);
      if (resource.status) parts.push(`status=${resource.status}`);
      if (resource.effectiveDateTime) parts.push(`effective=${resource.effectiveDateTime}`);
      break;
    case "DiagnosticReport":
      parts.push(`code=${summarizeCodeableConcept(resource.code)}`);
      if (resource.status) parts.push(`status=${resource.status}`);
      break;
    case "Procedure":
      parts.push(`code=${summarizeCodeableConcept(resource.code)}`);
      if (resource.status) parts.push(`status=${resource.status}`);
      break;
    case "Immunization":
      parts.push(`vaccine=${summarizeCodeableConcept(resource.vaccineCode)}`);
      if (resource.occurrenceDateTime) parts.push(`date=${resource.occurrenceDateTime}`);
      break;
    case "DocumentReference":
      parts.push(`type=${summarizeCodeableConcept(resource.type)}`);
      if (resource.date) parts.push(`date=${resource.date}`);
      break;
    default:
      break;
  }

  parts.push(`file=${filePath}`);
  return `- ${parts.join(" | ")}`;
}

async function loadManifestEntries(manifestFile: string): Promise<ManifestEntry[]> {
  try {
    const parsed = JSON.parse(await Bun.file(manifestFile).text());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadPriorResources(siteDir: string, encounters: ParsedEncounter[], currentIndex: number): Promise<ResourceFile[]> {
  const manifests: ManifestEntry[] = [];

  manifests.push(...await loadManifestEntries(`${siteDir}/scaffold-manifest.json`));

  for (const encounter of encounters) {
    if (encounter.index >= currentIndex) break;
    manifests.push(...await loadManifestEntries(`${siteDir}/encounter-manifests/enc-${encId(encounter.index)}.json`));
  }

  const uniqueByPath = new Map<string, ManifestEntry>();
  for (const entry of manifests) uniqueByPath.set(entry.path, entry);

  const resources: ResourceFile[] = [];
  for (const entry of [...uniqueByPath.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const filePath = `${siteDir}/${entry.path}`;
    try {
      const resource = JSON.parse(await Bun.file(filePath).text());
      resources.push({ path: filePath, resource });
    } catch {
      // Skip unreadable files; the encounter prompt still gets the directory path.
    }
  }

  return resources;
}

function buildPriorResourceIndex(resources: ResourceFile[]): string {
  if (resources.length === 0) return "(no prior resources yet for this site)";
  return resources
    .map(({ path, resource }) => summarizeResource(resource, path))
    .join("\n");
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

  console.log(`\n[05] === Pass A: Generating site reference scaffolds ===`);

  for (const [siteSlug, encounters] of siteEncounters) {
    const siteDir = `${sitesDir}/${siteSlug}`;
    const resourcesDir = `${siteDir}/resources`;
    const encounterManifestDir = `${siteDir}/encounter-manifests`;

    if (force) await rm(siteDir, { recursive: true, force: true });
    await mkdir(resourcesDir, { recursive: true });
    await mkdir(encounterManifestDir, { recursive: true });

    const scaffoldFile = `${siteDir}/scaffold.json`;
    if (!force && await Bun.file(scaffoldFile).exists()) {
      console.log(`[05] Scaffold exists for ${siteSlug} — skipping`);
      continue;
    }

    const siteEncText = encounters.map(e => e.text).join("\n\n");

    const userMessage = [
      `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
      `## Patient Biography\n\n${biography}`,
      `## Encounters at This Site\n\n${siteEncText}`,
      `\nGenerate the reference scaffold resources for this site. Raw JSON array only.`,
    ].join("\n\n");

    console.log(`[05] Generating scaffold for ${siteSlug} (${encounters.length} encounters)...`);
    const result = await callClaude({ systemPrompt: scaffoldPrompt, userMessage, model: "sonnet" });

    const jsonStr = (result.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? result).trim();
    let resources: any[];
    try {
      const parsed = JSON.parse(jsonStr);
      resources = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      await Bun.write(`${siteDir}/scaffold-raw.txt`, result);
      throw new Error(`Failed to parse scaffold JSON for ${siteSlug} — raw output saved`);
    }

    const manifestEntries: ManifestEntry[] = [];
    for (const resource of resources) {
      const resourceType = resource.resourceType;
      if (!resourceType) continue;
      resource.id = resource.id || crypto.randomUUID();
      const relPath = `resources/${resourceType}/${resource.id}.json`;
      await mkdir(`${siteDir}/resources/${resourceType}`, { recursive: true });
      await Bun.write(`${siteDir}/${relPath}`, JSON.stringify(resource, null, 2));
      manifestEntries.push({ resourceType, id: resource.id, path: relPath });
    }

    await Bun.write(scaffoldFile, JSON.stringify(resources, null, 2));
    await Bun.write(`${siteDir}/scaffold-manifest.json`, JSON.stringify(manifestEntries, null, 2));
    console.log(`[05] Scaffold for ${siteSlug}: ${manifestEntries.length} resources`);
  }

  console.log(`\n[05] === Pass B: Generating per-encounter resources ===`);

  const totalEncounters = [...siteEncounters.values()].reduce((sum, encounters) => sum + encounters.length, 0);
  let completed = 0;

  for (const [siteSlug, encounters] of siteEncounters) {
    const siteDir = `${sitesDir}/${siteSlug}`;
    const scaffoldFile = `${siteDir}/scaffold.json`;
    const resourcesDir = `${siteDir}/resources`;
    const encounterManifestDir = `${siteDir}/encounter-manifests`;

    const scaffold = await Bun.file(scaffoldFile).exists()
      ? await Bun.file(scaffoldFile).text()
      : "[]";

    for (const encounter of encounters) {
      const encounterId = encId(encounter.index);
      const doneMarker = `${siteDir}/.done-${encounterId}`;
      if (!force && await Bun.file(doneMarker).exists()) {
        completed++;
        console.log(`[05] (${completed}/${totalEncounters}) ${siteSlug}/enc-${encounterId} — skipped`);
        continue;
      }

      const inventoryFile = `${inventoryDir}/enc-${encounterId}.md`;
      const noteFile = `${notesDir}/enc-${encounterId}.txt`;
      const inventory = await Bun.file(inventoryFile).exists()
        ? await Bun.file(inventoryFile).text()
        : "(no inventory)";
      const note = await Bun.file(noteFile).exists()
        ? await Bun.file(noteFile).text()
        : "";

      const priorResources = await loadPriorResources(siteDir, encounters, encounter.index);
      const priorResourceIndex = buildPriorResourceIndex(priorResources);

      const userMessage = [
        `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
        `## Site Reference Scaffold\n\`\`\`json\n${scaffold}\n\`\`\``,
        `## Prior Resource Index (same site, earlier scaffold/resources only)\n${priorResourceIndex}`,
        `## Prior Resource Files\n- Resource directory: ${resourcesDir}\n- Scaffold manifest: ${siteDir}/scaffold-manifest.json\n- Earlier encounter manifests: ${encounterManifestDir}`,
        `## Resource Inventory\n\n${inventory}`,
        note ? `## Clinical Note\n\n${note}` : "",
        `\nGenerate FHIR R4 resources for this encounter. Reuse or update prior clinical resource IDs when appropriate. Raw JSON array only.`,
      ].filter(Boolean).join("\n\n");

      const result = await callClaude({ systemPrompt: encounterPrompt, userMessage, model: "sonnet" });

      const jsonStr = (result.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? result).trim();
      let resources: any[];
      try {
        const parsed = JSON.parse(jsonStr);
        resources = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        const debugFile = `${siteDir}/enc-${encounterId}-raw.txt`;
        await Bun.write(debugFile, result);
        throw new Error(`Failed to parse FHIR for enc-${encounterId} at ${siteSlug} — raw saved to ${debugFile}`);
      }

      const manifestEntries: ManifestEntry[] = [];
      for (const resource of resources) {
        const resourceType = resource.resourceType;
        if (!resourceType) continue;
        resource.id = resource.id || crypto.randomUUID();
        const relPath = `resources/${resourceType}/${resource.id}.json`;
        await mkdir(`${siteDir}/resources/${resourceType}`, { recursive: true });
        await Bun.write(`${siteDir}/${relPath}`, JSON.stringify(resource, null, 2));
        manifestEntries.push({ resourceType, id: resource.id, path: relPath });
      }

      await Bun.write(`${encounterManifestDir}/enc-${encounterId}.json`, JSON.stringify(manifestEntries, null, 2));
      await Bun.write(doneMarker, new Date().toISOString());

      completed++;
      console.log(
        `[05] (${completed}/${totalEncounters}) ${siteSlug}/enc-${encounterId} — `
        + `${manifestEntries.length} resources, ${priorResources.length} prior in context`
      );
    }
  }

  console.log(`\n[05] Done — all resources in ${sitesDir}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
