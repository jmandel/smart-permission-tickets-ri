#!/usr/bin/env bun
/**
 * Step 07: Assign FHIR security labels to resources based on clinical sensitivity.
 *
 * Input:  patients/{slug}/sites/{site}/resources/{Type}/{id}.json
 *         patients/{slug}/inventories/enc-NNN.json
 *         patients/{slug}/scenario.md
 * Output: Modifies resources in-place (adds meta.security labels)
 *         patients/{slug}/security-labels-report.md
 *
 * Uses an LLM agent to review the patient's clinical content and decide which
 * resources need sensitivity labels (SEX, HIV, MH, ETH, etc.).
 */

import { resolve, dirname } from "path";
import { readdir } from "fs/promises";
import { callAgentWorkdir, PIPELINE_ROOT } from "./lib";

const patientDir = resolve(process.argv[2] ?? "");
if (!patientDir || !(await Bun.file(`${patientDir}/scenario.md`).exists())) {
  console.error("Usage: bun run steps/07-security-labels.ts patients/<slug>/");
  process.exit(1);
}

const slug = patientDir.split("/").pop()!;
const reportPath = `${patientDir}/security-labels-report.md`;

// Check if already done
if (await Bun.file(reportPath).exists() && !process.argv.includes("--force")) {
  console.log(`[07] ${slug}: security-labels-report.md already exists, skipping (use --force to redo)`);
  process.exit(0);
}

console.log(`[07] ${slug}: Assigning security labels...`);

// ── Gather context ──────────────────────────────────────────────────────

// 1. Scenario
const scenario = await Bun.file(`${patientDir}/scenario.md`).text();

// 2. Inventories (JSON sidecars — compact, structured)
const invDir = `${patientDir}/inventories`;
const invFiles = (await readdir(invDir)).filter(f => f.endsWith(".json")).sort();
const inventories: string[] = [];
for (const f of invFiles) {
  const content = await Bun.file(`${invDir}/${f}`).text();
  inventories.push(`### ${f}\n\`\`\`json\n${content}\n\`\`\``);
}

// 3. Resource manifest — one line per resource with key info
const siteDirs: string[] = [];
const sitesRoot = `${patientDir}/sites`;
for (const site of (await readdir(sitesRoot)).sort()) {
  const resourcesDir = `${sitesRoot}/${site}/resources`;
  try {
    await readdir(resourcesDir);
    siteDirs.push(site);
  } catch { continue; }
}

const manifestLines: string[] = [];
for (const site of siteDirs) {
  const resourcesDir = `${sitesRoot}/${site}/resources`;
  const typeDirs = (await readdir(resourcesDir)).sort();
  for (const typeDir of typeDirs) {
    const typePath = `${resourcesDir}/${typeDir}`;
    let files: string[];
    try {
      files = (await readdir(typePath)).filter(f => f.endsWith(".json")).sort();
    } catch { continue; }
    for (const file of files) {
      const fullPath = `${typePath}/${file}`;
      try {
        const r = JSON.parse(await Bun.file(fullPath).text());
        const code =
          r.code?.text ?? r.code?.coding?.[0]?.display ??
          r.type?.[0]?.text ?? r.type?.[0]?.coding?.[0]?.display ??
          r.vaccineCode?.text ?? r.vaccineCode?.coding?.[0]?.display ??
          r.medicationCodeableConcept?.text ?? r.medicationCodeableConcept?.coding?.[0]?.display ??
          r.category?.[0]?.text ?? r.category?.[0]?.coding?.[0]?.display ??
          "—";
        manifestLines.push(`${fullPath} | ${r.resourceType} | ${r.id} | ${code}`);
      } catch {
        manifestLines.push(`${fullPath} | PARSE_ERROR`);
      }
    }
  }
}

// ── Build prompt ────────────────────────────────────────────────────────

const systemPrompt = await Bun.file(`${PIPELINE_ROOT}/prompts/security-labels.md`).text();

const userMessage = `# Security Label Assignment for ${slug}

## Scenario
${scenario}

## Encounter Inventories
${inventories.join("\n\n")}

## Resource Manifest
Each line: file_path | resourceType | id | primary_code_or_description

\`\`\`
${manifestLines.join("\n")}
\`\`\`

## Available Tools

- **add-label script**: \`bun run ${PIPELINE_ROOT}/steps/add-label.ts <file_path> <LABEL_CODE>\`
  - Run from any directory — the file_path in the manifest above is absolute
  - Supported codes: SEX, HIV, ETH, MH, STD, SDV

## Instructions

1. Review the scenario and inventories to understand what's clinically sensitive
2. Review the resource manifest to identify which specific resources need labels
3. For each resource that needs a label, run the add-label command
4. Write your summary report to \`${reportPath}\`
`;

// ── Run agent ───────────────────────────────────────────────────────────

const workdir = await callAgentWorkdir({
  systemPrompt,
  userMessage,
});

// Check if report was written (agent writes it to the patient dir, not workdir)
if (await Bun.file(reportPath).exists()) {
  console.log(`[07] ${slug}: Labels assigned. Report: ${reportPath}`);
} else {
  console.log(`[07] ${slug}: Agent completed but no report found at ${reportPath}`);
  console.log(`[07] Check workdir: ${workdir}`);
}

// Clean up workdir
try {
  const { $ } = await import("bun");
  await $`rm -rf ${workdir}`.quiet();
} catch {}
