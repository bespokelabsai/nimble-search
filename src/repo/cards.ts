import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WalkedFile } from "./walker.js";

const CACHE_VERSION = 2;
const MAX_CARD_READ_BYTES = 48 * 1024;
const MAX_SYMBOLS = 16;
const MAX_SUMMARY_CHARS = 180;
const MAX_PREVIEW_CHARS = 180;

export interface FileCard {
  relPath: string;
  dir: string;
  ext: string;
  language: string;
  size: number;
  mtimeMs: number;
  lines: number;
  summary: string;
  symbols: string[];
  preview: string;
  cardText: string;
}

export interface DirectoryCard {
  dir: string;
  fileCount: number;
  files: FileCard[];
  cardText: string;
}

export interface CardBuildResult {
  cards: FileCard[];
  cacheHits: number;
  cacheMisses: number;
  skippedBinary: number;
}

interface CacheFilePayload {
  version: number;
  rootDir: string;
  entries: Record<string, FileCard>;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  pyi: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C/C++ Header",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++ Header",
  swift: "Swift",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  sql: "SQL",
  md: "Markdown",
  mdx: "MDX",
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  vue: "Vue",
  svelte: "Svelte",
  proto: "Protobuf",
  graphql: "GraphQL",
  gql: "GraphQL",
  tf: "Terraform",
  dockerfile: "Dockerfile",
};

export function detectLanguage(relPath: string, ext: string): string {
  const base = path.posix.basename(relPath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "Dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "Makefile";
  if (base === "justfile") return "Justfile";
  return EXT_TO_LANGUAGE[ext] ?? (ext ? ext.toUpperCase() : "Text");
}

function looksBinary(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < checkLen; i++) {
    const byte = buf[i]!;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32 && byte !== 27)) {
      suspicious += 1;
    }
  }
  return checkLen > 0 && suspicious / checkLen > 0.15;
}

function cleanWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLicenseBoilerplate(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("spdx-license-identifier") ||
    lower.includes("copyright (c)") ||
    lower.includes("licensed under the") ||
    lower.includes("permission is hereby granted") ||
    lower.includes("all rights reserved")
  );
}

function extractLeadingSummary(text: string, ext: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  const withoutShebang = trimmed.startsWith("#!")
    ? trimmed.slice(trimmed.indexOf("\n") + 1).trimStart()
    : trimmed;

  // Python triple-quoted module docstring
  if (ext === "py" || ext === "pyi") {
    const pyDoc = withoutShebang.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
    const body = pyDoc?.[1] ?? pyDoc?.[2];
    if (body && !isLicenseBoilerplate(body)) {
      return cleanWhitespace(body).slice(0, MAX_SUMMARY_CHARS);
    }
  }

  // Block comment /* ... */ or /** ... */
  const blockMatch = withoutShebang.match(/^\/\*+([\s\S]*?)\*\//);
  if (blockMatch?.[1]) {
    const cleaned = blockMatch[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\*?\s?/, ""))
      .join(" ");
    const norm = cleanWhitespace(cleaned);
    if (norm && !isLicenseBoilerplate(norm)) {
      return norm.slice(0, MAX_SUMMARY_CHARS);
    }
  }

  // Leading consecutive line comments (// or //! or #)
  const lines = withoutShebang.split("\n").slice(0, 12);
  const commentLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:\/\/\/?!?|##?)\s?(.*)$/);
    if (m) {
      const content = m[1]?.trim() ?? "";
      if (content && !content.startsWith("eslint") && !content.startsWith("@ts-")) {
        commentLines.push(content);
      }
    } else if (line.trim() === "") {
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }
  if (commentLines.length > 0) {
    const joined = cleanWhitespace(commentLines.join(" "));
    if (joined && !isLicenseBoilerplate(joined)) {
      return joined.slice(0, MAX_SUMMARY_CHARS);
    }
  }

  // package.json / manifest description
  if (ext === "json") {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof obj.name === "string") parts.push(`name=${obj.name}`);
      if (typeof obj.description === "string") parts.push(obj.description);
      if (parts.length > 0) return cleanWhitespace(parts.join(": ")).slice(0, MAX_SUMMARY_CHARS);
    } catch {
      // Ignore partial or invalid JSON
    }
  }

  return "";
}

function addUnique(list: string[], seen: Set<string>, item: string): void {
  const cleaned = item.trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return;
  if (seen.has(cleaned)) return;
  seen.add(cleaned);
  list.push(cleaned);
}

function extractSymbols(text: string, ext: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");

  const addRegexMatches = (pattern: RegExp, prefix = "") => {
    for (const line of lines) {
      if (symbols.length >= MAX_SYMBOLS) return;
      const m = line.match(pattern);
      if (m?.[1]) {
        addUnique(symbols, seen, prefix ? `${prefix}${m[1]}` : m[1]);
      }
    }
  };

  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte"].includes(ext)) {
    // Prefer exported symbols first
    addRegexMatches(
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
    );
    addRegexMatches(
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/
    );
    // HTTP / MCP / CLI route & tool registrations
    for (const line of lines) {
      if (symbols.length >= MAX_SYMBOLS) break;
      const route = line.match(
        /\b(?:app|router|server)\.(get|post|put|patch|delete|tool|command)\s*\(\s*["'`]([^"'`]{1,60})["'`]/i
      );
      if (route?.[1] && route?.[2]) {
        addUnique(symbols, seen, `${route[1].toUpperCase()} ${route[2]}`);
      }
    }
    // Top-level non-exported declarations if exports were scarce
    if (symbols.length < 8) {
      addRegexMatches(
        /^(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
      );
    }
  } else if (ext === "py" || ext === "pyi") {
    addRegexMatches(/^class\s+([A-Za-z_]\w*)/, "class ");
    addRegexMatches(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    addRegexMatches(/^\s{2,4}(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    for (const line of lines) {
      if (symbols.length >= MAX_SYMBOLS) break;
      const route = line.match(
        /^@\w+\.(get|post|put|patch|delete|route|command|tool)\s*\(\s*["']([^"']{1,60})["']/i
      );
      if (route?.[1] && route?.[2]) {
        addUnique(symbols, seen, `@${route[1]} ${route[2]}`);
      }
    }
  } else if (ext === "go") {
    addRegexMatches(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, "type ");
    addRegexMatches(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/);
  } else if (ext === "rs") {
    addRegexMatches(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
    addRegexMatches(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/);
  } else if (["java", "kt", "kts", "cs", "scala", "swift"].includes(ext)) {
    addRegexMatches(
      /^\s*(?:public|private|protected|internal|open|abstract|final|data|sealed|export)?\s*(?:class|interface|struct|enum|object|protocol|record)\s+([A-Za-z_]\w*)/
    );
    addRegexMatches(
      /^\s*(?:public|protected|internal|override|suspend|static|\s)*\b(?:fun|func|def)\s+([A-Za-z_]\w*)/
    );
  } else if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(ext)) {
    addRegexMatches(/^\s*(?:class|struct|enum|namespace)\s+([A-Za-z_]\w*)/);
    addRegexMatches(
      /^(?:[A-Za-z_][\w:*&<>\s]+)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/
    );
  } else if (ext === "rb" || ext === "php") {
    addRegexMatches(/^\s*(?:class|module|interface|trait)\s+([A-Za-z_]\w*)/);
    addRegexMatches(/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*(?:def|function)\s+([A-Za-z_]\w*[!?]?)/);
  } else if (ext === "sql") {
    for (const line of lines) {
      if (symbols.length >= MAX_SYMBOLS) break;
      const m = line.match(
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)/i
      );
      if (m?.[1]) addUnique(symbols, seen, m[1]);
    }
  } else if (ext === "md" || ext === "mdx") {
    for (const line of lines) {
      if (symbols.length >= MAX_SYMBOLS) break;
      const m = line.match(/^#{1,3}\s+(.+)$/);
      if (m?.[1]) addUnique(symbols, seen, cleanWhitespace(m[1]));
    }
  } else if (ext === "json") {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const key of Object.keys(obj as Record<string, unknown>)) {
          if (symbols.length >= MAX_SYMBOLS) break;
          addUnique(symbols, seen, key);
        }
        const scripts = (obj as Record<string, unknown>).scripts;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
          for (const key of Object.keys(scripts as Record<string, unknown>)) {
            if (symbols.length >= MAX_SYMBOLS) break;
            addUnique(symbols, seen, `script:${key}`);
          }
        }
      }
    } catch {
      // Partial JSON read; fall back to top-level key regex
      addRegexMatches(/^  "([^"]{1,50})":/);
    }
  } else if (ext === "yaml" || ext === "yml" || ext === "toml") {
    addRegexMatches(/^([A-Za-z0-9_.-]+)\s*[:=]/);
    addRegexMatches(/^\[([A-Za-z0-9_.-]+)\]/);
  } else if (ext === "proto" || ext === "graphql" || ext === "gql") {
    addRegexMatches(/^\s*(?:service|message|rpc|type|input|interface|enum|query|mutation)\s+([A-Za-z_]\w*)/);
  } else if (ext === "sh" || ext === "bash" || ext === "zsh") {
    addRegexMatches(/^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)/);
  }

  return symbols;
}

function extractCompactPreview(text: string): string {
  const meaningful: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.startsWith("import ") ||
      line.startsWith("from ") ||
      line.startsWith("use ") ||
      line.startsWith("package ") ||
      line.startsWith("#include") ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#!")
    ) {
      continue;
    }
    meaningful.push(line);
    if (meaningful.join(" | ").length >= MAX_PREVIEW_CHARS) break;
  }
  return cleanWhitespace(meaningful.join(" | ")).slice(0, MAX_PREVIEW_CHARS);
}

export function formatFileCardText(card: Omit<FileCard, "cardText">): string {
  const lines: string[] = [`${card.relPath} (${card.language}, ${card.lines}L)`];
  if (card.summary) {
    lines.push(`Doc: ${card.summary}`);
  }
  if (card.symbols.length > 0) {
    lines.push(`Symbols: ${card.symbols.join(", ")}`);
  }
  if (card.preview && card.symbols.length < 2 && !card.summary) {
    lines.push(`Code: ${card.preview}`);
  }
  return lines.join("\n");
}

export function extractFileCardFromContent(file: WalkedFile, content: string): FileCard {
  const language = detectLanguage(file.relPath, file.ext);
  const lines = content.split("\n").length;
  const summary = extractLeadingSummary(content, file.ext);
  const symbols = extractSymbols(content, file.ext);
  const preview = extractCompactPreview(content);
  const base = {
    relPath: file.relPath,
    dir: file.dir,
    ext: file.ext,
    language,
    size: file.size,
    mtimeMs: file.mtimeMs,
    lines,
    summary,
    symbols,
    preview,
  };
  return {
    ...base,
    cardText: formatFileCardText(base),
  };
}

function getCachePath(rootDir: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(rootDir)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "nimble-search-cache", `cards-v${CACHE_VERSION}-${hash}.json`);
}

async function loadCache(rootDir: string): Promise<Record<string, FileCard>> {
  const cachePath = getCachePath(rootDir);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as CacheFilePayload;
    if (parsed.version === CACHE_VERSION && parsed.entries) {
      return parsed.entries;
    }
  } catch {
    // Cache miss
  }
  return {};
}

async function saveCache(rootDir: string, cards: FileCard[]): Promise<void> {
  const cachePath = getCachePath(rootDir);
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const entries: Record<string, FileCard> = {};
    for (const card of cards) {
      entries[card.relPath] = card;
    }
    const payload: CacheFilePayload = {
      version: CACHE_VERSION,
      rootDir: path.resolve(rootDir),
      entries,
    };
    await fs.writeFile(cachePath, JSON.stringify(payload), "utf8");
  } catch {
    // Best-effort cache write; never fail search on cache I/O issues
  }
}

async function readHead(absPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(absPath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function buildFileCards(
  rootDir: string,
  files: WalkedFile[],
  options: { useCache?: boolean } = {}
): Promise<CardBuildResult> {
  const useCache = options.useCache ?? true;
  const cached = useCache ? await loadCache(rootDir) : {};
  const cards: FileCard[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let skippedBinary = 0;

  const toRead: WalkedFile[] = [];
  for (const file of files) {
    const hit = cached[file.relPath];
    if (hit && hit.size === file.size && Math.abs(hit.mtimeMs - file.mtimeMs) < 1) {
      cards.push(hit);
      cacheHits += 1;
    } else {
      toRead.push(file);
    }
  }

  // Read uncached files with bounded I/O concurrency
  const IO_BATCH = 32;
  for (let i = 0; i < toRead.length; i += IO_BATCH) {
    const slice = toRead.slice(i, i + IO_BATCH);
    const extracted = await Promise.all(
      slice.map(async (file): Promise<FileCard | null> => {
        try {
          const buf = await readHead(file.absPath, Math.min(file.size, MAX_CARD_READ_BYTES));
          if (looksBinary(buf)) {
            skippedBinary += 1;
            return null;
          }
          const text = buf.toString("utf8");
          cacheMisses += 1;
          return extractFileCardFromContent(file, text);
        } catch {
          return null;
        }
      })
    );
    for (const card of extracted) {
      if (card) cards.push(card);
    }
  }

  cards.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (useCache && (cacheMisses > 0 || Object.keys(cached).length !== cards.length)) {
    await saveCache(rootDir, cards);
  }

  return { cards, cacheHits, cacheMisses, skippedBinary };
}

function isTestPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/")
  );
}

/**
 * Group files into directory buckets for large-repo hierarchical triage.
 * If the repo has too many leaf directories (> maxBuckets), collapses deepest directories upward
 * until the bucket count is <= maxBuckets.
 */
export function buildDirectoryCards(cards: FileCard[], maxBuckets = 256): DirectoryCard[] {
  let groups = new Map<string, FileCard[]>();
  for (const card of cards) {
    const list = groups.get(card.dir) ?? [];
    list.push(card);
    groups.set(card.dir, list);
  }

  // Collapse deepest directories upward if bucket count exceeds maxBuckets
  while (groups.size > maxBuckets) {
    let maxDepth = 0;
    for (const dir of groups.keys()) {
      if (dir === ".") continue;
      const depth = dir.split("/").length;
      if (depth > maxDepth) maxDepth = depth;
    }
    if (maxDepth <= 1) break;

    const nextGroups = new Map<string, FileCard[]>();
    for (const [dir, list] of groups.entries()) {
      const depth = dir === "." ? 0 : dir.split("/").length;
      const targetDir =
        depth === maxDepth
          ? dir.includes("/")
            ? dir.slice(0, dir.lastIndexOf("/"))
            : "."
          : dir;
      const merged = nextGroups.get(targetDir) ?? [];
      merged.push(...list);
      nextGroups.set(targetDir, merged);
    }
    groups = nextGroups;
  }

  const dirCards: DirectoryCard[] = [];
  for (const [dir, dirFiles] of groups.entries()) {
    // Prioritize non-test implementation files in directory summaries so tests don't crowd out source names
    const ordered = [...dirFiles].sort((a, b) => {
      const aTest = isTestPath(a.relPath) ? 1 : 0;
      const bTest = isTestPath(b.relPath) ? 1 : 0;
      if (aTest !== bTest) return aTest - bTest;
      return a.relPath.localeCompare(b.relPath);
    });

    const sampleNames = ordered
      .slice(0, 20)
      .map((f) => (dir === "." ? f.relPath : f.relPath.slice(dir.length + 1) || path.posix.basename(f.relPath)));
    const more = ordered.length > sampleNames.length ? ` (+${ordered.length - sampleNames.length} more)` : "";

    // Gather top unique symbols & any README/index summary in the directory
    const symSet = new Set<string>();
    let dirSummary = "";
    for (const f of ordered) {
      const base = path.posix.basename(f.relPath).toLowerCase();
      if (!dirSummary && (base.startsWith("readme") || base.startsWith("index.") || base === "__init__.py" || base === "mod.rs")) {
        if (f.summary) dirSummary = f.summary;
      }
      for (const s of f.symbols.slice(0, 4)) {
        symSet.add(s);
        if (symSet.size >= 20) break;
      }
      if (symSet.size >= 20 && dirSummary) break;
    }

    const lines = [
      `Dir: ${dir === "." ? "(repo root)" : `${dir}/`} (${ordered.length} files)`,
      `Files: ${sampleNames.join(", ")}${more}`,
    ];
    if (dirSummary) {
      lines.push(`Doc: ${dirSummary}`);
    }
    if (symSet.size > 0) {
      lines.push(`Symbols: ${Array.from(symSet).join(", ")}`);
    }

    dirCards.push({
      dir,
      fileCount: ordered.length,
      files: ordered,
      cardText: lines.join("\n"),
    });
  }

  dirCards.sort((a, b) => a.dir.localeCompare(b.dir));
  return dirCards;
}
