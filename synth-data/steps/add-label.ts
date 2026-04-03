#!/usr/bin/env bun
/**
 * add-label: Add a FHIR security label to a resource's meta.security array.
 *
 * Usage: bun run steps/add-label.ts <resource.json> <LABEL_CODE>
 *
 * Supported codes (from http://terminology.hl7.org/CodeSystem/v3-ActCode):
 *   SEX  — sexuality and reproductive health information sensitivity
 *   HIV  — HIV/AIDS information sensitivity
 *   ETH  — substance abuse information sensitivity
 *   PSY  — psychiatry disorder information sensitivity
 *   MH   — mental health information sensitivity
 *   BH   — behavioral health information sensitivity
 *   SUD  — substance use disorder information sensitivity
 *   STD  — sexually transmitted disease information sensitivity
 *   GDIS — genetic disease information sensitivity
 *   SDV  — sexual assault, abuse, or domestic violence information sensitivity
 *
 * Idempotent — won't add a duplicate label.
 */

export {};

const LABELS: Record<string, string> = {
  SEX: "sexuality and reproductive health information sensitivity",
  HIV: "HIV/AIDS information sensitivity",
  ETH: "substance abuse information sensitivity",
  PSY: "psychiatry disorder information sensitivity",
  MH: "mental health information sensitivity",
  BH: "behavioral health information sensitivity",
  SUD: "substance use disorder information sensitivity",
  STD: "sexually transmitted disease information sensitivity",
  GDIS: "genetic disease information sensitivity",
  SDV: "sexual assault, abuse, or domestic violence information sensitivity",
};

const SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

const [, , filePath, code] = process.argv;

if (!filePath || !code) {
  console.error("Usage: bun run steps/add-label.ts <resource.json> <LABEL_CODE>");
  process.exit(1);
}

const upperCode = code.toUpperCase();
const display = LABELS[upperCode];
if (!display) {
  console.error(`Unknown label code: ${code}. Supported: ${Object.keys(LABELS).join(", ")}`);
  process.exit(1);
}

const file = Bun.file(filePath);
if (!(await file.exists())) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const resource = JSON.parse(await file.text());

// Ensure meta.security exists
if (!resource.meta) resource.meta = {};
if (!Array.isArray(resource.meta.security)) resource.meta.security = [];

// Check for duplicate
const already = resource.meta.security.some(
  (s: any) => s.system === SYSTEM && s.code === upperCode
);

if (already) {
  console.log(`[add-label] ${filePath} already has ${upperCode}, skipping`);
  process.exit(0);
}

resource.meta.security.push({
  system: SYSTEM,
  code: upperCode,
  display,
});

await Bun.write(filePath, JSON.stringify(resource, null, 2) + "\n");
console.log(`[add-label] ${filePath} ← ${upperCode}`);
