#!/usr/bin/env bun
/**
 * Step 01: Generate patient biography + provider map
 *
 * Input:  patients/<slug>/scenario.md
 * Output: patients/<slug>/biography.md, patients/<slug>/provider-map.json
 */

import { resolve } from "path";
import { PIPELINE_ROOT, callClaude } from "./lib.ts";
import { generateJsonArtifact, normalizeProviderMap } from "./artifacts.ts";

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
  const providerMapFile = `${patientDir}/provider-map.json`;
  const biographyExists = await Bun.file(outputFile).exists();
  const providerMapExists = await Bun.file(providerMapFile).exists();

  if (!force && biographyExists && providerMapExists) {
    console.log(`[01] Skipping — biography.md and provider-map.json exist (--force to regen)`);
    process.exit(0);
  }

  let biography = biographyExists ? await Bun.file(outputFile).text() : "";

  if (force || !biographyExists) {
    const scenario = await Bun.file(scenarioFile).text();
    const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/biography.md`).text();

    console.log(`[01] Generating biography...`);
    biography = await callClaude({
      systemPrompt,
      userMessage: `## Scenario Brief\n\n${scenario}`,
    });

    await Bun.write(outputFile, biography);
    console.log(`[01] Wrote biography.md (${biography.length} chars)`);
  } else {
    console.log(`[01] Reusing existing biography.md and generating missing sidecars`);
  }

  if (force || !providerMapExists) {
    const sidecarPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/provider-map-json.md`).text();
    console.log(`[01] Generating provider-map.json...`);
    const providerMapRaw = await generateJsonArtifact({
      systemPrompt: sidecarPrompt,
      userMessage: `## Biography Markdown\n\n${biography}`,
      repairLabel: "provider-map JSON",
    });
    const providerMap = normalizeProviderMap(providerMapRaw);
    await Bun.write(providerMapFile, JSON.stringify(providerMap, null, 2));
    console.log(`[01] Wrote provider-map.json (${providerMap.sites.length} sites)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
