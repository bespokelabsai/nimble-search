import assert from "node:assert/strict";
import test from "node:test";
import { NimbleClient } from "../src/nimble/client.js";
import type { NimbleQuestion, NimbleRequest } from "../src/nimble/types.js";

test("NimbleClient auto-splits requests exceeding 64 questions and aggregates usage", async () => {
  const seenBatchSizes: number[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as NimbleRequest;
    const keys = Object.keys(body.questions);
    seenBatchSizes.push(keys.length);
    const answers = Object.fromEntries(
      keys.map((k) => [
        k,
        { type: "score", score: 2.0, legend: {}, probabilities: {}, confidence: 0.9 },
      ])
    );
    return new Response(
      JSON.stringify({
        model: body.model,
        answers,
        usage: { input_tokens: keys.length * 10, output_tokens: keys.length },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new NimbleClient({ apiKey: "test-key", fetchImpl: fakeFetch });
  const questions: Record<string, NimbleQuestion> = {};
  for (let i = 0; i < 70; i++) {
    questions[`q${i}`] = { type: "score", instructions: `Q ${i}`, criteria: ["no", "yes"] };
  }

  const res = await client.evaluate({ query: "test" }, questions);
  assert.equal(Object.keys(res.answers).length, 70);
  assert.deepEqual(seenBatchSizes.sort((a, b) => b - a), [64, 6]);
  assert.equal(client.getUsage().requests, 2);
  assert.equal(client.getUsage().inputTokens, 700);
});

test("NimbleClient retries 429 with Retry-After and throttles concurrency down", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    const body = JSON.parse(String(init?.body)) as NimbleRequest;
    return new Response(
      JSON.stringify({
        model: body.model,
        answers: {
          q0: { type: "score", score: 1.5, legend: {}, probabilities: {}, confidence: 0.8 },
        },
        usage: { input_tokens: 50, output_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new NimbleClient({
    apiKey: "test-key",
    concurrency: 10,
    fetchImpl: fakeFetch,
  });
  const res = await client.evaluate("state", {
    q0: { type: "score", instructions: "test", criteria: ["a", "b", "c"] },
  });
  assert.equal(calls, 2);
  assert.equal(client.concurrency, 5);
  assert.equal(res.answers.q0?.type, "score");
});

test("NimbleClient splits batch automatically on 504 timeout", async () => {
  const sizes: number[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as NimbleRequest;
    const keys = Object.keys(body.questions);
    sizes.push(keys.length);
    if (keys.length > 2) {
      return new Response("gateway timeout", { status: 504 });
    }
    const answers = Object.fromEntries(
      keys.map((k) => [
        k,
        { type: "score", score: 1.0, legend: {}, probabilities: {}, confidence: 0.7 },
      ])
    );
    return new Response(
      JSON.stringify({ model: body.model, answers, usage: { input_tokens: 20, output_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new NimbleClient({ apiKey: "test-key", fetchImpl: fakeFetch });
  const res = await client.evaluate("state", {
    a: { type: "score", instructions: "a", criteria: ["0", "1"] },
    b: { type: "score", instructions: "b", criteria: ["0", "1"] },
    c: { type: "score", instructions: "c", criteria: ["0", "1"] },
    d: { type: "score", instructions: "d", criteria: ["0", "1"] },
  });
  assert.equal(Object.keys(res.answers).length, 4);
  assert.deepEqual(sizes, [4, 2, 2]);
});
