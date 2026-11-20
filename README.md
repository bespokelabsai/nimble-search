# nimble-search

**Zero-index semantic file search for coding agents (Claude Code, OpenAI Codex, Google Antigravity) powered by [Bespoke Labs Nimble](https://docs.bespokelabs.ai).**

Find the right file from a plain-English description of *what it does* — with **no vector database, no embedding pipeline, and no background indexing daemon**. Works immediately on fresh clones and uncommitted local edits.

```bash
$ nimble-search "where rate limiting, HTTP retries, and payload batch splitting happen"

Found 5 files (25 files scanned, 8 verified, 3.6s, 25.4k tok, $0.0010):

1. 0.98 [implementation]  src/nimble/client.ts  (TypeScript, 375 lines)
   Symbols: NimbleClientOptions, NimbleApiError, NimbleClient, MAX_QUESTIONS_PER_REQUEST
2. 0.69 [test]            test/client.test.ts  (TypeScript, 108 lines)
3. 0.41 [caller]          src/search/pipeline.ts  (TypeScript, 518 lines)
4. 0.39 [caller]          src/cli.ts  (TypeScript, 389 lines)
5. 0.26 [types]           src/nimble/types.ts  (TypeScript, 81 lines)
```

---

## Why Nimble instead of `grep` or a vector DB?

| Approach | Strength | Weakness |
| --- | --- | --- |
| **`grep` / `ripgrep`** | Instant (~20ms), free, exact for known symbols/regexes | Struggles on conceptual queries in large monorepos; dumps noisy docs/tests/fixtures and burns 4–10 frontier-model turns |
| **Embeddings / Vector DB** | Cheap query time on huge repos | Needs a persistent index to keep in sync; blind to uncommitted edits; bi-encoder cosine similarity misses fine behavioral distinctions |
| **`nimble-search`** | **Zero index**, sees uncommitted edits instantly, true cross-attention via Nimble's System One `score` & `choice` logprobs (~$0.04 / 1M input tokens, output free) | ~1–6s API round-trip — best as a **companion** to `grep`, not a replacement for exact symbol lookups |

### When to reach for each tool

- **Use `nimble-search` (`search_files`)** when you know *what* code does conceptually, not what it's named (*"where failed webhooks are verified against replay attacks"*, *"the state machine that repairs truncated JSON"*), especially in large multi-package repos.
- **Use `grep` / `rg`** when you already have an exact identifier, error code (`ERR_...`), import path, or need exhaustive find-all-references.

---

## Architecture

`nimble-search` uses a multi-stage funnel built around Nimble's `POST /v1/systemone` API (up to 64 typed questions per request, returning calibrated continuous expected scores without generating prose):

```mermaid
flowchart LR
    A["Stage 0: Local Scan + File Cards\n(.gitignore aware, cached by mtime+size)"] --> B{"Repo > 800 files?"}
    B -- Yes --> C["Stage 0.5: Directory Triage\n(<=256 dir buckets scored by Nimble\n+ top 80 repo-wide lexical boost)"]
    B -- No --> D["Stage 1: Batched Card Triage\n(Query in state, file cards as parallel\n4-level Nimble score questions)"]
    C --> D
    D --> E{"mode?"}
    E -- "fast (MCP default)" --> F["Ranked Files + Symbols"]
    E -- "balanced / deep" --> G["Stage 2: Full-File Verification\n(Parallel relevance score + role choice:\nimplementation | caller | types | config | test | docs)"]
    G --> F
```

Key design details:
- **Independent scoring (no probability splitting):** Uses Nimble's 4-level ordered `score` rubric rather than `choice` in Stage 1 so multiple relevant files all score high independently, and zero-match queries cleanly fall below `--min-score`.
- **Zero repo clutter:** Lightweight file cards (path, language, line count, top doc comment, exported/top-level symbols) are cached in OS temp storage (`$TMPDIR/nimble-search-cache/`) keyed by `(path, mtime, size)`.
- **Resilient Nimble client:** Adaptive concurrency semaphore (defaults to `16`, automatically throttles down on `429` while honoring `Retry-After`), exponential backoff on `503`/`529`, and automatic batch splitting on `>64` questions, `>750 KiB` payloads, or `504` timeouts.
- **Self-hostable:** Point `--base-url` / `NIMBLE_BASE_URL` at any compatible Nimble endpoint (e.g., open-weight `Bespoke-Nimble-9B`).

---

## Benchmarks

Evaluated live against `api.bespokelabs.ai` (`nimble-latest`) on two unfamiliar open-source repositories — **Hono** (548 files) and **`vercel/ai`** (10,015 files across 80+ packages) — across 23 ground-truth localization tasks (`eval/`).

### 1. Standalone Retrieval Quality (vs local BM25)

| Repository & Suite | Arm | Recall@1 | Recall@5 | MRR | Avg Latency | Avg Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **Hono** (548 files, 10 standard tasks) | `bm25-lexical` | 60% | 70% | 0.62 | 13ms | $0.0000 |
| | `nimble --fast` | **100%** | **100%** | **1.00** | 5.55s | $0.0024 |
| | `nimble balanced` (full-scan) | **100%** | **100%** | **1.00** | 4.89s | $0.0051 |
| **Hono** (548 files, 5 zero-keyword tasks) | `bm25-lexical` | 0% | 20% | 0.10 | 16ms | $0.0000 |
| | `nimble --fast` | **100%** | **100%** | **1.00** | 3.76s | $0.0022 |
| **`vercel/ai`** (10,015 files, 8 zero-keyword tasks) | `bm25-lexical` | 0% | 37.5% | 0.13 | 172ms | $0.0000 |
| | `nimble --fast` (dir-triage) | **100%** | **100%** | **1.00** | 6.34s | $0.0057 |
| | `nimble balanced` (dir-triage) | **100%** | **100%** | **1.00** | 5.53s | $0.0069 |

**23 / 23 tasks landed at Rank #1 (100% Recall@1, 1.00 MRR)** — including across 10,015 files via Stage 0.5 directory triage.

### 2. Head-to-Head Coding Agent A/B (`vercel/ai`, 10,015 files, 8 zero-keyword tasks)

Controlled comparison of `grep + find + read_file` vs `+ nimble-search (fast)` using identical agent prompts and mandatory `read_file` verification (measured directly from full agent transcripts, with live Nimble API latency and cost included):

| Metric (per task avg) | `grep-only` | `+ nimble fast` | Delta |
| --- | ---: | ---: | --- |
| **Exact Accuracy** | 100% (8/8) | 100% (8/8) | tied |
| **Agent Turns** | 3.88 *(max 7)* | **3.00** *(every task: 3)* | **-23%** (zero tail blowups) |
| **Tool Calls** (`grep / nimble / read`) | 3.38 (`1.75 / 0 / 1.50`) | **2.50** (`0 / 1.00 / 1.50`) | **-26%** |
| **Frontier New Input Tokens** | 17,772 *(max 25.4k)* | **14,521** | **-18.3%** (-3,251 tok) |
| **Frontier Output Tokens** | 1,218 | **967** | **-20.6%** (-251 tok) |
| **Tool-Output Context Bloat** | 10,119 chars | **6,834 chars** | **-32.5%** |
| **Hardest Tasks Wall-Clock** *(HMAC / SSRF)* | 33.0s / 21.0s | **15.6s / 15.3s** | **1.4x–2.1x faster** |
| **Nimble Spend** | \$0.0000 | **\$0.0057** | **Net cheaper on frontier LLMs** |

On frontier-model pricing (e.g., \$3 / \$15 per 1M tokens), saving ~3.25k uncached input tokens + 251 output tokens saves **~\$0.0135/task** against **\$0.0057** in Nimble spend (**~2.4x net savings**, or **~12x** at Opus-tier pricing). On smaller clean repos (~500 files), `grep` stays faster on wall-clock time; the crossover clearly favors `nimble-search` on large monorepos (thousands of files) where `grep` hits noisy docs, examples, and fixture dumps.

---

## Quickstart

Requires **Node.js >= 20** and a Bespoke Labs API key (`BESPOKE_API_KEY`).

```bash
git clone <repo-url> nimble-search
cd nimble-search
npm install
npm run build

export BESPOKE_API_KEY="your-bespoke-api-key"

# Optional: expose `nimble-search` globally on PATH
npm link
```

### Example commands

```bash
# Default CLI search (Stage 1 + Stage 2 full-file verification + role tags)
nimble-search "where JWT refresh tokens are rotated"

# Fast mode (Stage 1 file cards only — lowest latency & cost)
nimble-search "how nested gitignore rules and binaries are skipped" --fast

# Filter to primary implementation files only
nimble-search "where MCP tools are registered" --role implementation

# Scope to a subdirectory and specific extensions in a monorepo
nimble-search "retry failed webhooks with backoff" --dir ~/my-monorepo --path services/billing --ext ts,tsx

# Inspect searchable files & cache status (0 API calls)
nimble-search scan --dir ~/my-monorepo

# Structured JSON output + stderr timing/cost trace
nimble-search "database migration runner" --json --verbose
```

---

## Agent Integration (Claude Code, Codex & Antigravity)

Run `nimble-search setup` (or `node dist/cli.js setup`) to print copy-paste configs using the exact resolved path on your machine. Ready-to-use templates live in `configs/` and the cross-agent skill lives in [`skills/nimble-search/SKILL.md`](skills/nimble-search/SKILL.md).

### Claude Code

```bash
claude mcp add nimble-search -- node /path/to/nimble-search/dist/cli.js mcp

# Install skill so Claude Code knows when to use nimble-search vs grep
mkdir -p ~/.claude/skills/nimble-search
cp /path/to/nimble-search/skills/nimble-search/SKILL.md ~/.claude/skills/nimble-search/SKILL.md
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml` (see [`configs/codex-mcp.toml`](configs/codex-mcp.toml)):

```toml
[mcp_servers.nimble_search]
command = "node"
args = ["/path/to/nimble-search/dist/cli.js", "mcp"]
env_vars = ["BESPOKE_API_KEY"]
```

```bash
mkdir -p ~/.codex/skills/nimble-search
cp /path/to/nimble-search/skills/nimble-search/SKILL.md ~/.codex/skills/nimble-search/SKILL.md
```

### Google Antigravity

Add to `~/.gemini/antigravity/mcp_config.json` (see [`configs/antigravity-mcp.json`](configs/antigravity-mcp.json)):

```json
{
  "mcpServers": {
    "nimble-search": {
      "command": "node",
      "args": ["/path/to/nimble-search/dist/cli.js", "mcp"],
      "env": {
        "BESPOKE_API_KEY": "${BESPOKE_API_KEY}"
      }
    }
  }
}
```

```bash
mkdir -p ~/.gemini/antigravity/skills/nimble-search
cp /path/to/nimble-search/skills/nimble-search/SKILL.md ~/.gemini/antigravity/skills/nimble-search/SKILL.md
```

### MCP Tools Exposed

| Tool | Description |
| --- | --- |
| `search_files` | Semantic file search by natural-language description. Defaults to `mode: "fast"` for coding agents (since the agent reads the top file directly); accepts `directory`, `subpath`, `top_k`, `mode` (`"fast" \| "balanced" \| "deep"`), `extensions`, `roles`, `min_score`, and `format`. Automatically uses `balanced` if `roles` is specified. |
| `scan_repo` | Zero-API-call inventory of searchable files, language breakdown, card cache status, and whether directory triage will trigger. |

---

## CLI Reference

```text
nimble-search "<description>" [options]
nimble-search mcp [--dir <path>] [--model <name>] [--concurrency <n>]
nimble-search scan [--dir <path>] [--path <subdir>] [--ext <ts,py>]
nimble-search setup
```

| Flag | Default | Description |
| --- | --- | --- |
| `-d, --dir <path>` | `.` | Repository root directory |
| `-p, --path <subdir>` | — | Relative subdirectory inside `--dir` |
| `-k, --top <n>` | `10` | Maximum ranked files returned |
| `--fast` | off *(CLI)* / on *(MCP)* | Stage 1 file cards only (skip Stage 2 verification) |
| `--deep` | off | Verify top 24 candidates in Stage 2 |
| `-e, --ext <list>` | all text | Comma-separated extensions (e.g. `ts,tsx,py`) |
| `-r, --role <list>` | any | Filter verified results by `implementation,caller,types,config,test,docs` |
| `--min-score <0..1>` | `0.25` | Minimum normalized relevance score |
| `--model <name>` | `nimble-latest` | Model name (or `$NIMBLE_MODEL`) |
| `--base-url <url>` | `https://api.bespokelabs.ai` | Custom/self-hosted endpoint (or `$NIMBLE_BASE_URL`) |
| `-c, --concurrency <n>` | `16` | Max concurrent requests (or `$NIMBLE_CONCURRENCY`) |
| `--batch-size <1..64>` | adaptive (up to 32) | Override file cards packed per Stage 1 request |
| `--no-cache` | off | Bypass local file-card disk cache |
| `--no-gitignore` | off | Include gitignored files |
| `--include-hidden` | off | Include dotfiles and dot-directories |
| `--json` | off | Emit structured JSON response |
| `-v, --verbose` | off | Log stage timings, token usage, cost, and retries to stderr |

You can also add a repo-level `.nimbleignore` file (same syntax as `.gitignore`) to exclude generated assets or vendored code from search.

---

## Programmatic API

```ts
import { NimbleClient, searchCodebase } from "nimble-search";

const client = new NimbleClient({
  apiKey: process.env.BESPOKE_API_KEY,
  concurrency: 16,
});

const res = await searchCodebase(client, {
  query: "validates download URLs to block SSRF against private networks",
  rootDir: "/path/to/repo",
  mode: "fast",
  topK: 5,
});

for (const match of res.results) {
  console.log(match.score.toFixed(2), match.path);
}
```

---

## Development & Evaluations

```bash
# Typecheck, build, and run unit + MCP stdio integration tests (15 tests)
npm run typecheck
npm run build
npm test

# Compile and run the retrieval benchmark (BM25 vs nimble-fast vs nimble-balanced)
npx tsc -p tsconfig.eval.json
node dist-eval/eval/run-retrieval.js /path/to/repo eval/hono-tasks.json /tmp/retrieval.json

# Run the standalone Anthropic Head-to-Head Agent A/B harness
ANTHROPIC_API_KEY=... BESPOKE_API_KEY=... \
  node dist-eval/eval/ab-harness.js --repo /path/to/repo --tasks eval/hono-tasks.json
```

### Project Layout

```text
src/
  cli.ts              CLI entrypoint (search, mcp, scan, setup)
  mcp.ts              Stdio MCP server (search_files, scan_repo)
  index.ts            Library exports
  nimble/             System One API client, retries, adaptive concurrency, types
  repo/               .gitignore walker, zero-LLM file/dir cards + cache, BM25 lexical helper
  search/             Multi-stage pipeline, rubrics/prompts, text/JSON formatting
skills/nimble-search/ Cross-agent SKILL.md for Claude Code, Codex, and Antigravity
configs/              MCP config templates (JSON & TOML)
eval/                 Retrieval & head-to-head agent A/B benchmarks
test/                 Unit & stdio MCP integration tests
```

## License

MIT
