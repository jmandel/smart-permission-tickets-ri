#!/usr/bin/env bun
/**
 * strip-labels: Remove all FHIR security labels from resources in a patient directory.
 *
 * Usage: bun run steps/strip-labels.ts patients/<slug>/
 */

import { readdir } from "fs/promises";
import { resolve } from "path";

const patientDir = resolve(process.argv[2] ?? "");
const sitesRoot = `${patientDir}/sites`;

let stripped = 0;

for (const site of (await readdir(sitesRoot)).sort()) {
  const resourcesDir = `${sitesRoot}/${site}/resources`;
  let typeDirs: string[];
  try { typeDirs = await readdir(resourcesDir); } catch { continue; }

  for (const typeDir of typeDirs) {
    const typePath = `${resourcesDir}/${typeDir}`;
    let files: string[];
    try { files = (await readdir(typePath)).filter(f => f.endsWith(".json")); } catch { continue; }

    for (const file of files) {
      const fullPath = `${typePath}/${file}`;
      const resource = JSON.parse(await Bun.file(fullPath).text());
      if (resource.meta?.security?.length > 0) {
        delete resource.meta.security;
        if (resource.meta && Object.keys(resource.meta).length === 0) {
          delete resource.meta;
        }
        await Bun.write(fullPath, JSON.stringify(resource, null, 2) + "\n");
        stripped++;
      }
    }
  }
}

console.log(`Stripped security labels from ${stripped} resources in ${patientDir}`);
