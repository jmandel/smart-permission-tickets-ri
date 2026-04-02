#!/usr/bin/env bun
/**
 * apply-labels: Apply security labels from a classification JSON to FHIR resources.
 *
 * Usage: bun run steps/apply-labels.ts patients/<slug>/security-labels.json
 *
 * The classification JSON has:
 *   encounters: { "enc-001": ["SEX"], ... }
 *   resource_overrides: [{ encounter_prefix, id_substring, labels, rationale }]
 *
 * For each encounter classification, labels are applied to all resources whose
 * ID starts with that encounter prefix (e.g., enc-001-*). Scaffold resources
 * (Patient, Organization, Practitioner, Location) are never labeled.
 */

import { readdir } from "fs/promises";
import { resolve, dirname } from "path";

const LABELS: Record<string, string> = {
  SEX: "sexuality and reproductive health information sensitivity",
  HIV: "HIV/AIDS information sensitivity",
  ETH: "substance abuse information sensitivity",
  MH: "mental health information sensitivity",
  BH: "behavioral health information sensitivity",
  PSY: "psychiatry disorder information sensitivity",
  SUD: "substance use disorder information sensitivity",
  STD: "sexually transmitted disease information sensitivity",
  GDIS: "genetic disease information sensitivity",
  SDV: "sexual assault, abuse, or domestic violence information sensitivity",
};

const SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const SCAFFOLD_TYPES = new Set(["Patient", "Organization", "Practitioner", "Location"]);

interface Classification {
  encounters: Record<string, string[]>;
  resource_overrides: Array<{
    encounter_prefix: string;
    id_substring: string;
    labels: string[];
    rationale: string;
  }>;
  rationale: Record<string, string>;
}

// ── Parse args ──────────────────────────────────────────────────────────

const classificationPath = resolve(process.argv[2] ?? "");
if (!classificationPath.endsWith(".json") || !(await Bun.file(classificationPath).exists())) {
  console.error("Usage: bun run steps/apply-labels.ts patients/<slug>/security-labels.json");
  process.exit(1);
}

const patientDir = dirname(classificationPath);
const classification: Classification = JSON.parse(await Bun.file(classificationPath).text());

// ── Collect all resource files ──────────────────────────────────────────

interface ResourceFile {
  path: string;
  resourceType: string;
  id: string;
}

const resourceFiles: ResourceFile[] = [];
const sitesRoot = `${patientDir}/sites`;

for (const site of (await readdir(sitesRoot)).sort()) {
  const resourcesDir = `${sitesRoot}/${site}/resources`;
  let typeDirs: string[];
  try { typeDirs = await readdir(resourcesDir); } catch { continue; }

  for (const typeDir of typeDirs) {
    if (SCAFFOLD_TYPES.has(typeDir)) continue;

    const typePath = `${resourcesDir}/${typeDir}`;
    let files: string[];
    try { files = (await readdir(typePath)).filter(f => f.endsWith(".json")); } catch { continue; }

    for (const file of files) {
      const fullPath = `${typePath}/${file}`;
      try {
        const r = JSON.parse(await Bun.file(fullPath).text());
        resourceFiles.push({ path: fullPath, resourceType: r.resourceType, id: r.id });
      } catch { /* skip parse errors */ }
    }
  }
}

// ── Apply encounter-level labels ────────────────────────────────────────

let applied = 0;

async function addLabel(filePath: string, code: string): Promise<boolean> {
  const display = LABELS[code];
  if (!display) {
    console.error(`  Unknown label code: ${code}`);
    return false;
  }

  const resource = JSON.parse(await Bun.file(filePath).text());
  if (!resource.meta) resource.meta = {};
  if (!Array.isArray(resource.meta.security)) resource.meta.security = [];

  if (resource.meta.security.some((s: any) => s.system === SYSTEM && s.code === code)) {
    return false; // already has it
  }

  resource.meta.security.push({ system: SYSTEM, code, display });
  await Bun.write(filePath, JSON.stringify(resource, null, 2) + "\n");
  return true;
}

// For each classified encounter, find matching resources
for (const [encId, labels] of Object.entries(classification.encounters)) {
  const prefix = encId; // e.g., "enc-001"
  const matching = resourceFiles.filter(r => r.id === prefix || r.id.startsWith(`${prefix}-`));

  if (matching.length === 0) {
    console.warn(`  No resources found for encounter ${encId}`);
    continue;
  }

  for (const rf of matching) {
    for (const label of labels) {
      if (await addLabel(rf.path, label)) {
        applied++;
        console.log(`[apply] ${rf.id} ← ${label}`);
      }
    }
  }
}

// ── Apply resource-level overrides ──────────────────────────────────────

for (const override of classification.resource_overrides ?? []) {
  const matching = resourceFiles.filter(
    r => r.id.startsWith(override.encounter_prefix) && r.id.includes(override.id_substring)
  );

  if (matching.length === 0) {
    console.warn(`  No resources found matching ${override.encounter_prefix}/*${override.id_substring}*`);
    continue;
  }

  for (const rf of matching) {
    for (const label of override.labels) {
      if (await addLabel(rf.path, label)) {
        applied++;
        console.log(`[override] ${rf.id} ← ${label} (${override.rationale})`);
      }
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\nApplied ${applied} labels to resources in ${patientDir}`);

// Write a human-readable report
const reportLines: string[] = [
  `# Security Labels Report`,
  ``,
  `## Encounter Classifications`,
  ``,
  `| Encounter | Labels | Rationale |`,
  `|---|---|---|`,
];

for (const [encId, labels] of Object.entries(classification.encounters)) {
  const rationale = classification.rationale?.[encId] ?? "";
  reportLines.push(`| ${encId} | ${labels.join(", ")} | ${rationale} |`);
}

if (classification.resource_overrides?.length) {
  reportLines.push(``, `## Resource Overrides`, ``, `| Pattern | Labels | Rationale |`, `|---|---|---|`);
  for (const o of classification.resource_overrides) {
    reportLines.push(`| ${o.encounter_prefix}/*${o.id_substring}* | ${o.labels.join(", ")} | ${o.rationale} |`);
  }
}

// Count labeled resources by label
const labelCounts: Record<string, number> = {};
for (const rf of resourceFiles) {
  try {
    const r = JSON.parse(await Bun.file(rf.path).text());
    for (const s of r.meta?.security ?? []) {
      if (s.system === SYSTEM) {
        labelCounts[s.code] = (labelCounts[s.code] ?? 0) + 1;
      }
    }
  } catch { /* skip */ }
}

reportLines.push(``, `## Summary`, ``);
for (const [code, count] of Object.entries(labelCounts).sort()) {
  reportLines.push(`- **${code}**: ${count} resources`);
}
reportLines.push(`- **Total labels applied this run**: ${applied}`);

await Bun.write(`${patientDir}/security-labels-report.md`, reportLines.join("\n") + "\n");
console.log(`Report: ${patientDir}/security-labels-report.md`);
