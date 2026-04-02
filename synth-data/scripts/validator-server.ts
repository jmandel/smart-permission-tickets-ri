#!/usr/bin/env bun
/**
 * FHIR Validator HTTP server manager.
 *
 * Starts the HL7 FHIR validator JAR in HTTP server mode and exposes
 * a simple validation API. Stays running in the background.
 *
 * Usage:
 *   bun run scripts/validator-server.ts start   # Start (default port 8090)
 *   bun run scripts/validator-server.ts stop     # Stop
 *   bun run scripts/validator-server.ts status   # Check if running
 *
 * Environment:
 *   VALIDATOR_JAR   — path to validator_cli.jar (default: ./validator.jar)
 *   VALIDATOR_PORT  — port to run on (default: 8090)
 *   VALIDATOR_HEAP  — Java heap size (default: 4g)
 *
 * Once running, agents can validate resources via:
 *   curl -X POST http://localhost:8090/validate \
 *     -H "Content-Type: application/fhir+json" \
 *     -d @resource.json
 *
 * Response is a FHIR OperationOutcome.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PID_FILE = `${PIPELINE_ROOT}/.validator-pid`;
const PORT_FILE = `${PIPELINE_ROOT}/.validator-port`;

const VALIDATOR_JAR = Bun.env.VALIDATOR_JAR ?? `${PIPELINE_ROOT}/validator.jar`;
const VALIDATOR_PORT = parseInt(Bun.env.VALIDATOR_PORT ?? "8090");
const VALIDATOR_HEAP = Bun.env.VALIDATOR_HEAP ?? "4g";

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

async function getRunningInfo(): Promise<{ pid: number; port: number } | null> {
  try {
    const pid = parseInt(await Bun.file(PID_FILE).text());
    const port = parseInt(await Bun.file(PORT_FILE).text());
    if (await isProcessRunning(pid)) {
      return { pid, port };
    }
  } catch {}
  return null;
}

async function waitForReady(port: number, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/validateResource`, { method: "GET" });
      if (res.ok || res.status >= 400) return; // Any response means it's up
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Validator failed to start within ${timeoutMs / 1000}s`);
}

async function start() {
  const existing = await getRunningInfo();
  if (existing) {
    console.log(`Validator already running (pid ${existing.pid}, port ${existing.port})`);
    return;
  }

  if (!existsSync(VALIDATOR_JAR)) {
    console.error(`validator.jar not found at ${VALIDATOR_JAR}`);
    console.error(`Run: bun run scripts/setup.ts`);
    process.exit(1);
  }

  const port = VALIDATOR_PORT;
  console.log(`Starting FHIR validator on port ${port}...`);

  const child = spawn("java", [
    `-Xmx${VALIDATOR_HEAP}`,
    "-jar", VALIDATOR_JAR,
    "-server", String(port),
    "-version", "4.0",
    "-tx", "n/a",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout?.on("data", (b: Buffer) => {
    const line = b.toString().trim();
    if (line) console.log(`[validator] ${line}`);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const line = b.toString().trim();
    if (line) console.error(`[validator] ${line}`);
  });

  child.unref(); // Allow this script to exit while validator keeps running

  // Save PID and port
  await Bun.write(PID_FILE, String(child.pid));
  await Bun.write(PORT_FILE, String(port));

  console.log(`Validator process started (pid ${child.pid}). Waiting for ready...`);

  try {
    await waitForReady(port);
    console.log(`Validator ready on http://localhost:${port}`);
    console.log(`\nTo validate a resource:`);
    console.log(`  curl -s -X POST http://localhost:${port}/validateResource -H "Content-Type: application/fhir+json" -d @resource.json | jq .`);
  } catch (e) {
    console.error(`${e}`);
    child.kill();
    process.exit(1);
  }
}

async function stop() {
  const info = await getRunningInfo();
  if (!info) {
    console.log("Validator is not running");
    return;
  }

  process.kill(info.pid, "SIGTERM");
  console.log(`Stopped validator (pid ${info.pid})`);

  // Clean up PID/port files
  try { await Bun.write(PID_FILE, ""); } catch {}
  try { await Bun.write(PORT_FILE, ""); } catch {}
}

async function status() {
  const info = await getRunningInfo();
  if (!info) {
    console.log("Validator is not running");
    process.exit(1);
  }

  // Try a health check
  try {
    const res = await fetch(`http://localhost:${info.port}/validateResource`, { method: "GET" });
    console.log(`Validator running (pid ${info.pid}, port ${info.port}, status ${res.status})`);
  } catch {
    console.log(`Validator process exists (pid ${info.pid}) but not responding on port ${info.port}`);
    process.exit(1);
  }
}

const command = process.argv[2] ?? "start";
switch (command) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "status": await status(); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Usage: bun run scripts/validator-server.ts [start|stop|status]`);
    process.exit(1);
}
