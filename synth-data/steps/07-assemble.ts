#!/usr/bin/env bun
/**
 * Step 07: Assemble bundles, validate terminology, write manifest
 *
 * Input:  patients/<slug>/sites/<site>/resources/<type>/<id>.json
 * Output: patients/<slug>/sites/<site>/bundle.json, manifest.json,
 *         patients/<slug>/validation-report.json
 *
 * Pure code — no LLM needed.
 */

import { resolve, dirname, basename } from "path";
import { readdir } from "fs/promises";
import Database from "bun:sqlite";

import { buildBundle } from "../lib/bundle-fullurl.ts";
import { enrichResource, loadEnrichmentContext } from "./enrichment.ts";

const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const TERMINOLOGY_DB = `${PIPELINE_ROOT}/terminology.sqlite`;

interface ManifestEntry {
  slug: string;
  sites: Array<{
    name: string;
    resourceCounts: Record<string, number>;
    totalResources: number;
  }>;
  validation?: {
    totalCodes: number;
    validCodes: number;
    unknownCodes: number;
    unknownCodeDetails: Array<{ resource: string; system: string; code: string; display?: string }>;
    referenceErrors: string[];
  };
}

async function collectResources(siteDir: string): Promise<any[]> {
  const files = await collectResourceFiles(siteDir);
  return files.map(file => file.resource);
}

async function collectResourceFiles(siteDir: string): Promise<Array<{ path: string; resource: any }>> {
  const resourcesDir = `${siteDir}/resources`;
  const resourceFiles: Array<{ path: string; resource: any }> = [];

  let typeDirs: string[];
  try {
    typeDirs = await readdir(resourcesDir);
  } catch {
    return resourceFiles;
  }

  for (const typeDir of typeDirs) {
    const typePath = `${resourcesDir}/${typeDir}`;
    let files: string[];
    try {
      files = (await readdir(typePath)).filter(f => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = `${typePath}/${file}`;
      const content = await Bun.file(filePath).text();
      try {
        resourceFiles.push({ path: filePath, resource: JSON.parse(content) });
      } catch (e) {
        console.warn(`[07] Failed to parse ${typePath}/${file}: ${e}`);
      }
    }
  }

  return resourceFiles;
}

function countByType(resources: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    const t = r.resourceType ?? "Unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

/** Extract all (system, code) pairs from a resource tree */
function extractCodes(value: any, results: Array<{ system: string; code: string; display?: string }> = []): Array<{ system: string; code: string; display?: string }> {
  if (Array.isArray(value)) {
    for (const item of value) extractCodes(item, results);
    return results;
  }
  if (!value || typeof value !== "object") return results;

  // Look for coding objects: { system, code }
  if (typeof value.system === "string" && typeof value.code === "string") {
    results.push({
      system: value.system,
      code: value.code,
      display: typeof value.display === "string" ? value.display : undefined,
    });
  }

  for (const child of Object.values(value)) {
    extractCodes(child, results);
  }

  return results;
}

/** Validate all terminology codes in resources against the SQLite database */
function validateTerminology(
  allResources: any[],
  db: Database,
): { totalCodes: number; validCodes: number; unknownCodes: number; unknownCodeDetails: Array<{ resource: string; system: string; code: string; display?: string }> } {
  // Only validate systems we have in the DB
  const knownSystems = new Set<string>();
  const systemRows = db.query("SELECT DISTINCT system FROM concepts").all() as Array<{ system: string }>;
  for (const row of systemRows) knownSystems.add(row.system);

  const checkStmt = db.prepare("SELECT 1 FROM concepts WHERE system = ? AND code = ? LIMIT 1");

  let totalCodes = 0;
  let validCodes = 0;
  const unknownCodeDetails: Array<{ resource: string; system: string; code: string; display?: string }> = [];

  for (const resource of allResources) {
    const resourceRef = `${resource.resourceType}/${resource.id}`;
    const codes = extractCodes(resource);

    for (const { system, code, display } of codes) {
      if (!knownSystems.has(system)) continue; // Skip systems we don't have data for
      totalCodes++;

      const found = checkStmt.get(system, code);
      if (found) {
        validCodes++;
      } else {
        unknownCodeDetails.push({ resource: resourceRef, system, code, display });
      }
    }
  }

  return {
    totalCodes,
    validCodes,
    unknownCodes: unknownCodeDetails.length,
    unknownCodeDetails,
  };
}

/** Check that all local references resolve within the resource set */
function validateReferences(allResources: any[]): string[] {
  const knownRefs = new Set<string>();
  for (const r of allResources) {
    if (r.resourceType && r.id) {
      knownRefs.add(`${r.resourceType}/${r.id}`);
    }
  }

  const errors: string[] = [];

  function checkRefs(value: any, context: string) {
    if (Array.isArray(value)) {
      for (const item of value) checkRefs(item, context);
      return;
    }
    if (!value || typeof value !== "object") return;

    if (typeof value.reference === "string") {
      const ref = value.reference;
      // Only check local references (Type/id pattern), skip absolute URLs and contained (#id)
      if (/^[A-Za-z][A-Za-z0-9]+\/[A-Za-z0-9.\-]+$/.test(ref) && !knownRefs.has(ref)) {
        errors.push(`${context}: unresolved reference ${ref}`);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "reference") checkRefs(child, context);
    }
  }

  for (const r of allResources) {
    checkRefs(r, `${r.resourceType}/${r.id}`);
  }

  return errors;
}

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");

  if (!patientDir) {
    console.error("Usage: bun run steps/07-assemble.ts <patient-dir>");
    process.exit(1);
  }

  const sitesDir = `${patientDir}/sites`;
  let siteDirs: string[];
  try {
    siteDirs = (await readdir(sitesDir)).filter(d => !d.startsWith("."));
  } catch {
    console.error(`[07] No sites/ directory — run step 05 first`);
    process.exit(1);
  }

  const patientSlug = basename(patientDir);
  const manifestEntry: ManifestEntry = { slug: patientSlug, sites: [] };
  const enrichmentContext = await loadEnrichmentContext(patientDir);

  // Collect all resources across all sites for cross-site validation
  const allResources: any[] = [];

  for (const site of siteDirs) {
    const siteDir = `${sitesDir}/${site}`;
    const resourceFiles = await collectResourceFiles(siteDir);
    const resources = resourceFiles.map(file => {
      enrichResource(file.resource, enrichmentContext, site);
      return file.resource;
    });

    if (resources.length === 0) {
      console.warn(`[07] No resources found for site ${site}`);
      continue;
    }

    for (const file of resourceFiles) {
      await Bun.write(file.path, `${JSON.stringify(file.resource, null, 2)}\n`);
    }

    allResources.push(...resources);

    // Build and write bundle
    const bundle = buildBundle(resources);
    await Bun.write(`${siteDir}/bundle.json`, JSON.stringify(bundle, null, 2));

    const counts = countByType(resources);
    manifestEntry.sites.push({
      name: site,
      resourceCounts: counts,
      totalResources: resources.length,
    });

    console.log(`[07] ${site}: ${resources.length} resources → bundle.json`);
    for (const [type, count] of Object.entries(counts).sort()) {
      console.log(`[07]   ${type}: ${count}`);
    }
  }

  // ─── Validation ───

  console.log(`\n[07] === Validation ===`);

  // Reference validation (across all sites for this patient)
  const referenceErrors = validateReferences(allResources);
  if (referenceErrors.length > 0) {
    console.warn(`[07] ${referenceErrors.length} unresolved references:`);
    for (const err of referenceErrors.slice(0, 20)) {
      console.warn(`[07]   ${err}`);
    }
    if (referenceErrors.length > 20) {
      console.warn(`[07]   ... and ${referenceErrors.length - 20} more`);
    }
  } else {
    console.log(`[07] All references resolve ✓`);
  }

  // Terminology validation
  let terminologyResult = { totalCodes: 0, validCodes: 0, unknownCodes: 0, unknownCodeDetails: [] as any[] };
  if (await Bun.file(TERMINOLOGY_DB).exists()) {
    const db = new Database(TERMINOLOGY_DB, { readonly: true });
    try {
      terminologyResult = validateTerminology(allResources, db);
      console.log(`[07] Terminology: ${terminologyResult.validCodes}/${terminologyResult.totalCodes} codes valid`);
      if (terminologyResult.unknownCodes > 0) {
        console.warn(`[07] ${terminologyResult.unknownCodes} unknown codes:`);
        for (const detail of terminologyResult.unknownCodeDetails.slice(0, 20)) {
          console.warn(`[07]   ${detail.resource}: ${detail.system} | ${detail.code} (${detail.display ?? "no display"})`);
        }
        if (terminologyResult.unknownCodes > 20) {
          console.warn(`[07]   ... and ${terminologyResult.unknownCodes - 20} more`);
        }
      }
    } finally {
      db.close();
    }
  } else {
    console.warn(`[07] Skipping terminology validation — ${TERMINOLOGY_DB} not found`);
  }

  manifestEntry.validation = {
    totalCodes: terminologyResult.totalCodes,
    validCodes: terminologyResult.validCodes,
    unknownCodes: terminologyResult.unknownCodes,
    unknownCodeDetails: terminologyResult.unknownCodeDetails,
    referenceErrors,
  };

  // Write validation report
  await Bun.write(
    `${patientDir}/validation-report.json`,
    JSON.stringify(manifestEntry.validation, null, 2),
  );
  console.log(`[07] Wrote validation-report.json`);

  // Update global manifest
  const manifestPath = `${PIPELINE_ROOT}/manifest.json`;
  let manifest: { patients: ManifestEntry[] } = { patients: [] };
  try {
    manifest = JSON.parse(await Bun.file(manifestPath).text());
  } catch {
    // Start fresh
  }

  const existingIdx = manifest.patients.findIndex(p => p.slug === patientSlug);
  if (existingIdx >= 0) {
    manifest.patients[existingIdx] = manifestEntry;
  } else {
    manifest.patients.push(manifestEntry);
  }

  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[07] Updated ${manifestPath}`);
  console.log(`[07] Done — ${patientSlug}: ${manifestEntry.sites.length} sites, ${allResources.length} total resources`);

  // Exit with warning code if there were validation issues
  if (referenceErrors.length > 0 || terminologyResult.unknownCodes > 0) {
    console.warn(`\n[07] Completed with validation warnings`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
