#!/usr/bin/env bun
/**
 * Step 03: Generate clinical notes per encounter (fan-out)
 *
 * Input:  patients/<slug>/biography.md, patients/<slug>/provider-map.json, patients/<slug>/encounters.json
 * Output: patients/<slug>/notes/enc-NNN.txt (one per encounter)
 *
 * Generates plain-text clinical notes. These feed into step 04 (inventory)
 * to ensure structured FHIR data is consistent with the narrative.
 */

import { resolve } from "path";
import { mkdir } from "fs/promises";
import { PIPELINE_ROOT, callClaude, createLimiter, encId } from "./lib.ts";
import { loadEncounterTimeline, loadProviderMap } from "./artifacts.ts";

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
    console.error("Usage: bun run steps/03-notes.ts <patient-dir>");
    console.error("  <patient-dir> must contain biography.md + provider-map.json + encounters.json");
    process.exit(1);
  }

  const notesDir = `${patientDir}/notes`;
  await mkdir(notesDir, { recursive: true });

  const biography = await Bun.file(bioFile).text();
  const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/notes.md`).text();

  const providerMap = await loadProviderMap(providerMapFile);
  const encounters = (await loadEncounterTimeline(encountersFile, providerMap)).encounters;
  console.log(`[03] Found ${encounters.length} encounters for note generation`);

  if (encounters.length === 0) {
    console.error(`[03] No encounters parsed — check encounters.md format`);
    process.exit(1);
  }

  const limit = createLimiter(MAX_CONCURRENCY);
  let completed = 0;

  const results = await Promise.allSettled(
    encounters.map(enc =>
      limit(async () => {
        const outFile = `${notesDir}/enc-${encId(enc.encounter_index)}.txt`;
        if (!force && await Bun.file(outFile).exists()) {
          completed++;
          return;
        }

        const result = await callClaude({
          systemPrompt,
          userMessage: [
            `## Encounter Contract\n\`\`\`json\n${JSON.stringify(enc, null, 2)}\n\`\`\``,
            `## Encounter Narrative\n\n### ${enc.header}\n\n${enc.body_markdown}`,
            `## Patient Background\n\n${biography}`,
          ].join("\n\n"),
        });

        await Bun.write(outFile, result);
        completed++;
        console.log(`[03] (${completed}/${encounters.length}) ${enc.header}`);
      })
    )
  );

  const failures = results.filter(r => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`[03] ${failures.length} notes failed:`);
    for (const f of failures) {
      if (f.status === "rejected") console.error(`  ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`[03] Done — ${encounters.length} notes in ${notesDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
