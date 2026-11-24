import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NimbleClient } from "./nimble/client.js";
import { buildFileCards } from "./repo/cards.js";
import { walkRepoFiles } from "./repo/walker.js";
import { formatSearchResultsText } from "./search/format.js";
import { searchCodebase } from "./search/pipeline.js";
import { type FileRole } from "./search/prompts.js";

export interface McpServerStartOptions {
  defaultRootDir?: string;
  model?: string;
  baseUrl?: string;
  concurrency?: number;
}

const ROLE_ENUM = z.enum(["implementation", "caller", "types", "config", "test", "docs"]);

export function createNimbleSearchMcpServer(options: McpServerStartOptions = {}): McpServer {
  const defaultRootDir = path.resolve(options.defaultRootDir ?? process.cwd());

  const server = new McpServer({
    name: "nimble-search",
    version: "0.1.0",
  });

  server.registerTool(
    "search_files",
    {
      title: "Semantic Code File Search (Nimble)",
      description:
        "Find files in a codebase matching a natural-language description of behavior, responsibility, or architecture using Bespoke Labs Nimble. " +
        "Prefer this tool over grep/glob when you know *what* something does conceptually rather than exact symbol names or strings (e.g., 'where failed webhooks are retried', 'JWT refresh token rotation', 'database migration bootstrap'). " +
        "Still use grep/ripgrep for exact identifiers, error strings, or find-all-references.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of the file(s) you want to find (behavior, responsibility, feature, or component)."
          ),
        directory: z
          .string()
          .optional()
          .describe(
            "Repository root directory to search. Defaults to the server's working directory."
          ),
        subpath: z
          .string()
          .optional()
          .describe("Optional relative subdirectory within the repository to narrow the search."),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of ranked files to return (default: 10)."),
        mode: z
          .enum(["fast", "balanced", "deep"])
          .optional()
          .describe(
            "Search depth: 'fast' (default for agents — Stage 1 file-card scoring, fastest & cheapest since you will read_file the top hit anyway), 'balanced' (adds Stage 2 candidate source verification with [implementation]/[caller]/[test] role tags), or 'deep' (verifies top 24 files)."
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe("Optional file extensions to restrict search to, e.g. ['ts', 'tsx'] or ['py']."),
        roles: z
          .array(ROLE_ENUM)
          .optional()
          .describe(
            "Optional filter by verified file role (requires mode 'balanced' or 'deep'): implementation, caller, types, config, test, docs."
          ),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum normalized relevance score between 0 and 1 (default: 0.25)."),
        format: z
          .enum(["text", "json"])
          .optional()
          .describe("Output format: compact agent-readable 'text' (default) or structured 'json'."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const client = new NimbleClient({
          model: options.model,
          baseUrl: options.baseUrl,
          concurrency: options.concurrency,
        });
        const rootDir = args.directory ? path.resolve(args.directory) : defaultRootDir;
        const effectiveMode =
          args.mode ?? (args.roles && args.roles.length > 0 ? "balanced" : "fast");
        const response = await searchCodebase(client, {
          query: args.query,
          rootDir,
          subpath: args.subpath,
          topK: args.top_k,
          mode: effectiveMode,
          extensions: args.extensions,
          roles: args.roles as FileRole[] | undefined,
          minScore: args.min_score,
          signal: extra.signal,
        });

        const text =
          args.format === "json"
            ? JSON.stringify(response, null, 2)
            : formatSearchResultsText(response);

        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `nimble-search error: ${message}` }],
        };
      }
    }
  );

  server.registerTool(
    "scan_repo",
    {
      title: "Scan Repository File Inventory",
      description:
        "Inspect searchable files, language breakdown, and card cache status in a repository without calling the Nimble API.",
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe("Repository root directory to inspect (defaults to working directory)."),
        subpath: z.string().optional().describe("Optional relative subdirectory to inspect."),
        extensions: z
          .array(z.string())
          .optional()
          .describe("Optional extension filter, e.g. ['ts', 'py']."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const rootDir = args.directory ? path.resolve(args.directory) : defaultRootDir;
        const files = await walkRepoFiles({
          rootDir,
          subpath: args.subpath,
          extensions: args.extensions,
        });
        const cardBuild = await buildFileCards(rootDir, files, { useCache: true });

        const byLang = new Map<string, number>();
        for (const c of cardBuild.cards) {
          byLang.set(c.language, (byLang.get(c.language) ?? 0) + 1);
        }
        const langLines = Array.from(byLang.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([lang, count]) => `  ${lang}: ${count}`);

        const summary = [
          `Repository: ${rootDir}`,
          `Searchable files: ${cardBuild.cards.length} (skipped binary: ${cardBuild.skippedBinary})`,
          `Card cache: ${cardBuild.cacheHits} hits, ${cardBuild.cacheMisses} newly extracted`,
          `Directory triage will trigger: ${cardBuild.cards.length > 800 ? "yes (>800 files)" : "no (full Stage 1 scan)"}`,
          "Languages:",
          ...langLines,
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `scan_repo error: ${message}` }],
        };
      }
    }
  );

  return server;
}

export async function startMcpServer(options: McpServerStartOptions = {}): Promise<void> {
  const server = createNimbleSearchMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
