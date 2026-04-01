#!/usr/bin/env bun
/**
 * Step 01: Generate patient biography + provider map
 *
 * Input:  patients/<slug>/scenario.md
 * Output: patients/<slug>/biography.md
 */

import { resolve } from "path";
import { PIPELINE_ROOT, callClaude } from "./lib.ts";

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const scenarioFile = `${patientDir}/scenario.md`;
  if (!patientDir || !await Bun.file(scenarioFile).exists()) {
    console.error("Usage: bun run steps/01-biography.ts <patient-dir>");
    console.error("  <patient-dir> must contain scenario.md");
    process.exit(1);
  }

  const outputFile = `${patientDir}/biography.md`;
  if (!force && await Bun.file(outputFile).exists()) {
    console.log(`[01] Skipping — biography.md exists (--force to regen)`);
    process.exit(0);
  }

  const scenario = await Bun.file(scenarioFile).text();
  const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/biography.md`).text();

  console.log(`[01] Generating biography...`);
  const result = await callClaude({
    systemPrompt,
    userMessage: `## Scenario Brief\n\n${scenario}`,
    model: "sonnet",
  });

  await Bun.write(outputFile, result);
  console.log(`[01] Wrote biography.md (${result.length} chars)`);
}

main().catch(e => { console.error(e); process.exit(1); });
