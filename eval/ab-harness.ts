/**
 * Standalone Head-to-Head Agent A/B Evaluation Harness.
 * Compares Control (grep + glob + list_dir + read_file) vs Treatment (+ nimble-search)
 * using live Anthropic (Claude) or OpenAI (Codex/GPT) tool-calling APIs.
 *
 * Usage:
 *   node dist-eval/eval/ab-harness.js \
 *     --provider anthropic \
 *     --model claude-sonnet-4-20250514 \
 *     --repo /tmp/nimble-eval-repos/hono \
 *     --tasks eval/hono-tasks.json
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NimbleClient } from "../src/nimble/client.js";
import { formatSearchResultsText } from "../src/search/format.js";
import { searchCodebase, type SearchMode } from "../src/search/pipeline.js";
import type { EvalTask } from "./run-retrieval.js";

const execFileAsync = promisify(execFile);

interface ToolExecutionResult {
  output: string;
  nimbleCostUsd?: number;
  nimbleLatencyMs?: number;
}

async function runGrep(repoDir: string, pattern: string, subpath?: string): Promise<string> {
  const target = subpath ? path.resolve(repoDir, subpath) : repoDir;
  const relTarget = path.relative(repoDir, target);
  if (relTarget.startsWith("..")) return "Error: subpath escapes repo root";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "grep", "-n", "-i", "-E", pattern, "--", relTarget || "."],
      { maxBuffer: 2 * 1024 * 1024 }
    );
    const lines = stdout.trim().split("\n");
    if (lines.length > 80) {
      return `${lines.slice(0, 80).join("\n")}\n... (${lines.length - 80} more matches truncated)`;
    }
    return stdout.trim() || "(no matches)";
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    if (e.code === 1) return "(no matches)";
    return `grep error: ${e.stderr || String(err)}`;
  }
}

async function runGlob(repoDir: string, pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "ls-files"], {
      maxBuffer: 2 * 1024 * 1024,
    });
    const re = new RegExp(
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "."),
      "i"
    );
    const matches = stdout
      .split("\n")
      .filter((f) => f && re.test(f));
    if (matches.length > 100) {
      return `${matches.slice(0, 100).join("\n")}\n... (${matches.length - 100} more files)`;
    }
    return matches.join("\n") || "(no matching files)";
  } catch (err) {
    return `glob error: ${String(err)}`;
  }
}

async function runReadFile(
  repoDir: string,
  relPath: string,
  startLine = 1,
  endLine = 160
): Promise<string> {
  const abs = path.resolve(repoDir, relPath);
  if (path.relative(repoDir, abs).startsWith("..")) return "Error: path escapes repo root";
  try {
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split("\n");
    const s = Math.max(1, startLine);
    const e = Math.min(lines.length, Math.max(s, endLine));
    const slice = lines.slice(s - 1, e).map((l, idx) => `${s + idx}: ${l}`);
    return `File: ${relPath} (showing lines ${s}-${e} of ${lines.length})\n${slice.join("\n")}`;
  } catch (err) {
    return `read_file error: ${String(err)}`;
  }
}

async function executeTool(
  repoDir: string,
  name: string,
  input: Record<string, unknown>,
  nimbleMode: SearchMode
): Promise<ToolExecutionResult> {
  if (name === "grep") {
    return {
      output: await runGrep(
        repoDir,
        String(input.pattern ?? ""),
        typeof input.subpath === "string" ? input.subpath : undefined
      ),
    };
  }
  if (name === "glob") {
    return { output: await runGlob(repoDir, String(input.pattern ?? "*")) };
  }
  if (name === "read_file") {
    return {
      output: await runReadFile(
        repoDir,
        String(input.path ?? ""),
        typeof input.start_line === "number" ? input.start_line : 1,
        typeof input.end_line === "number" ? input.end_line : 160
      ),
    };
  }
  if (name === "search_files") {
    const client = new NimbleClient({ concurrency: 12 });
    const res = await searchCodebase(client, {
      query: String(input.query ?? ""),
      rootDir: repoDir,
      subpath: typeof input.subpath === "string" ? input.subpath : undefined,
      topK: typeof input.top_k === "number" ? input.top_k : 8,
      mode: (input.mode as SearchMode | undefined) ?? nimbleMode,
    });
    return {
      output: formatSearchResultsText(res),
      nimbleCostUsd: res.stats.usage.estimatedCostUsd,
      nimbleLatencyMs: res.stats.durationMs,
    };
  }
  return { output: `Unknown tool: ${name}` };
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

function buildToolSchemas(includeNimble: boolean): ToolDef[] {
  const base: ToolDef[] = [
    {
      name: "grep",
      description: "Regex case-insensitive search across repository files (git grep).",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Extended regex pattern" },
          subpath: { type: "string", description: "Optional subdirectory" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "glob",
      description: "Find file paths matching a glob pattern (e.g. 'src/utils/*.ts').",
      input_schema: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
    {
      name: "read_file",
      description: "Read line-numbered contents of a repository file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from repo root" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
    },
  ];
  if (includeNimble) {
    base.unshift({
      name: "search_files",
      description:
        "Semantically search repository files from a natural-language description of behavior using Nimble. Prefer this over grep for conceptual/behavioral queries; still use grep for exact identifiers or error codes.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language behavioral description" },
          subpath: { type: "string" },
          top_k: { type: "number" },
          mode: { type: "string", enum: ["balanced", "fast", "deep"] },
        } as Record<string, unknown>,
        required: ["query"],
      },
    });
  }
  return base;
}

interface AgentRunSummary {
  taskId: string;
  arm: string;
  hit: boolean;
  predictedFiles: string[];
  expectedFiles: string[];
  turns: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  llmInputTokens: number;
  llmOutputTokens: number;
  nimbleCostUsd: number;
  durationMs: number;
}

async function runAnthropicAgent(
  model: string,
  repoDir: string,
  task: EvalTask,
  armName: string,
  includeNimble: boolean,
  nimbleMode: SearchMode
): Promise<AgentRunSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const system =
    "You are a code localization agent inspecting an unfamiliar repository. " +
    "You MUST verify candidate files with read_file before answering. Never guess paths from memory. " +
    (includeNimble
      ? "Use search_files first for conceptual/behavioral queries and grep for exact symbol/error-code lookups. "
      : "") +
    'When verified, reply with ONLY JSON: {"files": ["relative/path.ts"], "reason": "short explanation"}';

  const tools = buildToolSchemas(includeNimble);
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: task.prompt }];
  const startedAt = Date.now();
  let turns = 0;
  let toolCalls = 0;
  const toolBreakdown: Record<string, number> = {};
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let nimbleCostUsd = 0;
  let finalText = "";

  for (let step = 0; step < 12; step++) {
    turns += 1;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0,
        system,
        tools,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    llmInputTokens += data.usage?.input_tokens ?? 0;
    llmOutputTokens += data.usage?.output_tokens ?? 0;
    messages.push({ role: "assistant", content: data.content });

    const uses = data.content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) {
      finalText = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      break;
    }

    const toolResults = [];
    for (const u of uses) {
      const name = u.name ?? "";
      toolCalls += 1;
      toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
      const execRes = await executeTool(repoDir, name, u.input ?? {}, nimbleMode);
      nimbleCostUsd += execRes.nimbleCostUsd ?? 0;
      toolResults.push({
        type: "tool_result",
        tool_use_id: u.id,
        content: execRes.output,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  let predictedFiles: string[] = [];
  const jsonMatch = finalText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { files?: string[] };
      predictedFiles = Array.isArray(parsed.files) ? parsed.files : [];
    } catch {
      predictedFiles = [];
    }
  }
  const hit = task.expectedFiles.every((exp) => predictedFiles.includes(exp));
  return {
    taskId: task.id,
    arm: armName,
    hit,
    predictedFiles,
    expectedFiles: task.expectedFiles,
    turns,
    toolCalls,
    toolBreakdown,
    llmInputTokens,
    llmOutputTokens,
    nimbleCostUsd,
    durationMs: Date.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
  };
  const model = getArg("--model", "claude-sonnet-4-20250514");
  const repoDir = getArg("--repo", "/tmp/nimble-eval-repos/hono");
  const tasksPath = getArg("--tasks", path.resolve("eval", "hono-tasks.json"));
  const dataset = JSON.parse(await fs.readFile(tasksPath, "utf8")) as { tasks: EvalTask[] };

  const results: AgentRunSummary[] = [];
  for (const task of dataset.tasks) {
    results.push(await runAnthropicAgent(model, repoDir, task, "grep-only", false, "balanced"));
    results.push(await runAnthropicAgent(model, repoDir, task, "nimble-balanced", true, "balanced"));
  }
  console.log(JSON.stringify(results, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
