import type { SearchResponse } from "./pipeline.js";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function formatCost(usd: number): string {
  if (usd < 0.0001) return `<$0.0001`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Compact, high-signal output designed for both humans and coding agents (Claude Code, Codex, Antigravity).
 */
export function formatSearchResultsText(response: SearchResponse): string {
  const { stats, results } = response;
  const headerParts = [
    `${stats.totalFilesScanned} files scanned`,
    stats.usedDirectoryTriage ? `${stats.directoriesScored} dirs triaged` : null,
    stats.stage2Verified > 0 ? `${stats.stage2Verified} verified` : "fast mode",
    formatDuration(stats.durationMs),
    `${formatTokens(stats.usage.inputTokens)} tok`,
    formatCost(stats.usage.estimatedCostUsd),
  ].filter(Boolean);

  if (results.length === 0) {
    const lines = [
      `No files matched "${response.query}" above threshold (${headerParts.join(", ")}).`,
    ];
    if (response.topBelowThreshold) {
      lines.push(
        `Closest candidate below threshold: ${response.topBelowThreshold.score.toFixed(2)}  ${response.topBelowThreshold.path} (re-run with lower --min-score to inspect).`
      );
    }
    return lines.join("\n");
  }

  const lines: string[] = [
    `Found ${results.length} file${results.length === 1 ? "" : "s"} (${headerParts.join(", ")}):`,
    "",
  ];

  results.forEach((match, idx) => {
    const roleTag = match.role ? ` [${match.role}]` : "";
    lines.push(
      `${idx + 1}. ${match.score.toFixed(2)}${roleTag}  ${match.path}  (${match.language}, ${match.lines} lines)`
    );
    if (match.summary) {
      lines.push(`   ${match.summary}`);
    }
    if (match.symbols.length > 0) {
      lines.push(`   Symbols: ${match.symbols.join(", ")}`);
    }
  });

  return lines.join("\n");
}
