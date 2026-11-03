// The decision log and the calibration loop. Each turn leaves one record: what the decision model said, what the
// router picked, and what happened next (a manual /model override, an escalation). `tune` reads the records and
// suggests which way the thresholds should move. Records hold labels and numbers only, never prompt text.

import { rank } from './tiers.ts';
import type { Decision, Features, Mode, Reason, Tier } from './types.ts';

export type Outcome = 'ok' | 'override-up' | 'override-down' | 'escalated';

export type JournalRecord = {
  at: number;
  mode: Mode;
  tier: Tier;
  reason: Reason;
  /** Expected difficulty 0-4, rounded, or null without advice. */
  difficulty: number | null;
  confidence: number | null;
  activity: string | null;
  usedPercent: number | null;
  latencyMs: number | null;
  error: string | null;
  outcome: Outcome;
};

export const MAX_RECORDS = 400;

export function recordOf(args: {
  at: number;
  mode: Mode;
  decision: Decision;
  features: Features | null;
  usedPercent: number | null;
  latencyMs: number | null;
  error: string | null;
}): JournalRecord {
  const f = args.features;
  const total = f ? f.difficulty.reduce((s, p) => s + p, 0) || 1 : 1;
  const top = f ? Object.entries(f.activity).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] : undefined;
  return {
    at: args.at,
    mode: args.mode,
    tier: args.decision.tier,
    reason: args.decision.reason,
    difficulty: f ? Math.round(f.difficulty.reduce((s, p, i) => s + (p / total) * i, 0) * 10) / 10 : null,
    confidence: f ? Math.round(f.confidence * 100) / 100 : null,
    activity: top ? top[0] : null,
    usedPercent: args.usedPercent,
    latencyMs: args.latencyMs,
    error: args.error,
    outcome: 'ok',
  };
}

export function append(records: JournalRecord[], record: JournalRecord): JournalRecord[] {
  return [...records, record].slice(-MAX_RECORDS);
}

/** Marks the newest record with what the person did after it: a manual model change counts against the pick. */
export function markOverride(records: JournalRecord[], chosen: Tier | null): JournalRecord[] {
  const last = records[records.length - 1];
  if (!last || !chosen || chosen === last.tier) return records;
  const outcome: Outcome = rank(chosen) > rank(last.tier) ? 'override-up' : 'override-down';
  return [...records.slice(0, -1), { ...last, outcome }];
}

export function markEscalated(records: JournalRecord[]): JournalRecord[] {
  const last = records[records.length - 1];
  return last ? [...records.slice(0, -1), { ...last, outcome: 'escalated' }] : records;
}

export type Tuning = {
  decisions: number;
  upRate: number;
  downRate: number;
  /** Suggested preference, from the balance of corrections. */
  suggestion: 'raise' | 'lower' | 'keep';
  latencyMedianMs: number | null;
  errorRate: number;
  tierShare: Partial<Record<Tier, number>>;
};

/**
 * Corrections upward (overrides up, escalations) mean the router picks too cheap; corrections downward mean too
 * expensive. Twenty decisions are needed before suggesting anything.
 */
export function tune(records: JournalRecord[]): Tuning {
  const decided = records.filter((r) => !r.error && r.mode !== 'off');
  const n = decided.length;
  const up = decided.filter((r) => r.outcome === 'override-up' || r.outcome === 'escalated').length;
  const down = decided.filter((r) => r.outcome === 'override-down').length;
  const latencies = records
    .map((r) => r.latencyMs)
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);
  const share: Partial<Record<Tier, number>> = {};
  for (const r of decided) share[r.tier] = (share[r.tier] ?? 0) + 1 / n;
  const upRate = n ? up / n : 0;
  const downRate = n ? down / n : 0;
  return {
    decisions: n,
    upRate,
    downRate,
    suggestion: n < 20 ? 'keep' : upRate - downRate > 0.1 ? 'raise' : downRate - upRate > 0.1 ? 'lower' : 'keep',
    latencyMedianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    errorRate: records.length ? records.filter((r) => r.error).length / records.length : 0,
    tierShare: share,
  };
}
