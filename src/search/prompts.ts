import type { ChoiceQuestion, ScoreQuestion } from "../nimble/types.js";
import type { DirectoryCard, FileCard } from "../repo/cards.js";

export type FileRole = "implementation" | "caller" | "types" | "config" | "test" | "docs";

export const VALID_FILE_ROLES: readonly FileRole[] = [
  "implementation",
  "caller",
  "types",
  "config",
  "test",
  "docs",
] as const;

export const DIRECTORY_RUBRIC: string[] = [
  "Unrelated directory",
  "Tangential utilities or indirect references",
  "Partial match, callers, config, or tests",
  "Primary directory implementing the query",
];

export const CARD_RUBRIC: string[] = [
  "Unrelated",
  "Tangentially related",
  "Partial match, caller, config, or test",
  "Primary file implementing or defining this",
];

export const CONTENT_RUBRIC: string[] = [
  "Unrelated content",
  "Tangential mention only",
  "Partial match (caller, config, types, or test)",
  "Primary implementation matching the query",
];

export const ROLE_CRITERIA: Record<FileRole, string> = {
  implementation:
    "Directly defines or implements the primary logic, behavior, or component described by the query",
  caller:
    "Calls, invokes, mounts, registers, or integrates with the logic described by the query",
  types:
    "Defines types, interfaces, schemas, or data contracts related to the query",
  config:
    "Configuration, wiring, routing, build settings, or environment setup related to the query",
  test:
    "Unit tests, integration tests, mocks, fixtures, or benchmarks for the queried behavior",
  docs:
    "Documentation, guides, architecture notes, or usage examples explaining the queried behavior",
};

export function buildDirectoryTriageState(query: string, repoName: string): Record<string, string> {
  return {
    task: "Rank repository directories by likelihood of containing files that match the search description.",
    repo: repoName,
    query,
  };
}

export function buildDirectoryQuestion(dirCard: DirectoryCard): ScoreQuestion {
  return {
    type: "score",
    instructions: `${dirCard.cardText}\n\nHow likely is this directory to contain files matching the query?`,
    criteria: DIRECTORY_RUBRIC,
  };
}

export function buildCardTriageState(query: string, repoName: string): Record<string, string> {
  return {
    task: "Rank source files by how closely they match the search description.",
    repo: repoName,
    query,
  };
}

export function buildCardQuestion(card: FileCard): ScoreQuestion {
  return {
    type: "score",
    instructions: `${card.cardText}\n\nHow closely does this file match the query?`,
    criteria: CARD_RUBRIC,
  };
}

export function buildContentVerificationState(
  card: FileCard,
  excerpt: string,
  truncated: boolean
): string {
  const header = [
    `File: ${card.relPath}`,
    `Language: ${card.language}`,
    `Lines: ${card.lines}${truncated ? " (excerpted)" : ""}`,
  ].join(" | ");
  return `${header}\n\n${excerpt}`;
}

export function buildContentQuestions(query: string): {
  relevance: ScoreQuestion;
  role: ChoiceQuestion;
} {
  return {
    relevance: {
      type: "score",
      instructions: `Search description: ${query}\n\nBased on the actual file content above, how directly does this file match the search description?`,
      criteria: CONTENT_RUBRIC,
    },
    role: {
      type: "choice",
      instructions: `Search description: ${query}\n\nWhat is this file's primary role with respect to the search description?`,
      criteria: ROLE_CRITERIA,
    },
  };
}
