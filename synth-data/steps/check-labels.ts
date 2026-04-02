#!/usr/bin/env bun
/**
 * check-labels: Dry-run validation of a security-labels.json classification.
 *
 * Usage: bun run steps/check-labels.ts <classification.json> [patient-dir]
 *
 * If patient-dir is omitted, it defaults to dirname(classification.json).
 *
 * Checks:
 * - Every encounter ID in "encounters" matches at least one resource
 * - Every resource_override matches at least one resource
 * - Reports unmatched overrides with suggestions from actual resource IDs
 *
 * Exits 0 if all OK, 1 if any issues found.
 */

import { readdir } from "fs/promises";
import { resolve, dirname } from "path";

const SCAFFOLD_TYPES = new Set(["Patient", "Organization", "Practitioner", "Location"]);

const classificationPath = resolve(process.argv[2] ?? "");
if (!classificationPath.endsWith(".json") || !(await Bun.file(classificationPath).exists())) {
  console.error("Usage: bun run steps/check-labels.ts <classification.json> [patient-dir]");
  process.exit(1);
}

const patientDir = process.argv[3] ? resolve(process.argv[3]) : dirname(classificationPath);
const classification = JSON.parse(await Bun.file(classificationPath).text());

// Collect all resource IDs grouped by encounter prefix
const resourceIds: string[] = [];
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
        if (r.id) resourceIds.push(r.id);
      } catch { /* skip */ }
    }
  }
}

let issues = 0;

// Check encounter classifications
for (const encId of Object.keys(classification.encounters ?? {})) {
  const matching = resourceIds.filter(id => id === encId || id.startsWith(`${encId}-`));
  if (matching.length === 0) {
    console.error(`ERROR: Encounter "${encId}" matches 0 resources`);
    const suggestions = resourceIds.filter(id => id.includes(encId)).slice(0, 5);
    if (suggestions.length) console.error(`  Suggestions: ${suggestions.join(", ")}`);
    issues++;
  } else {
    console.log(`OK: Encounter "${encId}" → ${matching.length} resources`);
  }
}

// Check resource overrides
for (const override of classification.resource_overrides ?? []) {
  const matching = resourceIds.filter(
    id => id.startsWith(override.encounter_prefix) && id.includes(override.id_substring)
  );
  if (matching.length === 0) {
    console.error(`ERROR: Override "${override.encounter_prefix}/*${override.id_substring}*" matches 0 resources`);
    // Suggest actual IDs from that encounter
    const encResources = resourceIds.filter(id => id.startsWith(override.encounter_prefix));
    if (encResources.length) {
      console.error(`  Resources at ${override.encounter_prefix}: ${encResources.join(", ")}`);
    }
    issues++;
  } else {
    console.log(`OK: Override "${override.encounter_prefix}/*${override.id_substring}*" → ${matching.map(id => id).join(", ")}`);
  }
}

if (issues > 0) {
  console.error(`\n${issues} issue(s) found. Fix the classification and re-check.`);
  process.exit(1);
} else {
  console.log(`\nAll checks passed.`);
  process.exit(0);
}
