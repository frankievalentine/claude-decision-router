// When to switch tiers. Ideas ported from claude-router's switching policy (MIT, Alexei Ledenev): vote streaks before a
// move, a higher bar when a switch would throw away a large prompt cache, a hold after an escalation, and no cheaper
// move in the middle of a task. Added here: a bar that rises with plan usage, and a cap on expensive tiers near the
// limit. Pure: every input is an argument.

import { mostLikely } from './features.ts';
import { rank, TIERS } from './tiers.ts';
import type { Decision, Distribution, PlanUsage, PolicyState, Preference, Reason, Tier } from './types.ts';

export const POLICY = {
  /** Probability above the current tier a move up needs, before the adjustments below. */
  upgradeBar: 0.6,
  /** Probability at or below a cheaper tier a move down needs. */
  downgradeBar: 0.8,
  /** Consecutive answers pointing the same way a move needs; a strong answer needs one. */
  votes: 2,
  /** How far past the bar an answer counts as strong. */
  strongMargin: 0.15,
  /** A jump of two or more tiers in one move needs this much probability above the current tier. */
  jumpBar: 0.9,
  /** A message this likely to continue the running task never moves to a cheaper tier. */
  continuationBar: 0.7,
  /** Losing the prompt cache costs more as the context grows: the bar rises by up to `cacheSlope`. */
  cacheSlope: 0.15,
  /** The context size, in tokens, at which half of `cacheSlope` applies. */
  cachePivotTokens: 150_000,
  /** Turns the tier stays put after an escalation. */
  holdTurns: 2,
  /** Tool errors in one turn that escalate to the next tier. */
  escalateAfterErrors: 3,
};

/** [percent used, how much both bars move]: as the plan fills, moving up gets harder and moving down easier. */
export const USAGE_STEPS: [number, number][] = [
  [50, 0.03],
  [75, 0.08],
  [90, 0.15],
];
/** From this much usage the top tier is Opus (no Fable); from the second, Sonnet. */
export const USAGE_CAPS = { noFableAt: 75, sonnetOnlyAt: 95 };

const PREFERENCE_BAR = { cost: 0.06, balanced: 0, quality: -0.06 };

export const initialState = (): PolicyState => ({ tier: null, votes: [], hold: 0 });

export function usageShift(h: PlanUsage): number {
  if (h.usedPercent === null) return 0;
  let shift = 0;
  for (const [at, s] of USAGE_STEPS) if (h.usedPercent >= at) shift = s;
  return shift;
}

/** The most expensive tier the plan's usage allows now. */
export function usageCap(h: PlanUsage): Tier {
  if (h.usedPercent === null) return 'fable';
  if (h.usedPercent >= USAGE_CAPS.sonnetOnlyAt) return 'sonnet';
  if (h.usedPercent >= USAGE_CAPS.noFableAt) return 'opus';
  return 'fable';
}

export function cacheShift(contextTokens: number | null): number {
  if (!contextTokens || contextTokens <= 0) return 0;
  return POLICY.cacheSlope * (contextTokens / (contextTokens + POLICY.cachePivotTokens));
}

const above = (d: Distribution<Tier>, t: Tier): number =>
  TIERS.filter((x) => rank(x) > rank(t)).reduce((s, x) => s + (d[x] ?? 0), 0);
const atOrBelow = (d: Distribution<Tier>, t: Tier): number =>
  TIERS.filter((x) => rank(x) <= rank(t)).reduce((s, x) => s + (d[x] ?? 0), 0);
const capped = (t: Tier, cap: Tier): Tier => (rank(t) > rank(cap) ? cap : t);

function streak(votes: Tier[], pass: (t: Tier) => boolean): number {
  let n = 0;
  for (let i = votes.length - 1; i >= 0 && pass(votes[i]); i -= 1) n += 1;
  return n;
}

export type DecideInput = {
  state: PolicyState;
  /** The tier distribution from the features, or null when the classifier gave no answer. */
  distribution: Distribution<Tier> | null;
  confidence: number;
  continuation: number;
  usage: PlanUsage;
  contextTokens: number | null;
  preference: Preference;
  minConfidence: number;
  baseline: Tier;
};

export function decide(input: DecideInput): Decision {
  const { state, distribution: dist, usage } = input;
  const cap = usageCap(usage);
  const incumbent = state.tier ?? input.baseline;
  const out = (
    tier: Tier,
    reason: Reason,
    next: PolicyState,
    bar: number | null = null,
    mass: number | null = null,
  ): Decision => ({
    tier,
    reason,
    distribution: dist,
    bar,
    mass,
    state: { ...next, tier },
  });

  // Over the cap (the plan filled up while a tier ran): step down to the cap whatever the advice says.
  if (state.tier && rank(state.tier) > rank(cap)) return out(cap, 'usage-cap', { ...state, votes: [] });
  if (!dist) return out(capped(incumbent, cap), 'no-advice', state);
  if (input.confidence < input.minConfidence) return out(capped(incumbent, cap), 'low-confidence', state);

  const choice = capped(mostLikely(dist), cap);
  const votes = [...state.votes.slice(-2), choice];
  const next: PolicyState = { ...state, votes };
  if (state.tier === null) return out(choice, 'first', next);
  if (state.hold > 0) return out(incumbent, 'hold', { ...next, hold: state.hold - 1 });
  if (choice === incumbent) return out(incumbent, 'stay', next);

  const shift = usageShift(usage) + PREFERENCE_BAR[input.preference];
  const cache = cacheShift(input.contextTokens);

  if (rank(choice) > rank(incumbent)) {
    const bar = Math.min(0.97, POLICY.upgradeBar + cache + shift);
    const mass = above(dist, incumbent);
    const jump = rank(choice) - rank(incumbent) >= 2 && mass >= Math.max(bar, POLICY.jumpBar);
    const needed = mass >= bar + POLICY.strongMargin ? 1 : POLICY.votes;
    const count = streak(votes, (t) => rank(t) > rank(incumbent));
    if (jump) return out(choice, 'jump', next, bar, mass);
    if (mass >= bar && count >= needed) {
      // Move one tier at a time unless the answer jumped.
      const target = TIERS[rank(incumbent) + 1];
      return out(capped(target, cap), 'upgrade', next, bar, mass);
    }
    return out(incumbent, 'stay', next, bar, mass);
  }

  // A cheaper tier: never in the middle of a task, where the cache and the work so far are on the current model.
  if (input.continuation >= POLICY.continuationBar) return out(incumbent, 'same-task', next);
  const bar = Math.max(0.5, Math.min(0.97, POLICY.downgradeBar + cache - shift));
  for (const target of TIERS.filter((t) => rank(t) >= rank(choice) && rank(t) < rank(incumbent))) {
    const mass = atOrBelow(dist, target);
    const count = streak(votes, (t) => rank(t) <= rank(target));
    if (mass >= bar && count >= POLICY.votes) return out(target, 'downgrade', next, bar, mass);
  }
  return out(incumbent, 'stay', next, bar, atOrBelow(dist, choice));
}

/** One tier up after repeated failures, within the plan-usage cap, then a hold so the stronger model gets a chance. */
export function escalate(state: PolicyState, baseline: Tier, usage: PlanUsage): Decision | null {
  const current = state.tier ?? baseline;
  const target = TIERS[rank(current) + 1];
  if (!target || rank(target) > rank(usageCap(usage))) return null;
  return {
    tier: target,
    reason: 'escalation',
    distribution: null,
    bar: null,
    mass: null,
    state: { tier: target, votes: [], hold: POLICY.holdTurns },
  };
}
