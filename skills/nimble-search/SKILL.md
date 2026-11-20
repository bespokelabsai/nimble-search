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
| Exploring an unfamiliar codebase to locate the main implementation + callers + tests for a feature | **`search_files`** (default `balanced` mode returns verified `[implementation]`, `[caller]`, `[test]`, `[config]` tags) |
| You already know the exact identifier, error code, regex, or want every call-site for a refactor | **`grep` / `rg`** (faster, exact, exhaustive) |
| You know the exact filename or path pattern | **`glob` / `find`** |

## How to invoke

### Preferred: MCP tool (`search_files`)
Call `search_files` with a descriptive natural-language `query`:

```json
{
  "query": "validates JWT refresh tokens and rotates expired sessions",
  "directory": "/path/to/repo",
  "top_k": 8,
  "mode": "fast"
}
```

Tips for great results:
- **Be specific about behavior**, not just 1–2 vague nouns (prefer `"retries failed HTTP requests with exponential backoff and Retry-After header"` over `"retry"`).
- **Keep default `mode: "fast"` for agent loops**: Stage 1 file-card scoring is fastest and cheapest, and you are going to `read_file` the top candidate(s) anyway.
- **Use `mode: "balanced"` (or pass `roles: ["implementation"]`)** only when you specifically want Stage 2 full-file verification and role tags (`[implementation]`, `[caller]`, `[test]`, `[config]`) across many hits.
- **Use `subpath` or `extensions`** in large monorepos to narrow scope and cut latency/cost.

### Fallback: CLI (`nimble-search`)
If the MCP server isn't configured in the current environment, run the CLI directly:

```bash
nimble-search "where failed webhook deliveries are retried" --top 8
nimble-search "rate limit middleware configuration" --path services/api --ext ts
nimble-search "database migration runner" --fast --json
```

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
