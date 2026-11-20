import assert from "node:assert/strict";
import test from "node:test";
import { extractFileCardFromContent } from "../src/repo/cards.js";
import { buildSmartFileExcerpt, rankCardsLexically, tokenize } from "../src/repo/lexical.js";

test("tokenize splits camelCase, PascalCase, snake_case, and drops stopwords", () => {
  const tokens = tokenize("where refreshAccessToken handles webhook_retry logic");
  assert.ok(tokens.includes("refresh"));
  assert.ok(tokens.includes("access"));
  assert.ok(tokens.includes("token"));
  assert.ok(tokens.includes("webhook"));
  assert.ok(tokens.includes("retry"));
  assert.ok(!tokens.includes("where"));
  assert.ok(!tokens.includes("handles"));
});

test("rankCardsLexically prioritizes path and symbol matches", () => {
  const c1 = extractFileCardFromContent(
    { absPath: "/a", relPath: "src/webhooks/retrier.ts", dir: "src/webhooks", ext: "ts", size: 50, mtimeMs: 1 },
    "export function retryWebhookDelivery() {}"
  );
  const c2 = extractFileCardFromContent(
    { absPath: "/b", relPath: "src/ui/Modal.tsx", dir: "src/ui", ext: "tsx", size: 50, mtimeMs: 1 },
    "export function Modal() {}"
  );
  const ranked = rankCardsLexically("retry failed webhook delivery", [c2, c1], 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.card.relPath, "src/webhooks/retrier.ts");
});

test("buildSmartFileExcerpt retains head, matching middle window, and tail on huge files", () => {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    if (i === 200) {
      lines.push("export function rotateRefreshTokenSecret(userId: string) { return 'rotated'; }");
    } else {
      lines.push(`const fillerLine_${i} = "${"x".repeat(40)}";`);
    }
  }
  const big = lines.join("\n");
  const { excerpt, truncated } = buildSmartFileExcerpt(big, "rotate refresh token secret", 3000);
  assert.equal(truncated, true);
  assert.ok(excerpt.includes("fillerLine_0"));
  assert.ok(excerpt.includes("rotateRefreshTokenSecret"));
  assert.ok(excerpt.includes("fillerLine_399"));
});
