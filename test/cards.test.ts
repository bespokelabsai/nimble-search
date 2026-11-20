import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDirectoryCards, buildFileCards, extractFileCardFromContent } from "../src/repo/cards.js";
import { walkRepoFiles } from "../src/repo/walker.js";

test("extractFileCardFromContent extracts summaries and symbols across languages", () => {
  const tsCard = extractFileCardFromContent(
    {
      absPath: "/repo/src/auth/jwt.ts",
      relPath: "src/auth/jwt.ts",
      dir: "src/auth",
      ext: "ts",
      size: 200,
      mtimeMs: 1000,
    },
    `/**
 * Handles JWT token signing and refresh rotation.
 */
export interface TokenPair { access: string; refresh: string; }
export async function refreshAccessToken(token: string) { return token; }
export class JwtSigner {}
`
  );
  assert.equal(tsCard.language, "TypeScript");
  assert.match(tsCard.summary, /JWT token signing/);
  assert.ok(tsCard.symbols.includes("TokenPair"));
  assert.ok(tsCard.symbols.includes("refreshAccessToken"));
  assert.ok(tsCard.symbols.includes("JwtSigner"));

  const pyCard = extractFileCardFromContent(
    {
      absPath: "/repo/worker/webhooks.py",
      relPath: "worker/webhooks.py",
      dir: "worker",
      ext: "py",
      size: 200,
      mtimeMs: 1000,
    },
    `"""Retry failed webhook deliveries with exponential backoff."""
class WebhookDispatcher:
    async def dispatch_event(self, payload):
        pass

def schedule_retry(event_id):
    pass
`
  );
  assert.equal(pyCard.language, "Python");
  assert.match(pyCard.summary, /exponential backoff/);
  assert.ok(pyCard.symbols.includes("class WebhookDispatcher"));
  assert.ok(pyCard.symbols.includes("dispatch_event"));
  assert.ok(pyCard.symbols.includes("schedule_retry"));
});

test("buildFileCards skips NUL binary files and caches unmodified cards", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nimble-cards-test-"));
  try {
    await fs.writeFile(path.join(root, "main.go"), "package main\nfunc RunServer() {}\n", "utf8");
    await fs.writeFile(path.join(root, "mystery.raw"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));

    const files = await walkRepoFiles({ rootDir: root });
    const first = await buildFileCards(root, files, { useCache: true });
    assert.equal(first.cards.length, 1);
    assert.equal(first.skippedBinary, 1);
    assert.equal(first.cacheHits, 0);
    assert.equal(first.cacheMisses, 1);

    const second = await buildFileCards(root, files, { useCache: true });
    assert.equal(second.cards.length, 1);
    assert.equal(second.cacheHits, 1);
    assert.equal(second.cacheMisses, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildDirectoryCards collapses deep directories when exceeding maxBuckets", () => {
  const cards = [];
  for (let i = 0; i < 10; i++) {
    cards.push(
      extractFileCardFromContent(
        {
          absPath: `/repo/pkg/sub${i}/deep/file.ts`,
          relPath: `pkg/sub${i}/deep/file.ts`,
          dir: `pkg/sub${i}/deep`,
          ext: "ts",
          size: 30,
          mtimeMs: 1,
        },
        `export function fn${i}() {}`
      )
    );
  }
  const buckets = buildDirectoryCards(cards, 3);
  assert.ok(buckets.length <= 3);
  const totalFiles = buckets.reduce((acc, b) => acc + b.fileCount, 0);
  assert.equal(totalFiles, 10);
});
