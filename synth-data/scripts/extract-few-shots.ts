#!/usr/bin/env bun
/**
 * Extract and sanitize few-shot examples from seed data.
 * Picks representative examples of each resource type,
 * strips PII (names, identifiers, dates shifted), and writes to few-shots/.
 */

import { resolve, dirname } from "path";

const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SEED_DIR = `${PIPELINE_ROOT}/seed-data`;
const OUTPUT_DIR = `${PIPELINE_ROOT}/few-shots`;

// Which resource types and how many examples of each
const TARGETS: Record<string, number> = {
  Observation: 3,   // pick: vital-sign BP, lab, screening
  Condition: 2,
  MedicationRequest: 1,
  Encounter: 2,     // pick: office visit, telephone
  AllergyIntolerance: 1,
  Immunization: 1,
  DocumentReference: 1,
  DiagnosticReport: 1,
};

function sanitizeResource(resource: any): any {
  const r = JSON.parse(JSON.stringify(resource));

  // Replace patient-identifying references with synthetic ones
  if (r.subject?.reference) r.subject.reference = "Patient/synth-patient-001";
  if (r.subject?.display) r.subject.display = "Synthetic Patient";
  if (r.patient?.reference) r.patient.reference = "Patient/synth-patient-001";
  if (r.patient?.display) r.patient.display = "Synthetic Patient";

  // Replace encounter references with generic ones
  if (r.encounter?.reference) r.encounter.reference = "Encounter/synth-encounter-001";
  if (r.encounter?.display) delete r.encounter.display;
  if (r.encounter?.identifier) delete r.encounter.identifier;

  // Replace practitioner references
  if (r.performer) {
    for (const p of r.performer) {
      if (p.reference?.startsWith("Practitioner/")) p.reference = "Practitioner/synth-practitioner-001";
    }
  }
  if (r.participant) {
    for (const p of r.participant) {
      if (p.individual?.reference?.startsWith("Practitioner/")) {
        p.individual.reference = "Practitioner/synth-practitioner-001";
      }
    }
  }
  if (r.requester?.reference?.startsWith("Practitioner/")) {
    r.requester.reference = "Practitioner/synth-practitioner-001";
  }
  if (r.recorder?.reference?.startsWith("Practitioner/")) {
    r.recorder.reference = "Practitioner/synth-practitioner-001";
  }

  // Replace organization references
  if (r.serviceProvider?.reference) r.serviceProvider.reference = "Organization/synth-org-001";
  if (r.managingOrganization?.reference) r.managingOrganization.reference = "Organization/synth-org-001";

  // Strip identifiers (often contain MRNs)
  delete r.identifier;

  // Replace the resource ID with a synthetic one
  r.id = `example-${r.resourceType?.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;

  // Strip meta except tags we'd want to show
  if (r.meta) {
    delete r.meta.versionId;
    delete r.meta.lastUpdated;
    delete r.meta.source;
  }

  return r;
}

function pickObservationExamples(observations: any[]): any[] {
  const picked: any[] = [];

  // Find a blood pressure (component observation)
  const bp = observations.find(o => {
    const codes = o.code?.coding?.map((c: any) => c.code) ?? [];
    return codes.includes("85354-9") || codes.includes("55284-4") || o.component?.length > 0;
  });
  if (bp) picked.push({ ...sanitizeResource(bp), _fewShotLabel: "blood-pressure-vital" });

  // Find a lab observation (with referenceRange)
  const lab = observations.find(o => {
    const cats = o.category?.flatMap((c: any) => c.coding?.map((cd: any) => cd.code) ?? []) ?? [];
    return cats.includes("laboratory") && o.valueQuantity;
  });
  if (lab) picked.push({ ...sanitizeResource(lab), _fewShotLabel: "lab-result" });

  // Find a screening observation (PHQ-2 or similar)
  const screening = observations.find(o => {
    const cats = o.category?.flatMap((c: any) => c.coding?.map((cd: any) => cd.code) ?? []) ?? [];
    return (cats.includes("survey") || cats.includes("sdoh") || cats.includes("functional-status"))
      && o.valueQuantity;
  });
  if (screening) picked.push({ ...sanitizeResource(screening), _fewShotLabel: "screening-score" });

  return picked;
}

function pickEncounterExamples(encounters: any[]): any[] {
  const picked: any[] = [];

  // Office visit
  const office = encounters.find(e =>
    e.type?.some((t: any) => t.text?.toLowerCase().includes("office") || t.text?.toLowerCase().includes("outpatient"))
  );
  if (office) picked.push({ ...sanitizeResource(office), _fewShotLabel: "office-visit" });

  // Telephone
  const phone = encounters.find(e =>
    e.type?.some((t: any) => t.text?.toLowerCase().includes("telephone"))
  );
  if (phone) picked.push({ ...sanitizeResource(phone), _fewShotLabel: "telephone" });

  return picked;
}

async function main() {
  console.log("Extracting few-shot examples from seed data...\n");

  // Load seed data
  const seedFiles = ["unitypoint-health.json", "university-of-wisconsin-medical-foundation.json"];
  const allResources: Record<string, any[]> = {};

  for (const fname of seedFiles) {
    const path = `${SEED_DIR}/${fname}`;
    if (!await Bun.file(path).exists()) {
      console.warn(`Seed file not found: ${path}`);
      continue;
    }
    const data = JSON.parse(await Bun.file(path).text());
    const fhir = data.fhir ?? {};

    for (const [type, resources] of Object.entries(fhir)) {
      if (!Array.isArray(resources)) continue;
      if (!allResources[type]) allResources[type] = [];
      allResources[type].push(...resources);
    }
  }

  console.log("Resource types found:", Object.keys(allResources).sort().join(", "));

  // Extract examples
  let written = 0;

  // Special handling for Observations (pick specific subtypes)
  if (allResources.Observation) {
    const examples = pickObservationExamples(allResources.Observation);
    for (const ex of examples) {
      const label = ex._fewShotLabel;
      delete ex._fewShotLabel;
      const outPath = `${OUTPUT_DIR}/observation-${label}.json`;
      await Bun.write(outPath, JSON.stringify(ex, null, 2));
      console.log(`  Wrote ${outPath}`);
      written++;
    }
  }

  // Special handling for Encounters (pick specific subtypes)
  if (allResources.Encounter) {
    const examples = pickEncounterExamples(allResources.Encounter);
    for (const ex of examples) {
      const label = ex._fewShotLabel;
      delete ex._fewShotLabel;
      const outPath = `${OUTPUT_DIR}/encounter-${label}.json`;
      await Bun.write(outPath, JSON.stringify(ex, null, 2));
      console.log(`  Wrote ${outPath}`);
      written++;
    }
  }

  // Generic handling for other types — just pick the first good one
  for (const type of ["Condition", "MedicationRequest", "AllergyIntolerance", "Immunization", "DocumentReference", "DiagnosticReport"]) {
    const resources = allResources[type];
    if (!resources?.length) continue;

    // Pick one with the most populated fields
    const best = resources.reduce((a, b) =>
      Object.keys(a).length >= Object.keys(b).length ? a : b
    );

    const sanitized = sanitizeResource(best);
    const outPath = `${OUTPUT_DIR}/${type.toLowerCase()}.json`;
    await Bun.write(outPath, JSON.stringify(sanitized, null, 2));
    console.log(`  Wrote ${outPath}`);
    written++;
  }

  console.log(`\nDone — ${written} few-shot examples in ${OUTPUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
