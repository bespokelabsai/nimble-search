---
name: nimble-search
description: Semantically locate repository files from a natural-language description using Bespoke Labs Nimble (`search_files` MCP tool or `nimble-search` CLI). Use BEFORE repetitive grep/glob loops whenever you need to find files by behavior, responsibility, or architecture rather than exact symbol names.
---

# Nimble Semantic Code Search

Use `nimble-search` to find files in a repository from a **conceptual or behavioral description**, instead of burning multiple `grep` / `glob` turns guessing identifiers.

## When to use `nimble-search` vs `grep`

| Situation | Reach for |
| --- | --- |
| You know *what* the code does, not what it's named (*"where failed webhook deliveries are retried"*, *"OAuth scope normalization"*, *"startup DB migration wiring"*) | **`search_files` MCP tool** (or `nimble-search "<description>"`) |
| Exploring an unfamiliar codebase to locate the main implementation + callers + tests for a feature | **`search_files`** (default `fast` ranks file cards; select `balanced` for source verification and role tags) |
| You already know the exact identifier, error code, regex, or want every call-site for a refactor | **`grep` / `rg`** (faster, exact, exhaustive) |
| You know the exact filename or path pattern | **`glob` / `find`** |

## How to invoke

### Preferred: MCP tool (`search_files`)
Call `search_files` with a descriptive natural-language `query`:

```json
{
  "query": "validates JWT refresh tokens and rotates expired sessions",
  "directory": "/path/to/repo",
  "top_k": 5,
  "mode": "fast"
}
```

Tips for great results:

- **Be specific about behavior**, not just 1–2 vague nouns (prefer `"retries failed HTTP requests with exponential backoff and Retry-After header"` over `"retry"`).
- **Keep default `mode: "fast"` for agent loops**: Stage 1 scores file cards without the additional source-verification requests; read the top candidate(s) to verify the implementation.
- **Use `mode: "balanced"`**, optionally with `roles: ["implementation"]`, when you want Stage 2 candidate source verification and role tags (`[implementation]`, `[caller]`, `[test]`, `[config]`) across many hits.
- **Use `subpath` or `extensions`** in large monorepos to narrow scope and cut latency/cost.

### Fallback: CLI (`nimble-search`)
If the MCP server isn't configured in the current environment, run the CLI directly. CLI searches default to balanced mode, so pass `--fast` for the usual agent workflow and `--dir` to select the target repository:

```bash
nimble-search "where failed webhook deliveries are retried" --dir /path/to/repo --fast --top 5
nimble-search "rate limit middleware configuration" --dir /path/to/repo --path services/api --ext ts --fast
nimble-search "database migration runner" --dir /path/to/repo --fast --json
```

If the CLI is not on PATH, use `node /path/to/nimble-search/dist/cli.js` with the same arguments.

## Search data and verification

Searches send the query and file cards (paths, summaries/comments, symbols, and sometimes short code previews) to the configured Nimble API. Balanced/deep modes additionally send candidate source content, using a default 24,000-character excerpt budget for large files. `scan_repo` is local and makes no API calls. Source verification scores relevance; read the relevant implementation before relying on a result.

## Interpreting output

Each result includes a calibrated relevance score (`0.00`–`1.00`) and (in `balanced`/`deep` mode) a verified role tag:

```text
1. 0.96 [implementation]  src/auth/jwt.ts  (TypeScript, 142 lines)
2. 0.78 [test]            test/auth/jwt.test.ts  (TypeScript, 98 lines)
3. 0.61 [caller]          src/middleware/session.ts  (TypeScript, 64 lines)
```

- Scores `>= 0.75` are usually direct matches — open those files right away.
- Scores `0.40–0.74` are typically callers, wiring, types, or partial matches.
- If no files pass threshold, refine your description or fall back to `grep` for specific keywords.

The output header reports Nimble API input tokens, separate from result-context tokens. Compact results can save coding-agent context compared with verbose grep, but `rg -l` may be smaller when identifiers are known. Do not infer total-token or dollar savings from result size alone.
