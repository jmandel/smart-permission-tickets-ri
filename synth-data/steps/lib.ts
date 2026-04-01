/**
 * Shared utilities for step scripts
 */

import { $ } from "bun";
import { resolve, dirname } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";

export const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Call Claude CLI in print mode with a system prompt and user message.
 * Writes prompts to temp files to avoid shell argument length limits.
 */
export async function callClaude(opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;
}): Promise<string> {
  const model = opts.model ?? "sonnet";

  // Create isolated temp dir:
  // 1. Prevents CLAUDE.md auto-discovery from finding our project's CLAUDE.md
  // 2. Gives the subprocess a designated output file to write to
  //    (so stdout can carry thoughts/reasoning and content goes to the file)
  const workDir = await mkdtemp(`${tmpdir()}/synth-claude-`);
  const sysFile = `${workDir}/system.txt`;
  const msgFile = `${workDir}/message.txt`;
  const outputFile = `${workDir}/output.md`;

  const wrappedSystem = `${opts.systemPrompt}\n\n---\n## Output Instructions\n\nWrite your final output to the file: ${outputFile}\n\nYou can use stdout for your thoughts, reasoning, and progress notes. The content in ${outputFile} is what will be used downstream.`;

  await Bun.write(sysFile, wrappedSystem);
  await Bun.write(msgFile, opts.userMessage);

  try {
    // cd into isolated temp dir; --dangerously-skip-permissions for non-interactive
    const proc = await $`cd ${workDir} && cat ${msgFile} | claude -p --model ${model} --dangerously-skip-permissions --system-prompt "$(cat ${sysFile})"`.quiet();

    // Read the output file the subprocess wrote
    if (await Bun.file(outputFile).exists()) {
      return await Bun.file(outputFile).text();
    }

    // No fallback — if the subprocess didn't write the output file, that's a hard error
    throw new Error(`[callClaude] Subprocess completed but did not write output file: ${outputFile}\nstdout was: ${proc.text().slice(0, 500)}`);
  } finally {
    try { await $`rm -rf ${workDir}`.quiet(); } catch {}
  }
}

/**
 * Parse encounter headers from encounters.md.
 * Looks for ### headers containing a 4-digit year.
 */
export function parseEncounters(text: string): Array<{ index: number; heading: string; text: string }> {
  const encounters: Array<{ index: number; heading: string; text: string }> = [];
  const lines = text.split("\n");
  let current: { index: number; heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^#{3,4}\s+(.+)/);
    if (headerMatch && /\d{4}/.test(headerMatch[1])) {
      if (current) {
        encounters.push({ index: current.index, heading: current.heading, text: current.lines.join("\n") });
      }
      current = { index: encounters.length, heading: headerMatch[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    encounters.push({ index: current.index, heading: current.heading, text: current.lines.join("\n") });
  }
  return encounters;
}

/** Simple concurrency limiter */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= max) {
      await new Promise<void>(r => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** Pad encounter index to 3 digits */
export function encId(index: number): string {
  return String(index).padStart(3, "0");
}
