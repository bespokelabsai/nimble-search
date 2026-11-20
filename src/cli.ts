#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp.js";
import { NimbleClient } from "./nimble/client.js";
import { buildFileCards } from "./repo/cards.js";
import { walkRepoFiles } from "./repo/walker.js";
import { formatSearchResultsText } from "./search/format.js";
import { searchCodebase, type SearchMode } from "./search/pipeline.js";
import { VALID_FILE_ROLES, type FileRole } from "./search/prompts.js";

const HELP_TEXT = `nimble-search — Semantic file search for coding agents powered by Bespoke Labs Nimble

USAGE:
  nimble-search "<description>" [options]
  nimble-search mcp [--dir <path>] [--model <name>] [--concurrency <n>]
  nimble-search scan [--dir <path>] [--path <subdir>] [--ext <ts,py>]
  nimble-search setup

SEARCH OPTIONS:
  -d, --dir <path>          Repository root directory (default: current directory)
  -p, --path <subdir>       Relative subdirectory inside --dir to narrow scope
  -k, --top <n>             Max files to return (default: 10)
      --fast                Stage 1 file cards only (skip Stage 2 full-file verification)
      --deep                Verify top 24 files in Stage 2 (default balanced verifies up to 10)
  -e, --ext <list>          Comma-separated file extensions, e.g. ts,tsx,py
  -r, --role <list>         Filter by verified role: implementation,caller,types,config,test,docs
      --min-score <0..1>    Minimum normalized relevance score (default: 0.25)
      --model <name>        Nimble model (default: nimble-latest or $NIMBLE_MODEL)
      --base-url <url>      API base URL (default: https://api.bespokelabs.ai or $NIMBLE_BASE_URL)
  -c, --concurrency <n>     Max concurrent API requests (default: 16 or $NIMBLE_CONCURRENCY)
      --batch-size <1..64>  Override file cards per Stage 1 request (default: adaptive up to 32)
      --no-cache            Ignore local file-card cache
      --no-gitignore        Include gitignored files
      --include-hidden      Include dotfiles/dotdirs
      --json                Output structured JSON
  -v, --verbose             Print stage timings and retry info to stderr
  -h, --help                Show this help

ENVIRONMENT:
  BESPOKE_API_KEY           Required API key from Bespoke Labs Console
  NIMBLE_MODEL              Optional default model override
  NIMBLE_BASE_URL           Optional base URL override (e.g. local Bespoke-Nimble-9B)
  NIMBLE_CONCURRENCY        Optional default concurrency limit

EXAMPLES:
  nimble-search "where JWT refresh tokens are rotated"
  nimble-search "retry failed webhook deliveries with backoff" --role implementation
  nimble-search "database migration runner" --dir ~/my-app --fast
  nimble-search mcp
`;

interface ParsedArgs {
  subcommand: "search" | "mcp" | "scan" | "setup" | "help";
  query: string;
  dir: string;
  subpath?: string;
  topK?: number;
  mode: SearchMode;
  extensions?: string[];
  roles?: FileRole[];
  minScore?: number;
  model?: string;
  baseUrl?: string;
  concurrency?: number;
  batchSize?: number;
  useCache: boolean;
  respectGitignore: boolean;
  includeHidden: boolean;
  json: boolean;
  verbose: boolean;
}

function parseNumber(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`Missing value for ${flag}`);
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`Invalid number for ${flag}: ${value}`);
  return num;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: "search",
    query: "",
    dir: process.cwd(),
    mode: "balanced",
    useCache: true,
    respectGitignore: true,
    includeHidden: false,
    json: false,
    verbose: false,
  };

  if (argv.length === 0) {
    result.subcommand = "help";
    return result;
  }

  let startIdx = 0;
  const first = argv[0];
  if (first === "mcp" || first === "scan" || first === "setup") {
    result.subcommand = first;
    startIdx = 1;
  } else if (first === "help" || first === "--help" || first === "-h") {
    result.subcommand = "help";
    return result;
  }

  const positional: string[] = [];

  for (let i = startIdx; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      result.subcommand = "help";
      return result;
    } else if (arg === "-d" || arg === "--dir") {
      result.dir = argv[++i] ?? "";
      if (!result.dir) throw new Error(`Missing value for ${arg}`);
    } else if (arg === "-p" || arg === "--path") {
      result.subpath = argv[++i];
      if (!result.subpath) throw new Error(`Missing value for ${arg}`);
    } else if (arg === "-k" || arg === "--top") {
      result.topK = Math.max(1, Math.floor(parseNumber(arg, argv[++i])));
    } else if (arg === "--fast") {
      result.mode = "fast";
    } else if (arg === "--deep") {
      result.mode = "deep";
    } else if (arg === "-e" || arg === "--ext") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      result.extensions = val
        .split(",")
        .map((s) => s.trim().replace(/^\./, ""))
        .filter(Boolean);
    } else if (arg === "-r" || arg === "--role") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      const parsedRoles = val
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      for (const r of parsedRoles) {
        if (!VALID_FILE_ROLES.includes(r as FileRole)) {
          throw new Error(
            `Invalid role "${r}". Valid roles: ${VALID_FILE_ROLES.join(", ")}`
          );
        }
      }
      result.roles = parsedRoles as FileRole[];
    } else if (arg === "--min-score") {
      result.minScore = parseNumber(arg, argv[++i]);
    } else if (arg === "--model") {
      result.model = argv[++i];
      if (!result.model) throw new Error(`Missing value for ${arg}`);
    } else if (arg === "--base-url") {
      result.baseUrl = argv[++i];
      if (!result.baseUrl) throw new Error(`Missing value for ${arg}`);
    } else if (arg === "-c" || arg === "--concurrency") {
      result.concurrency = Math.max(1, Math.floor(parseNumber(arg, argv[++i])));
    } else if (arg === "--batch-size") {
      result.batchSize = Math.max(1, Math.min(64, Math.floor(parseNumber(arg, argv[++i]))));
    } else if (arg === "--no-cache") {
      result.useCache = false;
    } else if (arg === "--no-gitignore") {
      result.respectGitignore = false;
    } else if (arg === "--include-hidden") {
      result.includeHidden = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "-v" || arg === "--verbose") {
      result.verbose = true;
    } else if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  result.query = positional.join(" ").trim();
  return result;
}

function printSetupSnippets(): void {
  const cliPath = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(cliPath), "..");
  const skillPath = path.join(pkgRoot, "skills", "nimble-search", "SKILL.md");

  console.log(`nimble-search setup guide
=========================

Resolved CLI entrypoint: ${cliPath}
Agent skill file:        ${skillPath}

1) Claude Code (MCP + Skill)
----------------------------
Add the MCP server:
  claude mcp add nimble-search -- node ${cliPath} mcp

(Make sure BESPOKE_API_KEY is exported in your shell, or pass -e BESPOKE_API_KEY=...)

Install the agent skill (project or global):
  mkdir -p ~/.claude/skills/nimble-search
  cp ${skillPath} ~/.claude/skills/nimble-search/SKILL.md

2) OpenAI Codex CLI (MCP + Skill)
---------------------------------
Add to ~/.codex/config.toml:

  [mcp_servers.nimble_search]
  command = "node"
  args = ["${cliPath}", "mcp"]
  env_vars = ["BESPOKE_API_KEY"]

Install the agent skill:
  mkdir -p ~/.codex/skills/nimble-search
  cp ${skillPath} ~/.codex/skills/nimble-search/SKILL.md

3) Google Antigravity (MCP + Skill)
-----------------------------------
Add to your Antigravity MCP config (~/.gemini/antigravity/mcp_config.json):

  {
    "mcpServers": {
      "nimble-search": {
        "command": "node",
        "args": ["${cliPath}", "mcp"],
        "env": {
          "BESPOKE_API_KEY": "\${BESPOKE_API_KEY}"
        }
      }
    }
  }

Install the agent skill:
  mkdir -p ~/.gemini/antigravity/skills/nimble-search
  cp ${skillPath} ~/.gemini/antigravity/skills/nimble-search/SKILL.md
`);
}

async function runScan(args: ParsedArgs): Promise<void> {
  const rootDir = path.resolve(args.dir);
  const t0 = Date.now();
  const files = await walkRepoFiles({
    rootDir,
    subpath: args.subpath,
    extensions: args.extensions,
    includeHidden: args.includeHidden,
    respectGitignore: args.respectGitignore,
  });
  const cardBuild = await buildFileCards(rootDir, files, { useCache: args.useCache });
  const elapsedMs = Date.now() - t0;

  const byLang = new Map<string, number>();
  for (const card of cardBuild.cards) {
    byLang.set(card.language, (byLang.get(card.language) ?? 0) + 1);
  }
  const languages = Object.fromEntries(
    Array.from(byLang.entries()).sort((a, b) => b[1] - a[1])
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          rootDir,
          files: cardBuild.cards.length,
          skippedBinary: cardBuild.skippedBinary,
          cacheHits: cardBuild.cacheHits,
          cacheMisses: cardBuild.cacheMisses,
          willUseDirectoryTriage: cardBuild.cards.length > 800,
          durationMs: elapsedMs,
          languages,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Repository:       ${rootDir}`);
  console.log(`Searchable files: ${cardBuild.cards.length} (skipped binary: ${cardBuild.skippedBinary})`);
  console.log(`Card cache:       ${cardBuild.cacheHits} hits, ${cardBuild.cacheMisses} extracted (${elapsedMs}ms)`);
  console.log(
    `Large-repo mode:  ${cardBuild.cards.length > 800 ? "directory triage enabled (>800 files)" : "direct full-repo Stage 1"}`
  );
  console.log("Languages:");
  for (const [lang, count] of Object.entries(languages).slice(0, 12)) {
    console.log(`  ${lang.padEnd(14)} ${count}`);
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.subcommand === "help") {
    console.log(HELP_TEXT);
    return;
  }

  if (args.subcommand === "setup") {
    printSetupSnippets();
    return;
  }

  if (args.subcommand === "scan") {
    await runScan(args);
    return;
  }

  if (args.subcommand === "mcp") {
    await startMcpServer({
      defaultRootDir: args.dir,
      model: args.model,
      baseUrl: args.baseUrl,
      concurrency: args.concurrency,
    });
    return;
  }

  if (!args.query) {
    console.error("Error: missing search description.\n");
    console.error('Example: nimble-search "where JWT refresh tokens are rotated"');
    process.exitCode = 1;
    return;
  }

  if (args.roles && args.mode === "fast") {
    console.error(
      "Warning: --role requires Stage 2 verification; ignoring --fast to classify roles."
    );
    args.mode = "balanced";
  }

  const client = new NimbleClient({
    model: args.model,
    baseUrl: args.baseUrl,
    concurrency: args.concurrency,
    onRetry: args.verbose
      ? (info) => {
          console.error(
            `[nimble retry #${info.attempt}] status=${info.status ?? "net"} wait=${info.delayMs}ms (${info.reason})`
          );
        }
      : undefined,
  });

  const response = await searchCodebase(client, {
    query: args.query,
    rootDir: args.dir,
    subpath: args.subpath,
    topK: args.topK,
    mode: args.mode,
    extensions: args.extensions,
    roles: args.roles,
    minScore: args.minScore,
    batchSize: args.batchSize,
    useCache: args.useCache,
    includeHidden: args.includeHidden,
    respectGitignore: args.respectGitignore,
    onProgress: args.verbose
      ? (evt) => {
          console.error(`[${evt.stage}] ${evt.message}`);
        }
      : undefined,
  });

  if (args.verbose) {
    const s = response.stats;
    console.error(
      `[stats] scan=${s.stageDurationsMs.scanAndCards}ms dir=${s.stageDurationsMs.directoryTriage}ms s1=${s.stageDurationsMs.stage1}ms s2=${s.stageDurationsMs.stage2}ms requests=${s.usage.requests} input_tokens=${s.usage.inputTokens} cost=$${s.usage.estimatedCostUsd.toFixed(5)}`
    );
  }

  if (args.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log(formatSearchResultsText(response));
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
