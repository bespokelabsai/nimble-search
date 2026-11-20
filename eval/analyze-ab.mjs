#!/usr/bin/env node
/**
 * Parses subagent transcript.jsonl files to produce an exact, auditable
 * Head-to-Head A/B report: accuracy, LLM turns, tool calls, exact LLM tokens
 * (uncached input, cached input, output), tool-output context bytes,
 * wall-clock latency (including real measured Nimble API latency), and cost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const manifestPath = process.argv[2] ?? "/tmp/nimble-eval-runs/ab-manifest.json";
const tasksPath = process.argv[3] ?? path.resolve("eval", "hono-tasks.json");
const retrievalPath = process.argv[4] ?? "/tmp/nimble-eval-runs/retrieval-results.json";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const dataset = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
const retrieval = JSON.parse(fs.readFileSync(retrievalPath, "utf8"));

const expectedByTask = new Map(dataset.tasks.map((t) => [t.id, t]));
const retrievalByArmTask = new Map();
for (const [arm, rows] of Object.entries(retrieval.arms)) {
  for (const row of rows) {
    retrievalByArmTask.set(`${arm}:${row.taskId}`, row);
  }
}

function parseTranscript(convId, armKey, taskId) {
  const transcriptPath = path.join(
    os.homedir(),
    ".gemini",
    "antigravity",
    "brain",
    convId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
  const rawLines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
  const steps = rawLines.map((l) => JSON.parse(l));

  let turns = 0;
  let searchReadToolCalls = 0;
  let grepFindCalls = 0;
  let nimbleCalls = 0;
  let readFileCalls = 0;
  let toolOutputChars = 0;
  let llmInputTokens = 0;
  let llmCacheReadTokens = 0;
  let llmOutputTokens = 0;
  let finalAnswerText = "";
  let firstStepMs = null;
  let lastSearchDoneMs = null;

  for (const step of steps) {
    const stepMs = step.created_at ? Date.parse(step.created_at) : NaN;
    if (Number.isFinite(stepMs)) {
      if (firstStepMs === null) firstStepMs = stepMs;
      lastSearchDoneMs = stepMs;
    }

    if (step.type === "PLANNER_RESPONSE") {
      llmInputTokens += step.input_tokens ?? 0;
      llmCacheReadTokens += step.cache_read_tokens ?? 0;
      llmOutputTokens += step.output_tokens ?? 0;

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      // Only count turns that do actual exploration/answering (exclude the subagent boilerplate final ack after send_message)
      const isOnlyFinalEchoAfterSend =
        calls.length === 0 && finalAnswerText.length > 0;
      if (!isOnlyFinalEchoAfterSend) {
        turns += 1;
      }

      for (const tc of calls) {
        const name = tc.name ?? "";
        const argsStr = JSON.stringify(tc.args ?? tc.arguments ?? {});
        if (name === "send_message") {
          const msgRaw = tc.args?.Message ?? tc.arguments?.Message ?? "";
          if (typeof msgRaw === "string" && msgRaw.trim()) {
            // Args in transcript may be JSON-encoded strings
            try {
              finalAnswerText = JSON.parse(msgRaw);
            } catch {
              finalAnswerText = msgRaw;
            }
          }
          continue;
        }
        searchReadToolCalls += 1;
        if (name === "read_file") {
          readFileCalls += 1;
        } else if (name === "run_command") {
          if (argsStr.includes("nimble-tool.mjs")) {
            nimbleCalls += 1;
          } else {
            grepFindCalls += 1;
          }
        }
      }

      if (!finalAnswerText && typeof step.content === "string" && step.content.trim()) {
        finalAnswerText = step.content.trim();
      }
    } else if (step.type === "GENERIC" && typeof step.content === "string") {
      if (!step.content.includes("Message sent to ")) {
        toolOutputChars += step.content.length;
      }
    }
  }

  const repoPrefix = retrieval.repoDir ? `${retrieval.repoDir.replace(/\/+$/, "")}/` : "";
  let predictedFiles = [];
  const jsonMatch = String(finalAnswerText).match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.files)) {
        predictedFiles = parsed.files.map((f) => {
          let s = String(f);
          if (repoPrefix && s.startsWith(repoPrefix)) s = s.slice(repoPrefix.length);
          return s.replace(/^\.\//, "");
        });
      }
    } catch {
      predictedFiles = [];
    }
  }

  const task = expectedByTask.get(taskId);
  const expected = task.expectedFiles;
  const exactHit =
    expected.length === predictedFiles.length &&
    expected.every((f) => predictedFiles.includes(f));
  const recallHit = expected.every((f) => predictedFiles.includes(f));

  const agentDurationMs =
    firstStepMs !== null && lastSearchDoneMs !== null
      ? Math.max(0, lastSearchDoneMs - firstStepMs)
      : 0;

  const retRow = retrievalByArmTask.get(`${armKey}:${taskId}`);
  const addedNimbleLatencyMs = nimbleCalls > 0 && retRow ? retRow.durationMs * nimbleCalls : 0;
  const nimbleCostUsd = nimbleCalls > 0 && retRow ? retRow.costUsd * nimbleCalls : 0;
  const nimbleInputTokens = nimbleCalls > 0 && retRow ? retRow.inputTokens * nimbleCalls : 0;

  return {
    arm: armKey,
    taskId,
    category: task.category,
    convId,
    exactHit,
    recallHit,
    predictedFiles,
    expected,
    turns,
    totalToolCalls: searchReadToolCalls,
    grepFindCalls,
    nimbleCalls,
    readFileCalls,
    toolOutputChars,
    llmInputTokens,
    llmCacheReadTokens,
    llmTotalInputTokens: llmInputTokens + llmCacheReadTokens,
    llmOutputTokens,
    agentDurationMs,
    addedNimbleLatencyMs,
    totalDurationMs: agentDurationMs + addedNimbleLatencyMs,
    nimbleInputTokens,
    nimbleCostUsd,
  };
}

const allRows = [];
for (const entry of manifest.runs) {
  allRows.push(parseTranscript(entry.convId, entry.arm, entry.taskId));
}

const byArm = new Map();
for (const r of allRows) {
  const arr = byArm.get(r.arm) ?? [];
  arr.push(r);
  byArm.set(r.arm, arr);
}

const summary = [];
for (const [arm, rows] of byArm.entries()) {
  const avg = (fn) => rows.reduce((s, r) => s + fn(r), 0) / Math.max(1, rows.length);
  const conceptual = rows.filter((r) => r.category !== "exact-symbol");
  const avgC = (fn) => conceptual.reduce((s, r) => s + fn(r), 0) / Math.max(1, conceptual.length);
  summary.push({
    arm,
    tasks: rows.length,
    exactAccPct: +(avg((r) => (r.exactHit ? 1 : 0)) * 100).toFixed(1),
    avgTurns: +avg((r) => r.turns).toFixed(2),
    avgTools: +avg((r) => r.totalToolCalls).toFixed(2),
    avgGrep: +avg((r) => r.grepFindCalls).toFixed(2),
    avgNimble: +avg((r) => r.nimbleCalls).toFixed(2),
    avgRead: +avg((r) => r.readFileCalls).toFixed(2),
    avgNewInTok: Math.round(avg((r) => r.llmInputTokens)),
    avgOutTok: Math.round(avg((r) => r.llmOutputTokens)),
    avgCtxChars: Math.round(avg((r) => r.toolOutputChars)),
    avgAgentMs: Math.round(avg((r) => r.agentDurationMs)),
    avgTotalMs: Math.round(avg((r) => r.totalDurationMs)),
    totalNimbleCost: `$${rows.reduce((s, r) => s + r.nimbleCostUsd, 0).toFixed(4)}`,
    concAvgTools: +avgC((r) => r.totalToolCalls).toFixed(2),
    concAvgNewInTok: Math.round(avgC((r) => r.llmInputTokens)),
  });
}

console.log("=== HEAD-TO-HEAD AGENT A/B SUMMARY ===");
console.table(summary);

console.log("\n=== PER-TASK BREAKDOWN ===");
console.table(
  allRows.map((r) => ({
    arm: r.arm,
    task: r.taskId,
    hit: r.exactHit ? "PASS" : r.recallHit ? "SUP" : "FAIL",
    turns: r.turns,
    tools: `${r.totalToolCalls} (g:${r.grepFindCalls} n:${r.nimbleCalls} r:${r.readFileCalls})`,
    newInTok: r.llmInputTokens,
    outTok: r.llmOutputTokens,
    ctxChars: r.toolOutputChars,
    agentMs: r.agentDurationMs,
    totalMs: r.totalDurationMs,
    nimbleCost: `$${r.nimbleCostUsd.toFixed(4)}`,
  }))
);

fs.writeFileSync(
  "/tmp/nimble-eval-runs/ab-report.json",
  JSON.stringify({ summary, rows: allRows }, null, 2),
  "utf8"
);
