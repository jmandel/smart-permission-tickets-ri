#!/usr/bin/env bun
/**
 * Step 07: Classify encounters by clinical sensitivity, then apply labels.
 *
 * Phase 1 (LLM): Agent reads scenario + inventories + resource ID list,
 *   outputs a classification JSON, then runs check-labels to validate it.
 * Phase 2 (code): apply-labels.ts reads the classification and stamps
 *   meta.security on all matching FHIR resources.
 *
 * Output: patients/{slug}/security-labels.json  (classification)
 *         patients/{slug}/security-labels-report.md (human-readable report)
 */

import { resolve } from "path";
import { readdir } from "fs/promises";
import { $ } from "bun";
import { callAgent, PIPELINE_ROOT } from "./lib";

const SCAFFOLD_TYPES = new Set(["Patient", "Organization", "Practitioner", "Location"]);

const patientDir = resolve(process.argv[2] ?? "");
if (!patientDir || !(await Bun.file(`${patientDir}/scenario.md`).exists())) {
  console.error("Usage: bun run steps/07-security-labels.ts patients/<slug>/");
  process.exit(1);
}

const slug = patientDir.split("/").pop()!;
const classificationPath = `${patientDir}/security-labels.json`;

// Check if already done
if (await Bun.file(classificationPath).exists() && !process.argv.includes("--force")) {
  console.log(`[07] ${slug}: security-labels.json already exists, skipping (use --force to redo)`);
  process.exit(0);
}

// Strip any existing labels first
console.log(`[07] ${slug}: Stripping any existing labels...`);
await $`bun run ${PIPELINE_ROOT}/steps/strip-labels.ts ${patientDir}`.quiet();

console.log(`[07] ${slug}: Classifying encounters for security labels...`);

// ── Gather context ──────────────────────────────────────────────────────

const scenario = await Bun.file(`${patientDir}/scenario.md`).text();

const invDir = `${patientDir}/inventories`;
const invFiles = (await readdir(invDir)).filter(f => f.endsWith(".json")).sort();
const inventories: string[] = [];
for (const f of invFiles) {
  const content = await Bun.file(`${invDir}/${f}`).text();
  inventories.push(`### ${f}\n\`\`\`json\n${content}\n\`\`\``);
}

// Build resource ID listing grouped by encounter prefix
const resourceIdsByEnc: Record<string, string[]> = {};
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
      try {
        const r = JSON.parse(await Bun.file(`${typePath}/${file}`).text());
        if (!r.id) continue;
        // Group by encounter prefix (enc-NNN)
        const encMatch = r.id.match(/^(enc-\d+)/);
        const prefix = encMatch ? encMatch[1] : "_scaffold";
        if (!resourceIdsByEnc[prefix]) resourceIdsByEnc[prefix] = [];
        resourceIdsByEnc[prefix].push(`${r.id} (${r.resourceType})`);
      } catch { /* skip */ }
    }
  }
}

const resourceIdListing = Object.entries(resourceIdsByEnc)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([enc, ids]) => `${enc}: ${ids.sort().join(", ")}`)
  .join("\n");

// ── Build prompt ────────────────────────────────────────────────────────

const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/security-labels.md`).text();

const checkScript = `${PIPELINE_ROOT}/steps/check-labels.ts`;

const userMessage = `# Encounter Classification for ${slug}

## Scenario
${scenario}

## Encounter Inventories
${inventories.join("\n\n")}

## Resource IDs by Encounter

Use these actual resource IDs when writing \`id_substring\` values in overrides.

\`\`\`
${resourceIdListing}
\`\`\`

## Available Tools

- **Check script**: \`bun run ${checkScript} <your-output-file> ${patientDir}\`
  Run this after writing your classification JSON to verify all encounter IDs and override substrings match real resources. Fix any errors it reports before finishing.

## Instructions

1. Write your classification JSON to the output file
2. Run the check script on it
3. Fix any mismatches and re-check until clean

Classify each encounter and identify any resource-level overrides. Output raw JSON only.
`;

// ── Phase 1: LLM classification ─────────────────────────────────────────

console.log(`[07] ${slug}: Running agent for classification...`);
const rawOutput = await callAgent({
  systemPrompt,
  userMessage,
  outputFileName: "security-labels.json",
});

// Parse and validate
let classification: any;
try {
  classification = JSON.parse(rawOutput);
} catch (e) {
  console.error(`[07] ${slug}: Failed to parse classification JSON:`);
  console.error(rawOutput.slice(0, 500));
  console.error(`[07] Workdir preserved: ${workdir}`);
  process.exit(1);
}

if (!classification.encounters || typeof classification.encounters !== "object") {
  console.error(`[07] ${slug}: Classification missing 'encounters' object`);
  process.exit(1);
}

// Write classification to patient dir
await Bun.write(classificationPath, JSON.stringify(classification, null, 2) + "\n");
console.log(`[07] ${slug}: Classification written to ${classificationPath}`);
console.log(`[07] ${slug}: Encounters classified: ${Object.keys(classification.encounters).length}`);
console.log(`[07] ${slug}: Resource overrides: ${classification.resource_overrides?.length ?? 0}`);

// Run check ourselves too (agent should have already, but belt-and-suspenders)
try {
  await $`bun run ${checkScript} ${classificationPath}`;
} catch {
  console.error(`[07] ${slug}: Check script found issues — review ${classificationPath}`);
  process.exit(1);
}

// ── Phase 2: Apply labels ───────────────────────────────────────────────

console.log(`[07] ${slug}: Applying labels...`);
const applyScript = `${PIPELINE_ROOT}/steps/apply-labels.ts`;
const result = await $`bun run ${applyScript} ${classificationPath}`.text();
console.log(result);

console.log(`[07] ${slug}: Done.`);
