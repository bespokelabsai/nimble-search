export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type NimbleQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NimbleRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, NimbleQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type NimbleAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface NimbleUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface NimbleResponse {
  model: string;
  answers: Record<string, NimbleAnswer>;
  usage?: NimbleUsage;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface NimbleClientInterface {
  readonly model: string;
  readonly concurrency: number;
  evaluate(
    state: NimbleRequest["state"],
    questions: Record<string, NimbleQuestion>,
    signal?: AbortSignal
  ): Promise<NimbleResponse>;
  getUsage(): UsageTotals;
  resetUsage(): void;
}
