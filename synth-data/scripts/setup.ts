#!/usr/bin/env bun
/**
 * Setup script for synth-data pipeline dependencies.
 * Downloads the FHIR validator JAR if not present.
 */

import { existsSync } from "fs";

const VALIDATOR_VERSION = Bun.env.VALIDATOR_VERSION; // e.g., "6.6.7"
const VALIDATOR_URL = VALIDATOR_VERSION
  ? `https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VALIDATOR_VERSION}/validator_cli.jar`
  : `https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar`;
const VALIDATOR_PATH = "./validator.jar";

async function downloadValidator() {
  if (existsSync(VALIDATOR_PATH)) {
    console.log(`validator.jar already exists — skipping download`);
    return;
  }

  console.log(
    VALIDATOR_VERSION
      ? `Downloading FHIR validator v${VALIDATOR_VERSION}...`
      : `Downloading latest FHIR validator...`,
  );

  const response = await fetch(VALIDATOR_URL);
  if (!response.ok) {
    throw new Error(`Failed to download validator: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await Bun.write(VALIDATOR_PATH, buffer);
  console.log(`Downloaded validator.jar (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}

async function checkDependencies() {
  // Check Java
  try {
    const proc = Bun.spawnSync({ cmd: ["java", "-version"], stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error();
    console.log("Java found");
  } catch {
    console.error("Java is required but not found. Install Java 11+ and try again.");
    process.exit(1);
  }

  // Check terminology.sqlite symlink
  if (!existsSync("./terminology.sqlite")) {
    console.warn("Warning: terminology.sqlite not found. Symlink it from the Kiln project:");
    console.warn("  ln -s /path/to/kiln/server/db/terminology.sqlite ./terminology.sqlite");
  } else {
    console.log("terminology.sqlite found");
  }

  // Check seed-data symlink
  if (!existsSync("./seed-data")) {
    console.warn("Warning: seed-data/ not found. Symlink it:");
    console.warn("  ln -s /path/to/.seed-data/health-record-assistant/data ./seed-data");
  } else {
    console.log("seed-data/ found");
  }
}

async function main() {
  console.log("Setting up synth-data pipeline...\n");
  await checkDependencies();
  await downloadValidator();
  console.log("\nSetup complete.");
}

main().catch(e => { console.error(e); process.exit(1); });
