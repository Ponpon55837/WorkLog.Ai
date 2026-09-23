export const INSIGHT_PROVIDER_EXECUTIONS = ["local", "external"] as const;
export type InsightProviderExecution = (typeof INSIGHT_PROVIDER_EXECUTIONS)[number];

export interface InsightProviderDescriptor {
  id: string;
  execution: InsightProviderExecution;
  model: string;
}

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
};

export type InsightQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface InsightSignal<T> {
  value: T;
  confidence?: number;
  probability?: number;
  distribution?: Record<string, number>;
}

export interface InsightEvaluation {
  provider: string;
  model: string;
  results: Record<string, InsightSignal<unknown>>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    requestUnits?: number;
    estimatedCost?: number;
    currency?: string;
  };
  latencyMs: number;
  evaluatedAt: string;
  adapterVersion?: string;
}

export const INSIGHT_AVAILABILITIES = [
  "available",
  "disabled",
  "policy_denied",
  "failed",
  "budget_exceeded"
] as const;

export type InsightAvailability = (typeof INSIGHT_AVAILABILITIES)[number];

export interface InsightProvider {
  readonly descriptor: InsightProviderDescriptor;
  evaluate(input: {
    state: Record<string, unknown>;
    questions: Record<string, InsightQuestion>;
  }): Promise<InsightEvaluation>;
}

export const NOOP_INSIGHT_PROVIDER_DESCRIPTOR = {
  id: "noop",
  execution: "local",
  model: "none"
} as const satisfies InsightProviderDescriptor;

/**
 * Phase 1 placeholder: it never performs egress and deliberately emits no
 * derived signals. Availability is resolved by the future execution guard.
 */
export class NoopInsightProvider implements InsightProvider {
  public readonly descriptor = NOOP_INSIGHT_PROVIDER_DESCRIPTOR;

  public async evaluate(_input: {
    state: Record<string, unknown>;
    questions: Record<string, InsightQuestion>;
  }): Promise<InsightEvaluation> {
    return {
      provider: this.descriptor.id,
      model: this.descriptor.model,
      results: {},
      latencyMs: 0,
      evaluatedAt: new Date().toISOString()
    };
  }
}
