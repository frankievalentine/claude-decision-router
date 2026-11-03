// Shared types. Erasable syntax only (no enum, namespace or parameter properties), so the file runs wherever
// TypeScript is loaded by stripping types.

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Activity = 'code' | 'debug' | 'explore' | 'plan' | 'review' | 'ops' | 'docs';
export type Scope = 'spot' | 'file' | 'few_files' | 'many_files' | 'system';
export type Backend = 'clef-workers' | 'jev-api' | 'local' | 'llamacpp';
export type Preference = 'cost' | 'balanced' | 'quality';
export type Mode = 'watch' | 'route' | 'off';

/** A probability for each value of a question. */
export type Distribution<K extends string> = Partial<Record<K, number>>;

/** What the decision model said about a task. It describes the task; it never names a model. */
export type Features = {
  /** Difficulty levels 0 (trivial) to 4 (very hard), with a probability each. */
  difficulty: number[];
  /** The decision model's confidence in the difficulty answer, 0 to 1. */
  confidence: number;
  /** Expected reasoning depth, 0 (none) to 3 (extensive). */
  reasoning: number;
  scope: Distribution<Scope>;
  activity: Distribution<Activity>;
  /** Probability the task is security-sensitive. */
  security: number;
  /** Probability the message continues the task already running. */
  continuation: number;
};

/** The policy's view of the plan: the highest percent used across the 5-hour and weekly windows, or null. */
export type PlanUsage = { usedPercent: number | null };

export type Settings = {
  preference: Preference;
  allowFable: boolean;
  minConfidence: number;
  /** Tier used before any decision, and when the classifier is unsure. */
  baseline: Tier;
};

export type PolicyState = {
  /** The tier the router runs (or, in watch mode, would run). Null before the first decision. */
  tier: Tier | null;
  /** The most likely tier of the last few answers, newest last. */
  votes: Tier[];
  /** Turns left in which the tier stays put after an escalation. */
  hold: number;
};

export type Reason =
  | 'first'
  | 'stay'
  | 'upgrade'
  | 'jump'
  | 'downgrade'
  | 'hold'
  | 'same-task'
  | 'low-confidence'
  | 'no-advice'
  | 'escalation'
  | 'usage-cap'
  | 'pinned';

export type Decision = {
  tier: Tier;
  reason: Reason;
  /** The tier distribution the decision was made on, or null without advice. */
  distribution: Distribution<Tier> | null;
  /** The bar a move had to clear, for the log. */
  bar: number | null;
  /** The probability the move weighed against `bar`: above the current tier going up, at or below going down. */
  mass: number | null;
  state: PolicyState;
};

export type Route = { model: string; effort: Effort };
