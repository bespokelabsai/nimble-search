import type { FileCard } from "./cards.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "where",
  "which",
  "what",
  "when",
  "how",
  "does",
  "file",
  "files",
  "code",
  "find",
  "search",
  "handles",
  "handle",
  "responsible",
  "logic",
  "implementation",
  "module",
  "function",
  "class",
  "are",
  "was",
  "were",
  "has",
  "have",
  "not",
  "but",
  "can",
  "all",
  "any",
  "our",
  "its",
]);

/**
 * Tokenize identifiers and natural language into lowercase search terms.
 * Splits camelCase, PascalCase, snake_case, kebab-case, and paths.
 */
export function tokenize(input: string): string[] {
  const splitCamel = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const raw = splitCamel.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return raw.filter((tok) => !STOPWORDS.has(tok));
}

export interface LexicalScore {
  card: FileCard;
  score: number;
}

/**
 * Fast BM25-inspired lexical scorer over file cards.
 * Used as a recall booster for huge repos (unioned with directory triage) and for Stage 2 windowing.
 */
export function rankCardsLexically(
  query: string,
  cards: FileCard[],
  topK: number
): LexicalScore[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0 || cards.length === 0) return [];

  // Document frequency across cards
  const df = new Map<string, number>();
  const cardTermSets: Array<{
    pathTerms: Set<string>;
    symbolTerms: Set<string>;
    bodyTerms: Set<string>;
  }> = [];

  for (const card of cards) {
    const pathTerms = new Set(tokenize(card.relPath));
    const symbolTerms = new Set(tokenize(card.symbols.join(" ")));
    const bodyTerms = new Set(tokenize(`${card.summary} ${card.preview}`));
    cardTermSets.push({ pathTerms, symbolTerms, bodyTerms });

    for (const term of queryTerms) {
      if (pathTerms.has(term) || symbolTerms.has(term) || bodyTerms.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }

  const N = cards.length;
  const scored: LexicalScore[] = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const terms = cardTermSets[i]!;
    let total = 0;
    let matchedTerms = 0;

    for (const term of queryTerms) {
      const freq = df.get(term) ?? 0;
      if (freq === 0) continue;
      const idf = Math.log(1 + (N - freq + 0.5) / (freq + 0.5));
      let termScore = 0;
      if (terms.pathTerms.has(term)) termScore += 3.0;
      if (terms.symbolTerms.has(term)) termScore += 2.2;
      if (terms.bodyTerms.has(term)) termScore += 1.0;

      // Substring fallback for stems/prefixes (e.g., "retry" matching "retries" or "retrier")
      if (termScore === 0 && term.length >= 4) {
        const stem = term.slice(0, Math.max(4, term.length - 1));
        for (const t of terms.pathTerms) {
          if (t.startsWith(stem)) {
            termScore += 1.4;
            break;
          }
        }
        if (termScore === 0) {
          for (const t of terms.symbolTerms) {
            if (t.startsWith(stem)) {
              termScore += 1.0;
              break;
            }
          }
        }
      }

      if (termScore > 0) {
        matchedTerms += 1;
        total += termScore * idf;
      }
    }

    if (total > 0) {
      // Bonus for covering a larger fraction of distinct query terms
      const coverage = matchedTerms / queryTerms.length;
      scored.push({ card, score: total * (0.6 + 0.4 * coverage) });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.card.relPath.localeCompare(b.card.relPath));
  return scored.slice(0, topK);
}

/**
 * Extract an informative excerpt of a large file for Stage 2 verification:
 * keeps the head, highest-relevance query-matching windows in the middle, and tail.
 */
export function buildSmartFileExcerpt(
  content: string,
  query: string,
  maxChars = 24_000
): { excerpt: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { excerpt: content, truncated: false };
  }

  const lines = content.split("\n");
  const queryTerms = Array.from(new Set(tokenize(query)));

  const headBudget = Math.floor(maxChars * 0.42);
  const middleBudget = Math.floor(maxChars * 0.42);
  const tailBudget = maxChars - headBudget - middleBudget;

  // Head lines
  const headLines: string[] = [];
  let headChars = 0;
  let headEndIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = `${i + 1}: ${lines[i]}`;
    if (headChars + line.length + 1 > headBudget) break;
    headLines.push(line);
    headChars += line.length + 1;
    headEndIdx = i + 1;
  }

  // Tail lines
  const tailLines: string[] = [];
  let tailChars = 0;
  let tailStartIdx = lines.length;
  for (let i = lines.length - 1; i >= headEndIdx; i--) {
    const line = `${i + 1}: ${lines[i]}`;
    if (tailChars + line.length + 1 > tailBudget) break;
    tailLines.unshift(line);
    tailChars += line.length + 1;
    tailStartIdx = i;
  }

  // Score middle lines for lexical hits to pick high-signal windows
  const middleWindows: string[] = [];
  if (queryTerms.length > 0 && tailStartIdx > headEndIdx) {
    const lineHits: Array<{ idx: number; score: number }> = [];
    for (let i = headEndIdx; i < tailStartIdx; i++) {
      const lower = lines[i]!.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (lower.includes(term)) score += 1;
      }
      if (score > 0) lineHits.push({ idx: i, score });
    }
    lineHits.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const included = new Set<number>();
    let usedMiddle = 0;
    const RADIUS = 8;

    for (const hit of lineHits) {
      if (usedMiddle >= middleBudget) break;
      const start = Math.max(headEndIdx, hit.idx - RADIUS);
      const end = Math.min(tailStartIdx - 1, hit.idx + RADIUS);
      const block: string[] = [];
      let blockChars = 0;
      for (let j = start; j <= end; j++) {
        if (included.has(j)) continue;
        const formatted = `${j + 1}: ${lines[j]}`;
        block.push(formatted);
        blockChars += formatted.length + 1;
      }
      if (block.length > 0 && usedMiddle + blockChars <= middleBudget) {
        for (let j = start; j <= end; j++) included.add(j);
        middleWindows.push(`... (lines ${start + 1}-${end + 1}) ...\n${block.join("\n")}`);
        usedMiddle += blockChars + 32;
      }
    }
  }

  const parts = [headLines.join("\n")];
  if (middleWindows.length > 0) {
    parts.push(middleWindows.join("\n\n"));
  } else if (tailStartIdx > headEndIdx) {
    parts.push(`... (${tailStartIdx - headEndIdx} lines omitted) ...`);
  }
  if (tailLines.length > 0) {
    parts.push(`... (tail) ...\n${tailLines.join("\n")}`);
  }

  return {
    excerpt: parts.join("\n\n"),
    truncated: true,
  };
}
