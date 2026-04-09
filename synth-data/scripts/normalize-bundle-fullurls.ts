#!/usr/bin/env bun

import { readdir } from "fs/promises";
import { basename, dirname, resolve } from "path";

import { normalizeBundleEntryFullUrls } from "../lib/bundle-fullurl.ts";

const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PATIENTS_ROOT = `${PIPELINE_ROOT}/patients`;

async function listPatientDirs(args: string[]): Promise<string[]> {
  if (args.length > 0) {
    return args.map(arg => resolve(arg));
  }

  const entries = await readdir(PATIENTS_ROOT, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => `${PATIENTS_ROOT}/${entry.name}`);
}

async function normalizePatientBundles(patientDir: string): Promise<{ filesChanged: number; entriesChanged: number }> {
  const sitesDir = `${patientDir}/sites`;
  let siteDirs: string[];
  try {
    siteDirs = await readdir(sitesDir);
  } catch {
    return { filesChanged: 0, entriesChanged: 0 };
  }

  let filesChanged = 0;
  let entriesChanged = 0;

  for (const site of siteDirs) {
    const bundlePath = `${sitesDir}/${site}/bundle.json`;
    const bundleFile = Bun.file(bundlePath);
    if (!(await bundleFile.exists())) continue;

    const bundle = await bundleFile.json();
    const result = normalizeBundleEntryFullUrls(bundle);
    if (result.changedEntries === 0) continue;

    await Bun.write(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    filesChanged++;
    entriesChanged += result.changedEntries;
    console.log(`[bundle-fullurls] ${basename(patientDir)}/${site}: rewrote ${result.changedEntries} Bundle.entry.fullUrl value(s)`);
  }

  return { filesChanged, entriesChanged };
}

async function main() {
  const patientDirs = await listPatientDirs(process.argv.slice(2));
  if (patientDirs.length === 0) {
    console.error("Usage: bun run scripts/normalize-bundle-fullurls.ts [patients/<slug> ...]");
    process.exit(1);
  }

  let filesChanged = 0;
  let entriesChanged = 0;

  for (const patientDir of patientDirs) {
    const result = await normalizePatientBundles(patientDir);
    filesChanged += result.filesChanged;
    entriesChanged += result.entriesChanged;
  }

  if (filesChanged === 0) {
    console.log("[bundle-fullurls] No bundle fullUrl changes were needed");
    return;
  }

  console.log(`[bundle-fullurls] Updated ${filesChanged} bundle file(s), rewrote ${entriesChanged} fullUrl value(s)`);
}

await main();
