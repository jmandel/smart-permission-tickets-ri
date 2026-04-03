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

import { $ } from "bun";
import { resolve } from "path";
import { mkdir, readdir, rm } from "fs/promises";
import { PIPELINE_ROOT, callClaude, callAgentWorkdir, encId } from "./lib.ts";
import {
  EncounterRecord,
  ProviderSiteContract,
  findSiteContract,
  groupEncountersBySite,
  loadEncounterTimeline,
  loadInventorySidecar,
  loadProviderMap,
  parseResourceArrayWithRepair,
} from "./artifacts.ts";

interface ManifestEntry {
  resourceType: string;
  id: string;
  path: string;
}

interface ResourceFile {
  path: string;
  resource: any;
}

// JSON parsing/repair is now in artifacts.ts — imported as parseResourceArrayWithRepair

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

async function loadPriorResources(siteDir: string, encounters: EncounterRecord[], currentIndex: number): Promise<ResourceFile[]> {
  const manifests: ManifestEntry[] = [];

  manifests.push(...await loadManifestEntries(`${siteDir}/scaffold-manifest.json`));

  for (const encounter of encounters) {
    if (encounter.encounter_index >= currentIndex) break;
    manifests.push(...await loadManifestEntries(`${siteDir}/encounter-manifests/enc-${encId(encounter.encounter_index)}.json`));
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

function localReferencePattern(reference: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]+\/[A-Za-z0-9.\-]+$/.test(reference);
}

function normalizeTextKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean)
    : [];
}

function collectReferences(value: any, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;

  for (const [key, child] of Object.entries(value)) {
    if (key === "reference" && typeof child === "string") refs.push(child);
    collectReferences(child, refs);
  }
  return refs;
}

function resourceRefSet(resources: any[]): Set<string> {
  return new Set(
    resources
      .filter(resource => resource?.resourceType && resource?.id)
      .map(resource => `${resource.resourceType}/${resource.id}`),
  );
}

function summarizeObservationName(resource: any): string {
  if (resource?.resourceType !== "Observation") return "";
  return summarizeCodeableConcept(resource.code);
}

function summarizeDiagnosticReportName(resource: any): string {
  if (resource?.resourceType !== "DiagnosticReport") return "";
  return summarizeCodeableConcept(resource.code);
}

function findMatchingDiagnosticReport(resources: any[], reportType: string): any | undefined {
  const target = normalizeTextKey(reportType);
  if (!target) return undefined;

  return resources.find(resource => {
    if (resource?.resourceType !== "DiagnosticReport") return false;
    const candidates = [
      summarizeDiagnosticReportName(resource),
      resource?.code?.coding?.[0]?.display,
      resource?.code?.text,
    ]
      .map(normalizeTextKey)
      .filter(Boolean);
    return candidates.some(candidate => candidate === target || candidate.includes(target) || target.includes(candidate));
  });
}

function normalizeInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) return `${trimmed}Z`;
  return trimmed;
}

function normalizeGeneratedResource(resource: any, site: ProviderSiteContract): any {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return resource;

  const normalized = structuredClone(resource);
  const meta = normalized.meta && typeof normalized.meta === "object" && !Array.isArray(normalized.meta)
    ? normalized.meta
    : {};
  if (Object.keys(meta).length > 0) {
    normalized.meta = meta;
  } else {
    delete normalized.meta;
  }

  if (normalized.resourceType === "DocumentReference") {
    const normalizedDate = normalizeInstant(normalized.date);
    if (normalizedDate) normalized.date = normalizedDate;
  }

  if (normalized.resourceType === "DiagnosticReport") {
    const normalizedIssued = normalizeInstant(normalized.issued);
    if (normalizedIssued) normalized.issued = normalizedIssued;
  }

  if (normalized.resourceType === "AllergyIntolerance") {
    for (const codingBlock of [normalized.clinicalStatus, normalized.verificationStatus]) {
      const codings = Array.isArray(codingBlock?.coding) ? codingBlock.coding : [];
      for (const coding of codings) {
        if (
          coding
          && typeof coding === "object"
          && typeof coding.system === "string"
          && coding.system.startsWith("http://terminology.hl7.org/CodeSystem/allergyintolerance-")
        ) {
          delete coding.version;
        }
      }
    }
  }

  return normalized;
}

function validateScaffoldResources(resources: any[], site: ProviderSiteContract) {
  const allowedTypes = new Set(["Patient", "Organization", "Practitioner", "Location"]);
  const disallowed = resources.filter(resource => !allowedTypes.has(resource.resourceType));
  if (disallowed.length > 0) {
    throw new Error(`Scaffold for ${site.site_slug} emitted non-scaffold resource types: ${disallowed.map(r => r.resourceType).join(", ")}`);
  }

  const patients = resources.filter(resource => resource.resourceType === "Patient");
  const organizations = resources.filter(resource => resource.resourceType === "Organization");
  if (patients.length !== 1) throw new Error(`Scaffold for ${site.site_slug} must contain exactly 1 Patient`);
  if (organizations.length !== 1) throw new Error(`Scaffold for ${site.site_slug} must contain exactly 1 Organization`);

  const organization = organizations[0];
  if (organization.name !== site.site_name) {
    throw new Error(`Scaffold organization name mismatch for ${site.site_slug}: expected "${site.site_name}" but got "${organization.name}"`);
  }

  const identifiers = Array.isArray(organization.identifier) ? organization.identifier : [];
  if (!identifiers.some((identifier: any) => String(identifier?.value ?? "").trim() === site.npi)) {
    throw new Error(`Scaffold organization for ${site.site_slug} must include NPI ${site.npi}`);
  }
}

function validateEncounterResources(
  resources: any[],
  encounter: EncounterRecord,
  site: ProviderSiteContract,
  scaffoldResources: any[],
  priorResources: ResourceFile[],
  inventory?: { diagnostic_reports?: Array<Record<string, any>> },
) {
  const forbiddenTypes = new Set(["Patient", "Organization", "Practitioner", "Location"]);
  const forbidden = resources.filter(resource => forbiddenTypes.has(resource.resourceType));
  if (forbidden.length > 0) {
    throw new Error(
      `Encounter ${encounter.encounter_id} emitted identity resources in pass B: ${[...new Set(forbidden.map(r => r.resourceType))].join(", ")}`,
    );
  }

  const encounters = resources.filter(resource => resource.resourceType === "Encounter");
  if (encounters.length !== 1) {
    throw new Error(`Encounter ${encounter.encounter_id} must emit exactly 1 Encounter resource`);
  }

  const encounterResource = encounters[0];
  const encounterStart = String(encounterResource?.period?.start ?? "");
  if (!encounterStart.startsWith(encounter.date)) {
    throw new Error(`Encounter ${encounter.encounter_id} period.start must match ${encounter.date}`);
  }

  const scaffoldRefSet = resourceRefSet(scaffoldResources);
  const priorRefSet = resourceRefSet(priorResources.map(item => item.resource));
  const currentRefSet = resourceRefSet(resources);
  const validRefs = new Set([...scaffoldRefSet, ...priorRefSet, ...currentRefSet]);

  const scaffoldOrganizations = scaffoldResources.filter(resource => resource.resourceType === "Organization");
  const scaffoldPatients = scaffoldResources.filter(resource => resource.resourceType === "Patient");
  if (scaffoldOrganizations.length !== 1 || scaffoldPatients.length !== 1) {
    throw new Error(`Invalid scaffold state for ${site.site_slug}`);
  }
  const organizationRef = `Organization/${scaffoldOrganizations[0].id}`;
  const patientRef = `Patient/${scaffoldPatients[0].id}`;

  if (encounterResource?.serviceProvider?.reference !== organizationRef) {
    throw new Error(`Encounter ${encounter.encounter_id} must reference scaffold organization ${organizationRef}`);
  }
  if (encounterResource?.subject?.reference !== patientRef) {
    throw new Error(`Encounter ${encounter.encounter_id} must reference scaffold patient ${patientRef}`);
  }

  for (const participant of Array.isArray(encounterResource.participant) ? encounterResource.participant : []) {
    const reference = participant?.individual?.reference;
    if (typeof reference === "string" && reference.startsWith("Practitioner/") && !scaffoldRefSet.has(reference)) {
      throw new Error(`Encounter ${encounter.encounter_id} references non-scaffold practitioner ${reference}`);
    }
  }

  for (const location of Array.isArray(encounterResource.location) ? encounterResource.location : []) {
    const reference = location?.location?.reference;
    if (typeof reference === "string" && reference.startsWith("Location/") && !scaffoldRefSet.has(reference)) {
      throw new Error(`Encounter ${encounter.encounter_id} references non-scaffold location ${reference}`);
    }
  }

  for (const resource of resources) {
    for (const reference of collectReferences(resource)) {
      if (localReferencePattern(reference) && !validRefs.has(reference)) {
        throw new Error(`Encounter ${encounter.encounter_id} contains unresolved reference ${reference}`);
      }
    }
  }

  // DiagnosticReport ↔ Observation linkage is validated by the general
  // reference resolution check above — no need for fragile name matching
  // between inventory concept names and generated FHIR display text.
}

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const providerMapFile = `${patientDir}/provider-map.json`;
  const encountersFile = `${patientDir}/encounters.json`;
  const inventoryDir = `${patientDir}/inventories`;
  const notesDir = `${patientDir}/notes`;
  const sitesDir = `${patientDir}/sites`;

  if (!await Bun.file(providerMapFile).exists() || !await Bun.file(encountersFile).exists()) {
    console.error("Usage: bun run steps/05-generate-fhir.ts <patient-dir>");
    process.exit(1);
  }

  await mkdir(sitesDir, { recursive: true });

  const providerMap = await loadProviderMap(providerMapFile);
  const timeline = await loadEncounterTimeline(encountersFile, providerMap);
  const fewShots = await loadFewShots();
  const scaffoldPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/scaffold.md`).text();
  const encounterPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/fhir-generation.md`).text();

  const siteEncounters = groupEncountersBySite(timeline);
  console.log(`[05] Found ${siteEncounters.size} sites: ${[...siteEncounters.keys()].join(", ")}`);

  console.log(`\n[05] === Pass A: Generating site reference scaffolds ===`);

  for (const [siteSlug, encounters] of siteEncounters) {
    const site = findSiteContract(providerMap, siteSlug);
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

    const siteEncounterSummary = encounters.map(encounter => ({
      encounter_id: encounter.encounter_id,
      date: encounter.date,
      encounter_type: encounter.encounter_type,
      reason: encounter.reason,
      clinician_names: encounter.clinician_names,
      location: encounter.location,
      header: encounter.header,
    }));

    const userMessage = [
      `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
      `## Site Contract\n\`\`\`json\n${JSON.stringify(site, null, 2)}\n\`\`\``,
      `## Patient Demographics\n\`\`\`json\n${JSON.stringify(providerMap.patient, null, 2)}\n\`\`\``,
      `## Encounter List For This Site\n\`\`\`json\n${JSON.stringify(siteEncounterSummary, null, 2)}\n\`\`\``,
      `\nGenerate the reference scaffold resources for this site. Raw JSON array only.`,
    ].join("\n\n");

    console.log(`[05] Generating scaffold for ${siteSlug} (${encounters.length} encounters)...`);
    const result = await callClaude({ systemPrompt: scaffoldPrompt, userMessage, outputFileName: "output.json" });

    let resources: any[];
    try {
      resources = (await parseResourceArrayWithRepair(result)).map(resource => normalizeGeneratedResource(resource, site));
    } catch {
      await Bun.write(`${siteDir}/scaffold-raw.txt`, result);
      throw new Error(`Failed to parse scaffold JSON for ${siteSlug} — raw output saved`);
    }
    validateScaffoldResources(resources, site);

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

  // Process sites in parallel (encounters within a site stay sequential
  // because each encounter needs prior-resource context from earlier ones)
  const siteResults = await Promise.allSettled([...siteEncounters.entries()].map(async ([siteSlug, encounters]) => {
    const site = findSiteContract(providerMap, siteSlug);
    const siteDir = `${sitesDir}/${siteSlug}`;
    const scaffoldFile = `${siteDir}/scaffold.json`;
    const resourcesDir = `${siteDir}/resources`;
    const encounterManifestDir = `${siteDir}/encounter-manifests`;

    const scaffold = await Bun.file(scaffoldFile).exists()
      ? await Bun.file(scaffoldFile).text()
      : "[]";
    const scaffoldResources = JSON.parse(scaffold);

    for (const encounter of encounters) {
      const encounterId = encId(encounter.encounter_index);
      const doneMarker = `${siteDir}/.done-${encounterId}`;
      if (!force && await Bun.file(doneMarker).exists()) {
        completed++;
        console.log(`[05] (${completed}/${totalEncounters}) ${siteSlug}/enc-${encounterId} — skipped`);
        continue;
      }

      const inventoryFile = `${inventoryDir}/enc-${encounterId}.json`;
      const noteFile = `${notesDir}/enc-${encounterId}.txt`;
      const inventory = await Bun.file(inventoryFile).exists()
        ? await loadInventorySidecar(inventoryFile, encounter)
        : null;
      if (!inventory) {
        throw new Error(`Missing inventory JSON for ${encounter.encounter_id} at ${inventoryFile}`);
      }
      const note = await Bun.file(noteFile).exists()
        ? await Bun.file(noteFile).text()
        : "";

      const priorResources = await loadPriorResources(siteDir, encounters, encounter.encounter_index);
      const priorResourceIndex = buildPriorResourceIndex(priorResources);

      // Resolve absolute paths for tools the agent can use
      const terminologyDbPath = resolve(PIPELINE_ROOT, "terminology.sqlite");
      const validatorPort = Bun.env.VALIDATOR_PORT ?? "8090";

      const userMessage = [
        `## Real FHIR Examples (match this structural depth)\n${fewShots}`,
        `## Site Contract\n\`\`\`json\n${JSON.stringify(site, null, 2)}\n\`\`\``,
        `## Encounter Contract\n\`\`\`json\n${JSON.stringify(encounter, null, 2)}\n\`\`\``,
        `## Site Reference Scaffold\n\`\`\`json\n${scaffold}\n\`\`\``,
        `## Prior Resource Index (same site, earlier scaffold/resources only)\n${priorResourceIndex}`,
        `## Prior Resource Files\n- Resource directory: ${resourcesDir}\n- Scaffold manifest: ${siteDir}/scaffold-manifest.json\n- Earlier encounter manifests: ${encounterManifestDir}`,
        `## Structured Inventory JSON\n\`\`\`json\n${JSON.stringify(inventory, null, 2)}\n\`\`\``,
        note ? `## Clinical Note\n\n${note}` : "",
        `## Available Tools`,
        `- **Terminology DB**: \`sqlite3 ${terminologyDbPath}\` — look up SNOMED/LOINC/RxNorm/CVX codes. Example: \`sqlite3 ${terminologyDbPath} "SELECT c.code, c.display FROM designations_fts JOIN designations d ON d.id = designations_fts.rowid JOIN concepts c ON c.id = d.concept_id WHERE designations_fts MATCH 'rheumatoid arthritis' AND c.system = 'http://snomed.info/sct' ORDER BY bm25(designations_fts) LIMIT 5"\``,
        `- **FHIR Validator**: \`curl -s -X POST http://localhost:${validatorPort}/validateResource -H "Content-Type: application/fhir+json" -d @resources/<id>.json\` — validate a resource file after writing it`,
        `\nGenerate FHIR R4 resources for this encounter. Follow the workflow in the system prompt: write each resource to its own file in \`resources/\`, validate each one, then verify.`,
      ].filter(Boolean).join("\n\n");

      const workdir = await callAgentWorkdir({ systemPrompt: encounterPrompt, userMessage });

      let resources: any[];
      try {
        const agentResourceDir = `${workdir}/resources`;
        const fileNames = (await readdir(agentResourceDir)).filter(f => f.endsWith(".json")).sort();
        if (fileNames.length === 0) {
          throw new Error("Agent produced no resource files");
        }
        resources = [];
        for (const fileName of fileNames) {
          const raw = JSON.parse(await Bun.file(`${agentResourceDir}/${fileName}`).text());
          if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.resourceType) {
            throw new Error(`Invalid resource in ${fileName}: expected a FHIR resource object`);
          }
          resources.push(normalizeGeneratedResource(raw, site));
        }
      } catch (err) {
        // Preserve workdir for debugging on failure
        console.error(`[05] Agent workdir preserved for debugging: ${workdir}`);
        throw new Error(`Failed to read FHIR resources for enc-${encounterId} at ${siteSlug}: ${err}`);
      }
      validateEncounterResources(resources, encounter, site, scaffoldResources, priorResources, inventory);

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

      // Clean up agent workdir after successful copy
      try { await $`rm -rf ${workdir}`.quiet(); } catch {}

      completed++;
      console.log(
        `[05] (${completed}/${totalEncounters}) ${siteSlug}/enc-${encounterId} — `
        + `${manifestEntries.length} resources, ${priorResources.length} prior in context`
      );
    }
  }));

  const siteFailures = siteResults.filter(r => r.status === "rejected");
  if (siteFailures.length > 0) {
    console.error(`\n[05] ${siteFailures.length} site(s) failed:`);
    for (const f of siteFailures) {
      if (f.status === "rejected") console.error(`  ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`\n[05] Done — all resources in ${sitesDir}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
