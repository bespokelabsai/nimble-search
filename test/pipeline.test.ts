import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  NimbleAnswer,
  NimbleClientInterface,
  NimbleQuestion,
  NimbleRequest,
  NimbleResponse,
  UsageTotals,
} from "../src/nimble/types.js";
import { formatSearchResultsText } from "../src/search/format.js";
import { searchCodebase } from "../src/search/pipeline.js";

class MockNimbleClient implements NimbleClientInterface {
  readonly model = "nimble-mock";
  readonly concurrency = 8;
  requests = 0;
  inputTokens = 0;
  readonly calls: Array<{ state: NimbleRequest["state"]; keys: string[] }> = [];

  async evaluate(
    state: NimbleRequest["state"],
    questions: Record<string, NimbleQuestion>
  ): Promise<NimbleResponse> {
    this.requests += 1;
    const keys = Object.keys(questions);
    this.calls.push({ state, keys });
    const answers: Record<string, NimbleAnswer> = {};

    for (const [key, q] of Object.entries(questions)) {
      // Stage 1 / dir triage puts query in object `state` and file/dir card in `q.instructions`.
      // Stage 2 puts file content in string `state` and query in `q.instructions`.
      const hay = (typeof state === "string" ? state : q.instructions).toLowerCase();
      if (q.type === "score") {
        let rawScore = 0.05;
        if (hay.includes("jwt") && hay.includes("refresh")) {
          rawScore = hay.includes("test") ? 2.1 : 2.9;
        } else if (hay.includes("auth")) {
          rawScore = 1.6;
        }
        answers[key] = {
          type: "score",
          score: rawScore,
          legend: {},
          probabilities: {},
          confidence: 0.9,
        };
      } else if (q.type === "choice") {
        const isTest = hay.includes(".test.") || hay.includes("describe(");
        const choice = isTest ? "test" : hay.includes("middleware") ? "caller" : "implementation";
        answers[key] = {
          type: "choice",
          choice,
          probabilities: { [choice]: 0.92 },
          confidence: 0.92,
        };
      }
    }

    const tokens = keys.length * 40;
    this.inputTokens += tokens;
    return {
      model: this.model,
      answers,
      usage: { input_tokens: tokens, output_tokens: keys.length },
    };
  }

  getUsage(): UsageTotals {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.requests,
      estimatedCostUsd: (this.inputTokens / 1_000_000) * 0.04,
    };
  }

  resetUsage(): void {
    this.requests = 0;
    this.inputTokens = 0;
  }
}

async function createSampleRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nimble-pipeline-test-"));
  const files: Record<string, string> = {
    "src/auth/jwt.ts":
      "// Signs and rotates JWT refresh tokens\nexport function refreshToken(t: string) { return t; }\n",
    "src/auth/jwt.test.ts":
      "import { refreshToken } from './jwt.js';\ndescribe('jwt refresh', () => {});\n",
    "src/middleware/session.ts":
      "import { refreshToken } from '../auth/jwt.js';\nexport function authMiddleware() {}\n",
    "src/ui/Button.tsx": "export function Button() { return '<button />'; }\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

test("searchCodebase runs two-stage verification, classifies roles, and formats output", async () => {
  const root = await createSampleRepo();
  try {
    const mock = new MockNimbleClient();
    const res = await searchCodebase(mock, {
      query: "file that rotates JWT refresh tokens",
      rootDir: root,
      mode: "balanced",
      useCache: false,
    });

    assert.equal(res.stats.totalFilesScanned, 4);
    assert.equal(res.stats.usedDirectoryTriage, false);
    assert.equal(res.stats.stage2Verified, 4);
    assert.equal(res.results[0]?.path, "src/auth/jwt.ts");
    assert.equal(res.results[0]?.role, "implementation");
    assert.equal(res.results[0]?.verified, true);

    const testMatch = res.results.find((r) => r.path === "src/auth/jwt.test.ts");
    assert.equal(testMatch?.role, "test");

    const text = formatSearchResultsText(res);
    assert.match(text, /\[implementation\]\s+src\/auth\/jwt\.ts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("searchCodebase fast mode skips Stage 2 and role filter restricts verified matches", async () => {
  const root = await createSampleRepo();
  try {
    const mockFast = new MockNimbleClient();
    const fastRes = await searchCodebase(mockFast, {
      query: "JWT refresh",
      rootDir: root,
      mode: "fast",
      useCache: false,
    });
    assert.equal(fastRes.stats.stage2Verified, 0);
    assert.equal(fastRes.results[0]?.verified, false);
    assert.equal(fastRes.results[0]?.role, undefined);

    const mockRole = new MockNimbleClient();
    const implOnly = await searchCodebase(mockRole, {
      query: "JWT refresh",
      rootDir: root,
      mode: "balanced",
      roles: ["implementation"],
      useCache: false,
    });
    assert.ok(implOnly.results.length >= 1);
    assert.ok(implOnly.results.every((r) => r.role === "implementation"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("searchCodebase triggers hierarchical directory triage on large repos", async () => {
  const root = await createSampleRepo();
  try {
    // Add extra directories to exceed a small custom threshold
    for (let i = 0; i < 6; i++) {
      const abs = path.join(root, `packages/svc${i}/handler.ts`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `export function handleSvc${i}() {}\n`, "utf8");
    }

    const mock = new MockNimbleClient();
    const res = await searchCodebase(mock, {
      query: "JWT refresh tokens",
      rootDir: root,
      mode: "fast",
      dirTriageThreshold: 5,
      maxStage1Files: 6,
      useCache: false,
    });

    assert.equal(res.stats.usedDirectoryTriage, true);
    assert.ok(res.stats.directoriesScored >= 5);
    assert.equal(res.results[0]?.path, "src/auth/jwt.ts");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
