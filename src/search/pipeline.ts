import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChoiceAnswer,
  NimbleClientInterface,
  NimbleQuestion,
  ScoreAnswer,
  UsageTotals,
} from "../nimble/types.js";
import {
  buildDirectoryCards,
  buildFileCards,
  type DirectoryCard,
  type FileCard,
} from "../repo/cards.js";
import { buildSmartFileExcerpt, rankCardsLexically } from "../repo/lexical.js";
import { walkRepoFiles } from "../repo/walker.js";
import {
  buildCardQuestion,
  buildCardTriageState,
  buildContentQuestions,
  buildContentVerificationState,
  buildDirectoryQuestion,
  buildDirectoryTriageState,
  CARD_RUBRIC,
  CONTENT_RUBRIC,
  DIRECTORY_RUBRIC,
  type FileRole,
} from "./prompts.js";

export type SearchMode = "fast" | "balanced" | "deep";

export interface SearchOptions {
  query: string;
  rootDir: string;
  subpath?: string;
  topK?: number;
  mode?: SearchMode;
  extensions?: string[];
  roles?: FileRole[];
  minScore?: number;
  useCache?: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  batchSize?: number;
  dirTriageThreshold?: number;
  maxStage1Files?: number;
  lexicalBoostCount?: number;
  rerankCount?: number;
  maxFileChars?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stage: "walk" | "cards" | "dir-triage" | "stage1" | "stage2" | "done";
  message: string;
}

export interface SearchMatch {
  path: string;
  score: number; // 0..1 normalized final score
  confidence: number; // 0..1 confidence from highest completed stage
  stage1Score: number; // 0..1
  stage2Score?: number; // 0..1 when Stage 2 ran
  role?: FileRole;
  roleConfidence?: number;
  language: string;
  lines: number;
  summary: string;
  symbols: string[];
  verified: boolean;
}

export interface SearchStats {
  totalFilesScanned: number;
  skippedBinary: number;
  cacheHits: number;
  cacheMisses: number;
  usedDirectoryTriage: boolean;
  directoriesScored: number;
  stage1Candidates: number;
  stage2Verified: number;
  durationMs: number;
  stageDurationsMs: {
    scanAndCards: number;
    directoryTriage: number;
    stage1: number;
    stage2: number;
  };
  usage: UsageTotals;
}

export interface SearchResponse {
  query: string;
  rootDir: string;
  mode: SearchMode;
  model: string;
  results: SearchMatch[];
  belowThresholdCount: number;
  topBelowThreshold?: { path: string; score: number };
  stats: SearchStats;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_MIN_SCORE = 0.25;
const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_DIR_TRIAGE_THRESHOLD = 800;
const DEFAULT_MAX_STAGE1_FILES = 420;
const DEFAULT_LEXICAL_BOOST = 80;
const DEFAULT_MAX_FILE_CHARS = 24_000;

/**
 * Pick a batch size that balances parallelism (low latency on small/medium repos)
 * with high request packing (up to 32-64 questions/request on larger repos).
 */
function chooseAdaptiveBatchSize(
  itemCount: number,
  concurrency: number,
  explicitBatchSize?: number
): number {
  if (explicitBatchSize !== undefined) {
    return Math.max(1, Math.min(64, explicitBatchSize));
  }
  const targetParallelBatches = Math.max(2, Math.min(concurrency, 12));
  const balanced = Math.ceil(itemCount / targetParallelBatches);
  return Math.max(8, Math.min(DEFAULT_MAX_BATCH_SIZE, balanced));
}

function normalizeScore(answer: ScoreAnswer | undefined, rubricLength: number): {
  score: number;
  confidence: number;
} {
  if (!answer || answer.type !== "score") {
    return { score: 0, confidence: 0 };
  }
  const maxVal = Math.max(1, rubricLength - 1);
  const clamped = Math.max(0, Math.min(1, answer.score / maxVal));
  return {
    score: clamped,
    confidence: Math.max(0, Math.min(1, answer.confidence ?? 0)),
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function scoreDirectoryBuckets(
  client: NimbleClientInterface,
  query: string,
  repoName: string,
  dirCards: DirectoryCard[],
  batchSize: number,
  signal?: AbortSignal
): Promise<Array<{ dirCard: DirectoryCard; score: number }>> {
  const state = buildDirectoryTriageState(query, repoName);
  const batches = chunkArray(dirCards, Math.min(64, batchSize));

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const questions: Record<string, NimbleQuestion> = {};
      batch.forEach((dc, idx) => {
        questions[`d${idx}`] = buildDirectoryQuestion(dc);
      });
      const res = await client.evaluate(state, questions, signal);
      return batch.map((dc, idx) => {
        const ans = res.answers[`d${idx}`] as ScoreAnswer | undefined;
        const { score } = normalizeScore(ans, DIRECTORY_RUBRIC.length);
        return { dirCard: dc, score };
      });
    })
  );

  const flat = batchResults.flat();
  flat.sort((a, b) => b.score - a.score || a.dirCard.dir.localeCompare(b.dirCard.dir));
  return flat;
}

async function scoreFileCards(
  client: NimbleClientInterface,
  query: string,
  repoName: string,
  cards: FileCard[],
  batchSize: number,
  signal?: AbortSignal
): Promise<Array<{ card: FileCard; score: number; confidence: number }>> {
  const state = buildCardTriageState(query, repoName);
  const batches = chunkArray(cards, Math.min(64, batchSize));

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const questions: Record<string, NimbleQuestion> = {};
      batch.forEach((card, idx) => {
        questions[`f${idx}`] = buildCardQuestion(card);
      });
      const res = await client.evaluate(state, questions, signal);
      return batch.map((card, idx) => {
        const ans = res.answers[`f${idx}`] as ScoreAnswer | undefined;
        const { score, confidence } = normalizeScore(ans, CARD_RUBRIC.length);
        return { card, score, confidence };
      });
    })
  );

  return batchResults.flat();
}

export async function searchCodebase(
  client: NimbleClientInterface,
  options: SearchOptions
): Promise<SearchResponse> {
  const startedAt = Date.now();
  const rootDir = path.resolve(options.rootDir);
  const repoName = path.basename(rootDir);
  const mode: SearchMode = options.mode ?? "balanced";
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const dirTriageThreshold = options.dirTriageThreshold ?? DEFAULT_DIR_TRIAGE_THRESHOLD;
  const maxStage1Files = options.maxStage1Files ?? DEFAULT_MAX_STAGE1_FILES;
  const lexicalBoostCount = options.lexicalBoostCount ?? DEFAULT_LEXICAL_BOOST;
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const rerankCount =
    options.rerankCount ??
    (mode === "fast"
      ? 0
      : mode === "deep"
        ? Math.max(24, topK + 8)
        : Math.min(12, Math.max(8, topK)));

  const query = options.query.trim();
  if (!query) {
    throw new Error("Search query must be a non-empty description.");
  }

  const usageBefore = client.getUsage();

  // Stage 0: Walk files and build/load cached file cards
  const t0 = Date.now();
  options.onProgress?.({ stage: "walk", message: `Scanning ${rootDir}...` });
  const walkedFiles = await walkRepoFiles({
    rootDir,
    subpath: options.subpath,
    extensions: options.extensions,
    includeHidden: options.includeHidden,
    respectGitignore: options.respectGitignore,
  });

  const absPathByRel = new Map<string, string>();
  for (const wf of walkedFiles) {
    absPathByRel.set(wf.relPath, wf.absPath);
  }

  options.onProgress?.({
    stage: "cards",
    message: `Extracting file cards for ${walkedFiles.length} files...`,
  });
  const cardBuild = await buildFileCards(rootDir, walkedFiles, {
    useCache: options.useCache ?? true,
  });
  const scanAndCardsMs = Date.now() - t0;

  if (cardBuild.cards.length === 0) {
    const usageAfter = client.getUsage();
    return {
      query,
      rootDir,
      mode,
      model: client.model,
      results: [],
      belowThresholdCount: 0,
      stats: {
        totalFilesScanned: 0,
        skippedBinary: cardBuild.skippedBinary,
        cacheHits: cardBuild.cacheHits,
        cacheMisses: cardBuild.cacheMisses,
        usedDirectoryTriage: false,
        directoriesScored: 0,
        stage1Candidates: 0,
        stage2Verified: 0,
        durationMs: Date.now() - startedAt,
        stageDurationsMs: {
          scanAndCards: scanAndCardsMs,
          directoryTriage: 0,
          stage1: 0,
          stage2: 0,
        },
        usage: diffUsage(usageBefore, usageAfter),
      },
    };
  }

  // Stage 0.5: Optional hierarchical directory triage for large repos
  let stage1Pool: FileCard[] = cardBuild.cards;
  let usedDirectoryTriage = false;
  let directoriesScored = 0;
  let directoryTriageMs = 0;

  if (cardBuild.cards.length > dirTriageThreshold) {
    const tDir = Date.now();
    usedDirectoryTriage = true;
    const dirCards = buildDirectoryCards(cardBuild.cards, 256);
    directoriesScored = dirCards.length;
    options.onProgress?.({
      stage: "dir-triage",
      message: `Large repo (${cardBuild.cards.length} files): triaging ${dirCards.length} directories...`,
    });

    const dirBatchSize = chooseAdaptiveBatchSize(
      dirCards.length,
      client.concurrency,
      options.batchSize
    );
    const rankedDirs = await scoreDirectoryBuckets(
      client,
      query,
      repoName,
      dirCards,
      dirBatchSize,
      options.signal
    );

    const selected = new Map<string, FileCard>();

    // Pull files from top-scoring directories up to maxStage1Files.
    // Cap any single giant bucket at 120 files (implementation files are already ordered first)
    // so one huge folder can't crowd out the #2-#5 candidate directories.
    const perDirSoftCap = 120;
    for (let i = 0; i < rankedDirs.length; i++) {
      const entry = rankedDirs[i]!;
      if (i >= 5 && selected.size >= maxStage1Files) break;
      if (i >= 5 && entry.score < 0.15 && selected.size >= Math.min(120, maxStage1Files)) break;
      let addedFromDir = 0;
      for (const file of entry.dirCard.files) {
        if (addedFromDir >= perDirSoftCap && i > 0) break;
        if (selected.size >= maxStage1Files && i >= 5) break;
        if (!selected.has(file.relPath)) {
          selected.set(file.relPath, file);
          addedFromDir += 1;
        }
      }
    }

    // Union with fast repo-wide lexical recall so exact/near-exact term matches are never dropped
    const lexicalTop = rankCardsLexically(query, cardBuild.cards, lexicalBoostCount);
    for (const item of lexicalTop) {
      selected.set(item.card.relPath, item.card);
    }

    stage1Pool = Array.from(selected.values());
    directoryTriageMs = Date.now() - tDir;
  }

  // Compute subtle lexical tie-breaker scores for Stage 1 ordering
  const lexicalMap = new Map<string, number>();
  for (const item of rankCardsLexically(query, stage1Pool, Math.min(stage1Pool.length, 128))) {
    lexicalMap.set(item.card.relPath, item.score);
  }

  // Stage 1: Batched file card scoring
  const tStage1 = Date.now();
  const stage1BatchSize = chooseAdaptiveBatchSize(
    stage1Pool.length,
    client.concurrency,
    options.batchSize
  );
  options.onProgress?.({
    stage: "stage1",
    message: `Scoring ${stage1Pool.length} candidate file cards with Nimble...`,
  });
  const stage1Scored = await scoreFileCards(
    client,
    query,
    repoName,
    stage1Pool,
    stage1BatchSize,
    options.signal
  );
  stage1Scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-4) return b.score - a.score;
    const lexDiff = (lexicalMap.get(b.card.relPath) ?? 0) - (lexicalMap.get(a.card.relPath) ?? 0);
    if (Math.abs(lexDiff) > 1e-4) return lexDiff;
    return a.card.relPath.localeCompare(b.card.relPath);
  });
  const stage1Ms = Date.now() - tStage1;

  // Stage 2: Deep content verification on Top-K candidates
  const tStage2 = Date.now();
  const stage2Map = new Map<
    string,
    { score: number; confidence: number; role?: FileRole; roleConfidence?: number }
  >();
  let stage2Verified = 0;

  if (mode !== "fast" && rerankCount > 0 && stage1Scored.length > 0) {
    const minVerifyFloor = Math.min(4, stage1Scored.length);
    const toVerify = stage1Scored.slice(0, rerankCount).filter((item, idx) => {
      if (idx < minVerifyFloor) return true;
      return item.score >= 0.18;
    });

    options.onProgress?.({
      stage: "stage2",
      message: `Verifying source excerpts of top ${toVerify.length} files...`,
    });

    const contentQuestions = buildContentQuestions(query);

    await Promise.all(
      toVerify.map(async (item) => {
        const absPath = absPathByRel.get(item.card.relPath);
        if (!absPath) return;
        let rawContent: string;
        try {
          rawContent = await fs.readFile(absPath, "utf8");
        } catch {
          return;
        }
        const { excerpt, truncated } = buildSmartFileExcerpt(rawContent, query, maxFileChars);
        const state = buildContentVerificationState(item.card, excerpt, truncated);
        const res = await client.evaluate(state, contentQuestions, options.signal);

        const relAns = res.answers.relevance as ScoreAnswer | undefined;
        const roleAns = res.answers.role as ChoiceAnswer | undefined;
        const { score, confidence } = normalizeScore(relAns, CONTENT_RUBRIC.length);

        stage2Map.set(item.card.relPath, {
          score,
          confidence,
          role: roleAns?.type === "choice" ? (roleAns.choice as FileRole) : undefined,
          roleConfidence: roleAns?.type === "choice" ? roleAns.confidence : undefined,
        });
        stage2Verified += 1;
      })
    );
  }
  const stage2Ms = Date.now() - tStage2;

  // Assemble final ranked matches
  const allMatches: SearchMatch[] = stage1Scored.map((item) => {
    const s2 = stage2Map.get(item.card.relPath);
    const finalScore = s2 ? 0.85 * s2.score + 0.15 * item.score : item.score;
    return {
      path: item.card.relPath,
      score: round4(finalScore),
      confidence: round4(s2 ? s2.confidence : item.confidence),
      stage1Score: round4(item.score),
      stage2Score: s2 ? round4(s2.score) : undefined,
      role: s2?.role,
      roleConfidence: s2?.roleConfidence !== undefined ? round4(s2.roleConfidence) : undefined,
      language: item.card.language,
      lines: item.card.lines,
      summary: item.card.summary,
      symbols: item.card.symbols.slice(0, 8),
      verified: Boolean(s2),
    };
  });

  // Sort verified matches and high-score matches cleanly
  allMatches.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-4) return b.score - a.score;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  // Optional role filter (only meaningful when roles were classified)
  const roleSet =
    options.roles && options.roles.length > 0 ? new Set<FileRole>(options.roles) : null;
  const roleFiltered = roleSet
    ? allMatches.filter((m) => (m.role ? roleSet.has(m.role) : false))
    : allMatches;

  const passing = roleFiltered.filter((m) => m.score >= minScore);
  const below = roleFiltered.filter((m) => m.score < minScore);

  const usageAfter = client.getUsage();
  options.onProgress?.({ stage: "done", message: "Search complete." });

  return {
    query,
    rootDir,
    mode,
    model: client.model,
    results: passing.slice(0, topK),
    belowThresholdCount: below.length,
    topBelowThreshold:
      below[0] !== undefined ? { path: below[0].path, score: below[0].score } : undefined,
    stats: {
      totalFilesScanned: cardBuild.cards.length,
      skippedBinary: cardBuild.skippedBinary,
      cacheHits: cardBuild.cacheHits,
      cacheMisses: cardBuild.cacheMisses,
      usedDirectoryTriage,
      directoriesScored,
      stage1Candidates: stage1Pool.length,
      stage2Verified,
      durationMs: Date.now() - startedAt,
      stageDurationsMs: {
        scanAndCards: scanAndCardsMs,
        directoryTriage: directoryTriageMs,
        stage1: stage1Ms,
        stage2: stage2Ms,
      },
      usage: diffUsage(usageBefore, usageAfter),
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function diffUsage(before: UsageTotals, after: UsageTotals): UsageTotals {
  return {
    requests: after.requests - before.requests,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    estimatedCostUsd: Math.max(0, after.estimatedCostUsd - before.estimatedCostUsd),
  };
}
