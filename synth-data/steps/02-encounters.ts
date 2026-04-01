#!/usr/bin/env bun
/**
 * Step 02: Generate encounter timeline
 *
 * Input:  patients/<slug>/biography.md
 * Output: patients/<slug>/encounters.md
 */

import { resolve } from "path";
import { PIPELINE_ROOT, callClaude } from "./lib.ts";

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const bioFile = `${patientDir}/biography.md`;
  if (!patientDir || !await Bun.file(bioFile).exists()) {
    console.error("Usage: bun run steps/02-encounters.ts <patient-dir>");
    console.error("  <patient-dir> must contain biography.md (run step 01 first)");
    process.exit(1);
  }

  const outputFile = `${patientDir}/encounters.md`;
  if (!force && await Bun.file(outputFile).exists()) {
    console.log(`[02] Skipping — encounters.md exists (--force to regen)`);
    process.exit(0);
  }

  const biography = await Bun.file(bioFile).text();
  const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/encounters.md`).text();

  // Optional: extra guidance injected at runtime (e.g., "limit to 10 encounters")
  // Pass via --guidance "..." or read from patients/<slug>/encounter-guidance.md
  const guidanceIdx = process.argv.indexOf("--guidance");
  let guidance = "";
  if (guidanceIdx >= 0 && process.argv[guidanceIdx + 1]) {
    guidance = process.argv[guidanceIdx + 1];
  }
  const guidanceFile = `${patientDir}/encounter-guidance.md`;
  if (!guidance && await Bun.file(guidanceFile).exists()) {
    guidance = await Bun.file(guidanceFile).text();
  }

  const guidanceBlock = guidance
    ? `\n\n## Additional Guidance\n\n${guidance}`
    : "";

  console.log(`[02] Generating encounter timeline...`);
  const result = await callClaude({
    systemPrompt,
    userMessage: `## Patient Biography\n\n${biography}${guidanceBlock}`,
    model: "sonnet",
  });

  await Bun.write(outputFile, result);
  console.log(`[02] Wrote encounters.md (${result.length} chars)`);
}

main().catch(e => { console.error(e); process.exit(1); });
