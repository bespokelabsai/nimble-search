import fs from "node:fs/promises";
import path from "node:path";
import { NimbleClient } from "../src/nimble/client.js";
import { buildFileCards } from "../src/repo/cards.js";
import { rankCardsLexically } from "../src/repo/lexical.js";
import { walkRepoFiles } from "../src/repo/walker.js";
import { formatSearchResultsText } from "../src/search/format.js";
import { searchCodebase, type SearchResponse } from "../src/search/pipeline.js";

export interface EvalTask {
  id: string;
  category: string;
  query: string;
  prompt: string;
  expectedFiles: string[];
}

interface TaskDataset {
  repo: string;
  description: string;
  tasks: EvalTask[];
}

interface ArmTaskMetric {
  taskId: string;
  category: string;
  expected: string[];
  topPaths: string[];
  rank: number | null; // 1-based rank of first expected file, or null if not in top 10
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
  durationMs: number;
  inputTokens: number;
  costUsd: number;
  usedDirectoryTriage: boolean;
  formattedOutput: string;
}

function scoreRanking(expected: string[], rankedPaths: string[]): {
  rank: number | null;
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
} {
  const expSet = new Set(expected);
  let bestRank: number | null = null;
  for (let i = 0; i < rankedPaths.length; i++) {
    if (expSet.has(rankedPaths[i]!)) {
      bestRank = i + 1;
      break;
    }
  }
  const hitAt = (k: number) =>
    expected.filter((f) => rankedPaths.slice(0, k).includes(f)).length / expected.length;
  return {
    rank: bestRank,
    recall1: hitAt(1),
    recall3: hitAt(3),
    recall5: hitAt(5),
    mrr: bestRank ? 1 / bestRank : 0,
  };
}

function summarizeArm(name: string, metrics: ArmTaskMetric[]) {
  const avg = (fn: (m: ArmTaskMetric) => number) =>
    metrics.reduce((s, m) => s + fn(m), 0) / Math.max(1, metrics.length);
  const sortedLat = [...metrics].map((m) => m.durationMs).sort((a, b) => a - b);
  const p50 = sortedLat[Math.floor(sortedLat.length * 0.5)] ?? 0;
  const p95 = sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))] ?? 0;
  return {
    arm: name,
    tasks: metrics.length,
    recall1: +(avg((m) => m.recall1) * 100).toFixed(1),
    recall3: +(avg((m) => m.recall3) * 100).toFixed(1),
    recall5: +(avg((m) => m.recall5) * 100).toFixed(1),
    mrr: +avg((m) => m.mrr).toFixed(3),
    avgLatencyMs: Math.round(avg((m) => m.durationMs)),
    p50LatencyMs: Math.round(p50),
    p95LatencyMs: Math.round(p95),
    totalCostUsd: +metrics.reduce((s, m) => s + m.costUsd, 0).toFixed(5),
    avgCostUsd: +avg((m) => m.costUsd).toFixed(5),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipFullScan = args.includes("--skip-full-scan");
  const positional = args.filter((a) => !a.startsWith("--"));
  const repoDir = positional[0] ?? "/tmp/nimble-eval-repos/hono";
  const datasetPath = positional[1] ?? path.resolve("eval", "hono-tasks.json");
  const outPath = positional[2] ?? "/tmp/nimble-eval-runs/retrieval-results.json";

  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8")) as TaskDataset;
  const files = await walkRepoFiles({ rootDir: repoDir });
  const cardBuild = await buildFileCards(repoDir, files, { useCache: true });

  console.log(
    `Loaded ${dataset.tasks.length} tasks against ${repoDir} (${cardBuild.cards.length} searchable files)`
  );

  // 1) Local BM25 Lexical Baseline
  const bm25Metrics: ArmTaskMetric[] = [];
  for (const task of dataset.tasks) {
    const t0 = Date.now();
    const ranked = rankCardsLexically(task.query, cardBuild.cards, 10);
    const durationMs = Date.now() - t0;
    const topPaths = ranked.map((r) => r.card.relPath);
    const scores = scoreRanking(task.expectedFiles, topPaths);
    bm25Metrics.push({
      taskId: task.id,
      category: task.category,
      expected: task.expectedFiles,
      topPaths,
      ...scores,
      durationMs,
      inputTokens: 0,
      costUsd: 0,
      usedDirectoryTriage: false,
      formattedOutput: topPaths.map((p, i) => `${i + 1}. ${p}`).join("\n"),
    });
  }

  // Helper to run a Nimble arm across all tasks
  async function runNimbleArm(
    label: string,
    opts: { mode: "fast" | "balanced"; dirTriageThreshold?: number }
  ): Promise<{ metrics: ArmTaskMetric[]; rawByTask: Record<string, SearchResponse> }> {
    const client = new NimbleClient({ concurrency: 16 });
    const metrics: ArmTaskMetric[] = [];
    const rawByTask: Record<string, SearchResponse> = {};

    for (const task of dataset.tasks) {
      const res = await searchCodebase(client, {
        query: task.query,
        rootDir: repoDir,
        topK: 10,
        mode: opts.mode,
        minScore: 0.1,
        dirTriageThreshold: opts.dirTriageThreshold,
        useCache: true,
      });
      rawByTask[task.id] = res;
      const topPaths = res.results.map((r) => r.path);
      const scores = scoreRanking(task.expectedFiles, topPaths);
      metrics.push({
        taskId: task.id,
        category: task.category,
        expected: task.expectedFiles,
        topPaths,
        ...scores,
        durationMs: res.stats.durationMs,
        inputTokens: res.stats.usage.inputTokens,
        costUsd: res.stats.usage.estimatedCostUsd,
        usedDirectoryTriage: res.stats.usedDirectoryTriage,
        formattedOutput: formatSearchResultsText(res),
      });
      console.log(
        `[${label}] ${task.id.padEnd(30)} rank=${String(scores.rank ?? "MISS").padEnd(4)} top1=${(topPaths[0] ?? "-").padEnd(36)} ${res.stats.durationMs}ms $${res.stats.usage.estimatedCostUsd.toFixed(4)}`
      );
    }
    return { metrics, rawByTask };
  }

  const fastArm = await runNimbleArm("nimble-fast", { mode: "fast" });
  const balancedArm = await runNimbleArm("nimble-balanced", { mode: "balanced" });

  const summaries = [
    summarizeArm("bm25-lexical", bm25Metrics),
    summarizeArm("nimble-fast", fastArm.metrics),
    summarizeArm("nimble-balanced", balancedArm.metrics),
  ];
  const arms: Record<string, ArmTaskMetric[]> = {
    bm25: bm25Metrics,
    fast: fastArm.metrics,
    balanced: balancedArm.metrics,
  };

  if (!skipFullScan && cardBuild.cards.length <= 1500) {
    const fastFullArm = await runNimbleArm("nimble-fast-full", {
      mode: "fast",
      dirTriageThreshold: 10_000,
    });
    const noTriageArm = await runNimbleArm("nimble-balanced-full", {
      mode: "balanced",
      dirTriageThreshold: 10_000,
    });
    summaries.push(
      summarizeArm("nimble-fast (full-scan)", fastFullArm.metrics),
      summarizeArm("nimble-balanced (full-scan)", noTriageArm.metrics)
    );
    arms.fastFull = fastFullArm.metrics;
    arms.balancedFull = noTriageArm.metrics;
  }

  console.log("\n=== RETRIEVAL SUMMARY ===");
  console.table(summaries);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        repoDir,
        fileCount: cardBuild.cards.length,
        timestamp: new Date().toISOString(),
        summaries,
        arms,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Saved full retrieval telemetry to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
