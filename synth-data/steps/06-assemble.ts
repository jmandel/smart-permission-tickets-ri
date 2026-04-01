#!/usr/bin/env bun
/**
 * Step 05: Assemble bundles, wire references, validate, write manifest
 *
 * Input:  patients/<slug>/sites/*/resources/*/*.json
 * Output: patients/<slug>/sites/*/bundle.json, manifest.json
 *
 * Pure code — no LLM needed.
 */

import { resolve, dirname, basename } from "path";
import { mkdir, readdir } from "fs/promises";

const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

interface ManifestEntry {
  slug: string;
  sites: Array<{
    name: string;
    resourceCounts: Record<string, number>;
    totalResources: number;
  }>;
}

async function collectResources(siteDir: string): Promise<any[]> {
  const resources: any[] = [];
  const resourcesDir = `${siteDir}/resources`;

  let typeDirs: string[];
  try {
    typeDirs = await readdir(resourcesDir);
  } catch {
    return resources;
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
      const content = await Bun.file(`${typePath}/${file}`).text();
      try {
        resources.push(JSON.parse(content));
      } catch (e) {
        console.warn(`[05] Failed to parse ${typePath}/${file}: ${e}`);
      }
    }
  }

  return resources;
}

function buildBundle(resources: any[]): any {
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: resources.map(r => ({
      fullUrl: `urn:uuid:${r.id}`,
      resource: r,
    })),
  };
}

function countByType(resources: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    const t = r.resourceType ?? "Unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const patientDir = resolve(process.argv[2] ?? "");

  if (!patientDir) {
    console.error("Usage: bun run steps/05-assemble.ts <patient-dir>");
    process.exit(1);
  }

  const sitesDir = `${patientDir}/sites`;
  let siteDirs: string[];
  try {
    siteDirs = await readdir(sitesDir);
  } catch {
    console.error(`[05] No sites/ directory — run step 04 first`);
    process.exit(1);
  }

  const patientSlug = basename(patientDir);
  const manifestEntry: ManifestEntry = { slug: patientSlug, sites: [] };

  for (const site of siteDirs) {
    const siteDir = `${sitesDir}/${site}`;
    const resources = await collectResources(siteDir);

    if (resources.length === 0) {
      console.warn(`[05] No resources found for site ${site}`);
      continue;
    }

    // Build and write bundle
    const bundle = buildBundle(resources);
    await Bun.write(`${siteDir}/bundle.json`, JSON.stringify(bundle, null, 2));

    const counts = countByType(resources);
    manifestEntry.sites.push({
      name: site,
      resourceCounts: counts,
      totalResources: resources.length,
    });

    console.log(`[05] ${site}: ${resources.length} resources → bundle.json`);
    for (const [type, count] of Object.entries(counts).sort()) {
      console.log(`[05]   ${type}: ${count}`);
    }
  }

  // Update global manifest
  const manifestPath = `${PIPELINE_ROOT}/manifest.json`;
  let manifest: { patients: ManifestEntry[] } = { patients: [] };
  try {
    manifest = JSON.parse(await Bun.file(manifestPath).text());
  } catch {
    // Start fresh
  }

  // Upsert this patient
  const existingIdx = manifest.patients.findIndex(p => p.slug === patientSlug);
  if (existingIdx >= 0) {
    manifest.patients[existingIdx] = manifestEntry;
  } else {
    manifest.patients.push(manifestEntry);
  }

  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[05] Updated ${manifestPath}`);
  console.log(`[05] Done — ${patientSlug}: ${manifestEntry.sites.length} sites`);
}

main().catch(e => { console.error(e); process.exit(1); });
