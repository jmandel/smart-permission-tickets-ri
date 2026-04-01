#!/usr/bin/env bun
/**
 * Step 04: Generate per-encounter resource inventories (fan-out)
 *
 * Input:  patients/<slug>/biography.md, patients/<slug>/encounters.md,
 *         patients/<slug>/notes/enc-NNN.txt (clinical notes from step 03)
 * Output: patients/<slug>/inventories/enc-NNN.md (one per encounter)
 *
 * Reads the clinical note for each encounter so the resource inventory
 * is consistent with the narrative. Fans out with concurrency control.
 */

import { resolve } from "path";
import { mkdir } from "fs/promises";
import { PIPELINE_ROOT, callClaude, parseEncounters, createLimiter, encId } from "./lib.ts";

const MAX_CONCURRENCY = 3;

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const encountersFile = `${patientDir}/encounters.md`;
  const bioFile = `${patientDir}/biography.md`;
  if (!patientDir || !await Bun.file(encountersFile).exists() || !await Bun.file(bioFile).exists()) {
    console.error("Usage: bun run steps/04-inventory.ts <patient-dir>");
    console.error("  <patient-dir> must contain biography.md + encounters.md (run steps 01-02 first)");
    process.exit(1);
  }

  const inventoryDir = `${patientDir}/inventories`;
  const notesDir = `${patientDir}/notes`;
  await mkdir(inventoryDir, { recursive: true });

  const biography = await Bun.file(bioFile).text();
  const encountersText = await Bun.file(encountersFile).text();
  const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/inventory.md`).text();

  const encounters = parseEncounters(encountersText);
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
        const id = encId(enc.index);
        const outFile = `${inventoryDir}/enc-${id}.md`;
        if (!force && await Bun.file(outFile).exists()) {
          completed++;
          return;
        }

        // Read the clinical note if it exists (from step 03)
        const noteFile = `${notesDir}/enc-${id}.txt`;
        let noteContext = "";
        if (await Bun.file(noteFile).exists()) {
          const noteText = await Bun.file(noteFile).text();
          noteContext = `\n\n## Clinical Note for This Encounter\n\n${noteText}\n\nThe resource inventory below MUST be consistent with this clinical note. Every vital sign, lab value, diagnosis, and medication mentioned in the note should have a corresponding FHIR resource.`;
        }

        const result = await callClaude({
          systemPrompt,
          userMessage: `## Patient Context\n\n${biography}\n\n## This Encounter\n\n${enc.text}${noteContext}`,
          model: "haiku",
        });

        await Bun.write(outFile, result);
        completed++;
        console.log(`[04] (${completed}/${encounters.length}) enc-${id} — ${enc.heading}`);
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
