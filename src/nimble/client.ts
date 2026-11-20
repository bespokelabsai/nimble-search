import type {
  NimbleAnswer,
  NimbleClientInterface,
  NimbleQuestion,
  NimbleRequest,
  NimbleResponse,
  UsageTotals,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.bespokelabs.ai";
export const DEFAULT_MODEL = "nimble-latest";
export const MAX_QUESTIONS_PER_REQUEST = 64;
export const SAFE_MAX_BODY_BYTES = 750 * 1024; // Nimble hard limit is 1 MiB
export const INPUT_PRICE_PER_MILLION_USD = 0.04;

export interface NimbleClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (info: { status?: number; attempt: number; delayMs: number; reason: string }) => void;
}

export class NimbleApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterSec?: number;

  constructor(message: string, status: number, body: string, retryAfterSec?: number) {
    super(message);
    this.name = "NimbleApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}

class AdaptiveSemaphore {
  private maxPermits: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(initialLimit: number) {
    this.maxPermits = Math.max(1, initialLimit);
  }

  get limit(): number {
    return this.maxPermits;
  }

  throttleDown(): void {
    if (this.maxPermits > 3) {
      this.maxPermits = Math.max(3, Math.floor(this.maxPermits / 2));
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxPermits) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.maxPermits && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.active += 1;
        next();
      }
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const numeric = Number(headerValue.trim());
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, (dateMs - Date.now()) / 1000);
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/systemone") || trimmed.endsWith("/v1/nimble/systemone")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/systemone`;
  }
  return `${trimmed}/v1/systemone`;
}

export class NimbleClient implements NimbleClientInterface {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: AdaptiveSemaphore;
  private readonly onRetry?: NimbleClientOptions["onRetry"];

  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(options: NimbleClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.BESPOKE_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "Missing BESPOKE_API_KEY. Set the BESPOKE_API_KEY environment variable or pass apiKey in options."
      );
    }
    this.apiKey = apiKey;
    this.endpoint = normalizeEndpoint(
      options.baseUrl ?? process.env.NIMBLE_BASE_URL ?? DEFAULT_BASE_URL
    );
    this.model = options.model ?? process.env.NIMBLE_MODEL ?? DEFAULT_MODEL;
    const envConc = process.env.NIMBLE_CONCURRENCY
      ? Number(process.env.NIMBLE_CONCURRENCY)
      : undefined;
    const initialConcurrency =
      options.concurrency ?? (envConc && Number.isFinite(envConc) ? envConc : 16);
    this.semaphore = new AdaptiveSemaphore(Math.max(1, Math.min(100, initialConcurrency)));
    this.maxRetries = options.maxRetries ?? 5;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onRetry = options.onRetry;
  }

  get concurrency(): number {
    return this.semaphore.limit;
  }

  getUsage(): UsageTotals {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUsd: (this.inputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION_USD,
    };
  }

  resetUsage(): void {
    this.requests = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  async evaluate(
    state: NimbleRequest["state"],
    questions: Record<string, NimbleQuestion>,
    signal?: AbortSignal
  ): Promise<NimbleResponse> {
    const entries = Object.entries(questions);
    if (entries.length === 0) {
      return { model: this.model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    }

    // Enforce Nimble's 64-question and safe body-size ceilings by auto-splitting if needed.
    const chunks = this.splitIntoSafeBatches(state, entries);
    if (chunks.length > 1) {
      const responses = await Promise.all(
        chunks.map((chunk) => this.evaluateSingle(state, Object.fromEntries(chunk), signal))
      );
      return this.mergeResponses(responses);
    }

    return this.evaluateSingle(state, questions, signal);
  }

  private splitIntoSafeBatches(
    state: NimbleRequest["state"],
    entries: Array<[string, NimbleQuestion]>
  ): Array<Array<[string, NimbleQuestion]>> {
    const baseBytes = Buffer.byteLength(
      JSON.stringify({ model: this.model, state, questions: {} }),
      "utf8"
    );
    const batches: Array<Array<[string, NimbleQuestion]>> = [];
    let current: Array<[string, NimbleQuestion]> = [];
    let currentBytes = baseBytes;

    for (const entry of entries) {
      const entryBytes = Buffer.byteLength(JSON.stringify({ [entry[0]]: entry[1] }), "utf8");
      if (
        current.length > 0 &&
        (current.length >= MAX_QUESTIONS_PER_REQUEST ||
          currentBytes + entryBytes > SAFE_MAX_BODY_BYTES)
      ) {
        batches.push(current);
        current = [];
        currentBytes = baseBytes;
      }
      current.push(entry);
      currentBytes += entryBytes;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private mergeResponses(responses: NimbleResponse[]): NimbleResponse {
    const answers: Record<string, NimbleAnswer> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let model = this.model;
    for (const r of responses) {
      model = r.model || model;
      Object.assign(answers, r.answers);
      inputTokens += r.usage?.input_tokens ?? 0;
      outputTokens += r.usage?.output_tokens ?? 0;
    }
    return {
      model,
      answers,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  private async evaluateSingle(
    state: NimbleRequest["state"],
    questions: Record<string, NimbleQuestion>,
    signal?: AbortSignal
  ): Promise<NimbleResponse> {
    const payload: NimbleRequest = {
      model: this.model,
      state,
      questions,
    };
    const serialized = JSON.stringify(payload);
    const questionEntries = Object.entries(questions);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let status = 0;
      let retryAfterSec: number | undefined;
      try {
        const result = await this.semaphore.run(async () => {
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);
          const combinedSignal = signal
            ? AbortSignal.any([signal, timeoutController.signal])
            : timeoutController.signal;

          try {
            const res = await this.fetchImpl(this.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
              },
              body: serialized,
              signal: combinedSignal,
            });
            status = res.status;
            retryAfterSec = parseRetryAfter(res.headers.get("retry-after"));
            const text = await res.text();
            if (!res.ok) {
              throw new NimbleApiError(
                `Nimble API error (${res.status}): ${text.slice(0, 400)}`,
                res.status,
                text,
                retryAfterSec
              );
            }
            const parsed = JSON.parse(text) as NimbleResponse;
            this.requests += 1;
            this.inputTokens += parsed.usage?.input_tokens ?? 0;
            this.outputTokens += parsed.usage?.output_tokens ?? 0;
            return parsed;
          } finally {
            clearTimeout(timeoutId);
          }
        });
        return result;
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }

        // If the server timed out (504) or rejected payload size (413) on a multi-question batch,
        // split in half and recover automatically.
        if (
          err instanceof NimbleApiError &&
          (err.status === 413 || err.status === 504) &&
          questionEntries.length > 1
        ) {
          const mid = Math.ceil(questionEntries.length / 2);
          const [left, right] = await Promise.all([
            this.evaluateSingle(state, Object.fromEntries(questionEntries.slice(0, mid)), signal),
            this.evaluateSingle(state, Object.fromEntries(questionEntries.slice(mid)), signal),
          ]);
          return this.mergeResponses([left, right]);
        }

        const isRetryableHttp =
          err instanceof NimbleApiError &&
          (err.status === 429 ||
            err.status === 500 ||
            err.status === 502 ||
            err.status === 503 ||
            err.status === 504 ||
            err.status === 529);
        const isNetworkError = !(err instanceof NimbleApiError);

        if (attempt >= this.maxRetries || (!isRetryableHttp && !isNetworkError)) {
          throw err;
        }

        if (err instanceof NimbleApiError && err.status === 429) {
          this.semaphore.throttleDown();
        }

        const baseDelayMs =
          err instanceof NimbleApiError && err.retryAfterSec !== undefined
            ? Math.max(250, err.retryAfterSec * 1000)
            : Math.min(12_000, 600 * Math.pow(2, attempt));
        const jitterMs = Math.floor(Math.random() * 300);
        const delayMs = baseDelayMs + jitterMs;

        this.onRetry?.({
          status: status || undefined,
          attempt: attempt + 1,
          delayMs,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(delayMs, signal);
      }
    }

    throw new Error("Unreachable retry loop exit");
  }
}
