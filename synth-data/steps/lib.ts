/**
 * Shared utilities for step scripts
 */

import { $ } from "bun";
import { resolve, dirname } from "path";
import { mkdtemp, mkdir, appendFile } from "fs/promises";
import { tmpdir } from "os";

export const PIPELINE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

export type AgentCli = "claude" | "codex" | "copilot";

function getFlagValue(flag: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return undefined;
}

export function resolveAgentCli(argv = process.argv): AgentCli {
  const flagValue = getFlagValue("--agent-cli", argv)?.toLowerCase();
  if (flagValue === "claude" || flagValue === "codex" || flagValue === "copilot") return flagValue;
  if (argv.includes("--codex")) return "codex";
  if (argv.includes("--claude")) return "claude";
  if (argv.includes("--copilot")) return "copilot";

  const envValue = Bun.env.SYNTH_AGENT_CLI?.toLowerCase();
  if (envValue === "claude" || envValue === "codex" || envValue === "copilot") return envValue;

  return "claude";
}

function resolveCurrentStepKey(argv = process.argv): string | undefined {
  const scriptPath = argv[1] ?? "";
  const match = scriptPath.match(/(?:^|\/)(\d{2}-[a-z0-9-]+)\.ts$/i);
  return match ? `step-${match[1].toLowerCase()}` : undefined;
}

function stepEnvKey(stepKey: string): string {
  return `SYNTH_AGENT_MODEL_FOR_${stepKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function resolveCopilotModelName(model: string | undefined): string {
  if (!model) return "claude-opus-4.6";

  const normalized = model.toLowerCase();
  switch (normalized) {
    case "haiku":
    case "claude-haiku":
    case "claude-haiku-4.5":
      return "claude-haiku-4.5";
    case "sonnet":
    case "claude-sonnet":
    case "claude-sonnet-4.6":
      return "claude-sonnet-4.6";
    case "opus":
    case "claude-opus":
    case "claude-opus-4.6-fast":
    case "claude-opus-4.6":
      return "claude-opus-4.6";
    default:
      return model;
  }
}

function resolveDefaultAgentModel(agentCli: AgentCli): string {
  if (agentCli === "claude") return "opus";
  if (agentCli === "copilot") return "claude-opus-4.6";
  return "gpt-5.4";
}

function resolveAgentModel(agentCli: AgentCli, argv = process.argv): string | undefined {
  const stepKey = resolveCurrentStepKey(argv);
  const stepFlag = stepKey ? getFlagValue(`--agent-model-for-${stepKey}`, argv) : undefined;
  const stepEnv = stepKey ? Bun.env[stepEnvKey(stepKey)] : undefined;
  const override = getFlagValue("--agent-model", argv) ?? Bun.env.SYNTH_AGENT_MODEL;
  const selected = stepFlag ?? stepEnv ?? override ?? resolveDefaultAgentModel(agentCli);
  return agentCli === "copilot" ? resolveCopilotModelName(selected) : selected;
}

function resolveCodexReasoningEffort(argv = process.argv): string {
  return getFlagValue("--agent-reasoning-effort", argv)
    ?? Bun.env.SYNTH_AGENT_REASONING_EFFORT
    ?? "medium";
}

function wrapOutputSystemPrompt(systemPrompt: string, outputFile: string): string {
  return `${systemPrompt}\n\n---\n## Output Instructions\n\nWrite your final output to the file: ${outputFile}\n\nYou can use stdout for your thoughts, reasoning, and progress notes. The content in ${outputFile} is what will be used downstream.`;
}

async function prepareAgentLogs(opts: {
  agentCli: AgentCli;
  model?: string;
  workDir: string;
  systemPrompt: string;
  userMessage: string;
  outputFile: string;
}) {
  const logDir = `${PIPELINE_ROOT}/logs/agent-runs`;
  await mkdir(logDir, { recursive: true });

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.agentCli}-${Math.random().toString(36).slice(2, 8)}`;
  const base = `${logDir}/${stamp}`;
  const stdoutLog = `${base}.stdout.log`;
  const stderrLog = `${base}.stderr.log`;

  await Bun.write(`${base}.meta.json`, JSON.stringify({
    started_at: new Date().toISOString(),
    agent_cli: opts.agentCli,
    model: opts.model ?? null,
    work_dir: opts.workDir,
    output_file: opts.outputFile,
  }, null, 2));
  await Bun.write(`${base}.system.txt`, opts.systemPrompt);
  await Bun.write(`${base}.message.txt`, opts.userMessage);
  await Bun.write(stdoutLog, "");
  await Bun.write(stderrLog, "");

  return { base, stdoutLog, stderrLog };
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  logFile: string,
  mirror: NodeJS.WriteStream,
): Promise<string> {
  if (!stream) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    if (!text) continue;

    output += text;
    await appendFile(logFile, text);
    mirror.write(text);
  }

  const tail = decoder.decode();
  if (tail) {
    output += tail;
    await appendFile(logFile, tail);
    mirror.write(tail);
  }

  return output;
}

/**
 * Build CLI command, spawn the agent, pump streams, and check exit code.
 * Returns stdout/stderr text. Throws on non-zero exit.
 */
async function spawnAgent(opts: {
  agentCli: AgentCli;
  model: string | undefined;
  workDir: string;
  systemPrompt: string;
  userMessage: string;
  logs: { stdoutLog: string; stderrLog: string };
  label: string;
}): Promise<{ stdout: string; stderr: string }> {
  const { agentCli, model, workDir, logs, label } = opts;
  const sysFile = `${workDir}/system.txt`;
  const msgFile = `${workDir}/message.txt`;

  await Bun.write(sysFile, opts.systemPrompt);
  await Bun.write(msgFile, opts.userMessage);

  let cmd: string[];
  let stdin: Parameters<typeof Bun.spawn>[0] extends { stdin?: infer S } ? S : never;

  if (agentCli === "claude") {
    cmd = [
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--system-prompt",
      await Bun.file(sysFile).text(),
    ];
    if (model) cmd.push("--model", model);
    stdin = Bun.file(msgFile);
  } else {
    // Copilot and Codex get a combined prompt
    const combinedPrompt = [
      "Follow the system instructions exactly.",
      "",
      "## System Instructions",
      opts.systemPrompt,
      "",
      "## User Request",
      opts.userMessage,
    ].join("\n");
    await Bun.write(msgFile, combinedPrompt);

    if (agentCli === "copilot") {
      cmd = [
        "copilot",
        "-p",
        combinedPrompt,
        "--yolo",
        "--no-ask-user",
        "--stream",
        "off",
        "--no-color",
      ];
      if (model) cmd.push("--model", model);
      stdin = undefined;
    } else {
      // codex
      cmd = [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "-c",
        `model_reasoning_effort="${resolveCodexReasoningEffort()}"`,
        "-C",
        workDir,
      ];
      if (model) cmd.push("-m", model);
      cmd.push("-");
      stdin = Bun.file(msgFile);
    }
  }

  const proc = Bun.spawn({
    cmd,
    cwd: workDir,
    stdin: stdin as any,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdoutPromise = pumpStream(proc.stdout, logs.stdoutLog, process.stdout);
  const stderrPromise = pumpStream(proc.stderr, logs.stderrLog, process.stderr);
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    throw new Error(
      `[${label}:${agentCli}] exited with code ${exitCode}\n`
      + `workdir: ${workDir}\n`
      + `logs:\nstdout=${logs.stdoutLog}\nstderr=${logs.stderrLog}\n`
      + `stdout:\n${stdout.slice(0, 1000)}\n`
      + `stderr:\n${stderr.slice(0, 1000)}`
    );
  }

  return { stdout, stderr };
}

/**
 * Call the configured agent CLI with a system prompt and user message.
 * The agent writes its output to a designated file; this function returns that file's contents.
 * The temp workdir is cleaned up automatically.
 */
export async function callAgent(opts: {
  systemPrompt: string;
  userMessage: string;
  outputFileName?: string;
}): Promise<string> {
  const agentCli = resolveAgentCli();
  if ("model" in (opts as Record<string, unknown>)) {
    throw new Error("Per-call model pinning is disabled. Use --agent-model or --agent-model-for-step-XX-name instead.");
  }
  const model = resolveAgentModel(agentCli);

  const workDir = await mkdtemp(`${tmpdir()}/synth-agent-`);
  const outputFile = `${workDir}/${opts.outputFileName ?? "output.txt"}`;
  const wrappedSystem = wrapOutputSystemPrompt(opts.systemPrompt, outputFile);
  const logs = await prepareAgentLogs({
    agentCli,
    model,
    workDir,
    systemPrompt: wrappedSystem,
    userMessage: opts.userMessage,
    outputFile,
  });

  try {
    await spawnAgent({
      agentCli,
      model,
      workDir,
      systemPrompt: wrappedSystem,
      userMessage: opts.userMessage,
      logs,
      label: "callAgent",
    });

    if (await Bun.file(outputFile).exists()) {
      return await Bun.file(outputFile).text();
    }

    throw new Error(
      `[callAgent:${agentCli}] Subprocess completed but did not write output file: ${outputFile}\n`
      + `logs:\nstdout=${logs.stdoutLog}\nstderr=${logs.stderrLog}`
    );
  } finally {
    try { await $`rm -rf ${workDir}`.quiet(); } catch {}
  }
}

// Back-compat for older imports while the repo migrates to callAgent.
export const callClaude = callAgent;

/**
 * Call the configured agent CLI, returning the workdir path instead of file contents.
 *
 * The agent writes files directly to the workdir (e.g., a `resources/` subdirectory).
 * The caller reads the files it needs and is responsible for cleanup via rm -rf.
 * On agent failure, the workdir is preserved for debugging.
 */
export async function callAgentWorkdir(opts: {
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const agentCli = resolveAgentCli();
  const model = resolveAgentModel(agentCli);

  const workDir = await mkdtemp(`${tmpdir()}/synth-agent-`);
  const logs = await prepareAgentLogs({
    agentCli,
    model,
    workDir,
    systemPrompt: opts.systemPrompt,
    userMessage: opts.userMessage,
    outputFile: "(workdir mode)",
  });

  await spawnAgent({
    agentCli,
    model,
    workDir,
    systemPrompt: opts.systemPrompt,
    userMessage: opts.userMessage,
    logs,
    label: "callAgentWorkdir",
  });

  return workDir;
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
