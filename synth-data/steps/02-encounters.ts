#!/usr/bin/env bun
/**
 * Step 02: Generate encounter timeline
 *
 * Input:  patients/<slug>/biography.md, patients/<slug>/provider-map.json
 * Output: patients/<slug>/encounters.md, patients/<slug>/encounters.json
 */

import { resolve } from "path";
import { PIPELINE_ROOT, callClaude } from "./lib.ts";
import {
  generateJsonArtifact,
  loadProviderMap,
  normalizeEncounterTimeline,
} from "./artifacts.ts";

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");
  const force = process.argv.includes("--force");

  const bioFile = `${patientDir}/biography.md`;
  const providerMapFile = `${patientDir}/provider-map.json`;
  if (!patientDir || !await Bun.file(bioFile).exists() || !await Bun.file(providerMapFile).exists()) {
    console.error("Usage: bun run steps/02-encounters.ts <patient-dir>");
    console.error("  <patient-dir> must contain biography.md + provider-map.json (run step 01 first)");
    process.exit(1);
  }

  const outputFile = `${patientDir}/encounters.md`;
  const sidecarFile = `${patientDir}/encounters.json`;
  const encountersExists = await Bun.file(outputFile).exists();
  const sidecarExists = await Bun.file(sidecarFile).exists();

  if (!force && encountersExists && sidecarExists) {
    console.log(`[02] Skipping — encounters.md and encounters.json exist (--force to regen)`);
    process.exit(0);
  }

  const biography = await Bun.file(bioFile).text();
  const providerMap = await loadProviderMap(providerMapFile);
  let encountersMarkdown = encountersExists ? await Bun.file(outputFile).text() : "";

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

  if (force || !encountersExists) {
    const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/encounters.md`).text();
    console.log(`[02] Generating encounter timeline...`);
      encountersMarkdown = await callClaude({
        systemPrompt,
        userMessage: [
          `## Provider Map JSON\n\`\`\`json\n${JSON.stringify(providerMap, null, 2)}\n\`\`\``,
          `## Patient Biography\n\n${biography}`,
          guidanceBlock.trim(),
        ].filter(Boolean).join("\n\n"),
    });

    await Bun.write(outputFile, encountersMarkdown);
    console.log(`[02] Wrote encounters.md (${encountersMarkdown.length} chars)`);
  } else {
    console.log(`[02] Reusing existing encounters.md and generating missing sidecars`);
  }

  if (force || !sidecarExists) {
    const sidecarPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/encounters-json.md`).text();
    console.log(`[02] Generating encounters.json...`);
      const encountersRaw = await generateJsonArtifact({
        systemPrompt: sidecarPrompt,
        userMessage: [
          `## Provider Map JSON\n\`\`\`json\n${JSON.stringify(providerMap, null, 2)}\n\`\`\``,
          `## Encounter Timeline Markdown\n\n${encountersMarkdown}`,
      ].join("\n\n"),
      repairLabel: "encounter timeline JSON",
    });
    const encounters = normalizeEncounterTimeline(encountersRaw, providerMap);
    await Bun.write(sidecarFile, JSON.stringify(encounters, null, 2));
    console.log(`[02] Wrote encounters.json (${encounters.encounters.length} encounters)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
