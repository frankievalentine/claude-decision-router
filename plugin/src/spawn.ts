// What the router would pick for a subagent, without changing anything. Which subagents get a pick, the pick itself,
// and the log of what each one then used. Records hold labels and numbers only, never the subagent's prompt. Pure:
// every input is an argument.

import { mostLikely, tierConfidence, tierDistribution } from './features.ts';
import { usageCap } from './policy.ts';
import { rank } from './tiers.ts';
import type { Features, PlanUsage, Preference, Tier } from './types.ts';

export type SpawnMode = 'watch' | 'off';

/** What sort of subagent this is. Only `explore` and `general` get a pick. */
export type SpawnKind = 'explore' | 'general' | 'plan' | 'builtin' | 'custom' | 'explicit' | 'fork' | 'teammate' | 'workflow' | 'resume';

/** How a record's pick came about. `pending` waits for the decision model, and stays if the session ended first. */
export type PickReason = 'rule' | 'advice' | 'low-confidence' | 'no-advice' | 'not-routed' | 'pending';

export type SpawnRecord = {
  /** The subagent's id, which ties later events to this record. */
  id: string;
  at: number;
  kind: SpawnKind;
  /** The tier it ran on, or null for a model the router does not know. */
  actual: Tier | null;
  /** The tier the router would have used, or null without a pick. */
  pick: Tier | null;
  reason: PickReason;
  activity: string | null;
  confidence: number | null;
  latencyMs: number | null;
  error: string | null;
  /** Input tokens, the cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolErrors: number;
};

export const MAX_SPAWN_RECORDS = 400;

type SpawnFacts = {
  subagentType: string;
  model?: string;
  fork?: boolean;
  isTeammate?: boolean;
  workflow?: unknown;
  resume?: unknown;
  provider?: { plugin?: string };
};

/**
 * The checks run in order. A model Claude named outranks the agent's type, and a definition that is not built in may
 * pin a model in its frontmatter, which the event does not show, so it counts as custom even when named Explore.
 */
export function kindOf(e: SpawnFacts): SpawnKind {
  if (e.fork) return 'fork';
  if (e.resume) return 'resume';
  if (e.isTeammate) return 'teammate';
  if (e.workflow) return 'workflow';
  if (e.model) return 'explicit';
  if (e.provider?.plugin !== 'engine') return 'custom';
  if (e.subagentType === 'Explore') return 'explore';
  if (e.subagentType === 'general-purpose') return 'general';
  if (e.subagentType === 'Plan') return 'plan';
  return 'builtin';
}

const atMost = (t: Tier, cap: Tier): Tier => (rank(t) > rank(cap) ? cap : t);

export type SpawnSettings = { preference: Preference; minConfidence: number; usage: PlanUsage };

/**
 * The pick for a general subagent from the decision model's answer: never above what it actually ran on, or what the
 * plan's usage allows. Fable stays out of it, and security-sensitive work keeps its floor from the tier distribution.
 */
export function pickFor(features: Features | null, actual: Tier | null, s: SpawnSettings): { pick: Tier | null; reason: PickReason; confidence: number | null } {
  if (!features) return { pick: null, reason: 'no-advice', confidence: null };
  const distribution = tierDistribution(features, { preference: s.preference, allowFable: false });
  const confidence = Math.round(tierConfidence(distribution) * 100) / 100;
  if (!actual) return { pick: null, reason: 'not-routed', confidence };
  if (confidence < s.minConfidence) return { pick: null, reason: 'low-confidence', confidence };
  return { pick: atMost(atMost(mostLikely(distribution), actual), usageCap(s.usage)), reason: 'advice', confidence };
}

export function recordOfSpawn(id: string, at: number, kind: SpawnKind, actual: Tier | null): SpawnRecord {
  const blank = { id, at, kind, actual, activity: null, confidence: null, latencyMs: null, error: null, inputTokens: 0, cachedTokens: 0, outputTokens: 0, toolErrors: 0 };
  if (kind === 'explore' && actual) return { ...blank, pick: 'haiku', reason: 'rule' };
  if (kind === 'general' && actual) return { ...blank, pick: null, reason: 'pending' };
  return { ...blank, pick: null, reason: 'not-routed' };
}

export function appendSpawn(records: SpawnRecord[], record: SpawnRecord): SpawnRecord[] {
  return [...records, record].slice(-MAX_SPAWN_RECORDS);
}

export function updateSpawn(records: SpawnRecord[], id: string, patch: (r: SpawnRecord) => Partial<SpawnRecord>): SpawnRecord[] {
  return records.map((r) => (r.id === id ? { ...r, ...patch(r) } : r));
}

/** Adds one model request's usage. A request's input is split in three by the API; the record keeps the whole. */
export function addUsage(r: SpawnRecord, usage: any): Partial<SpawnRecord> {
  const n = (x: unknown) => Number(x) || 0;
  const cached = n(usage?.cache_read_input_tokens);
  return {
    inputTokens: r.inputTokens + n(usage?.input_tokens) + cached + n(usage?.cache_creation_input_tokens),
    cachedTokens: r.cachedTokens + cached,
    outputTokens: r.outputTokens + n(usage?.output_tokens),
  };
}

export const isCheaper = (r: SpawnRecord): boolean => r.pick !== null && r.actual !== null && rank(r.pick) < rank(r.actual);

export type SpawnSummary = {
  seen: number;
  byKind: Partial<Record<SpawnKind, number>>;
  /** Subagents with a pick, and how many of those picks were cheaper than what ran. */
  picked: number;
  cheaper: number;
  /** All tokens of the subagents with a cheaper pick: the work a route could have moved. */
  cheaperTokens: number;
  totalTokens: number;
  toolErrors: number;
  /** Subagents that hit at least one tool error. */
  withErrors: number;
  /** Requests to the decision model that failed, of those made. */
  askErrors: number;
  asked: number;
  latencyMedianMs: number | null;
};

export function summarize(records: SpawnRecord[]): SpawnSummary {
  const tokensOf = (r: SpawnRecord) => r.inputTokens + r.outputTokens;
  const total = (rs: SpawnRecord[], f: (r: SpawnRecord) => number) => rs.reduce((s, r) => s + f(r), 0);
  const byKind: Partial<Record<SpawnKind, number>> = {};
  for (const r of records) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const cheaper = records.filter(isCheaper);
  const asked = records.filter((r) => r.kind === 'general' && r.reason !== 'pending' && r.reason !== 'not-routed');
  const latencies = asked
    .map((r) => r.latencyMs)
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);
  return {
    seen: records.length,
    byKind,
    picked: records.filter((r) => r.pick !== null).length,
    cheaper: cheaper.length,
    cheaperTokens: total(cheaper, tokensOf),
    totalTokens: total(records, tokensOf),
    toolErrors: total(records, (r) => r.toolErrors),
    withErrors: records.filter((r) => r.toolErrors > 0).length,
    askErrors: asked.filter((r) => r.error).length,
    asked: asked.length,
    latencyMedianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
  };
}
