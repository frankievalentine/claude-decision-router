// Describe, then decide. The decision model answers questions about the task; this file turns those answers into a
// probability for each tier. Keeping the uncertainty (a distribution, not one tier) lets the policy require evidence
// before switching, which protects the prompt cache.

import type { Activity, Distribution, Features, Scope, Settings, Tier } from './types.ts';

export type FeatureWeights = {
  difficulty: number;
  reasoning: number;
  scope: number;
  /** Demand below thresholds[0] is Haiku work, below [1] Sonnet, below [2] Opus, above that Fable. */
  thresholds: [number, number, number];
  /** Fable needs this much probability on "very hard" (difficulty level 4). */
  fableMinVeryHard: number;
};

export const WEIGHTS: FeatureWeights = {
  difficulty: 0.5,
  reasoning: 0.3,
  scope: 0.2,
  thresholds: [0.22, 0.5, 0.82],
  fableMinVeryHard: 0.5,
};

const SCOPE_WEIGHT: Record<Scope, number> = { spot: 0, file: 0.25, few_files: 0.5, many_files: 0.75, system: 1 };
const ACTIVITY_BIAS: Record<Activity, number> = {
  explore: -0.08,
  docs: -0.08,
  ops: -0.05,
  code: 0,
  review: 0,
  debug: 0.05,
  plan: 0.08,
};
// Preference moves the demand thresholds: cost raises them (cheaper tiers), quality lowers them.
const PREFERENCE_SHIFT = { cost: 0.06, balanced: 0, quality: -0.06 };

const TIER_NAMES: Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];
const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

function expected<K extends string>(dist: Distribution<K>, weight: Record<K, number>): number {
  let total = 0;
  let sum = 0;
  for (const key of Object.keys(weight) as K[]) {
    const p = dist[key] ?? 0;
    total += p;
    sum += p * weight[key];
  }
  return total > 0 ? sum / total : 0.25;
}

/** The demand (0 to 1) of a task at difficulty level `level`, given the other features. */
export function demandAt(level: number, f: Features, w: FeatureWeights = WEIGHTS): number {
  const scope = expected(f.scope, SCOPE_WEIGHT);
  const bias = expected(f.activity, ACTIVITY_BIAS);
  return clamp(w.difficulty * (level / 4) + w.reasoning * (f.reasoning / 3) + w.scope * scope + bias);
}

/** The probability of each tier for these features. Every mass the rules remove moves to the next tier down or up. */
export function tierDistribution(
  f: Features,
  settings: Pick<Settings, 'preference' | 'allowFable'>,
  w: FeatureWeights = WEIGHTS,
): Distribution<Tier> {
  const shift = PREFERENCE_SHIFT[settings.preference];
  const [a, b, c] = w.thresholds.map((t) => t + shift);
  const dist: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0, fable: 0 };
  const total = f.difficulty.reduce((s, p) => s + p, 0) || 1;
  f.difficulty.forEach((p, level) => {
    const d = demandAt(level, f, w);
    const tier: Tier = d < a ? 'haiku' : d < b ? 'sonnet' : d < c ? 'opus' : 'fable';
    dist[tier] += p / total;
  });
  // Fable is the most expensive tier and may bill to usage credits: it needs a clear "very hard" answer, and it is
  // never used for security-sensitive work (Fable 5.1 carries extra safety measures for cybersecurity).
  const veryHard = (f.difficulty[4] ?? 0) / total;
  if (!settings.allowFable || veryHard < w.fableMinVeryHard || f.security >= 0.5) {
    dist.opus += dist.fable;
    dist.fable = 0;
  }
  // Security-sensitive work gets at least Sonnet.
  if (f.security >= 0.5) {
    dist.sonnet += dist.haiku;
    dist.haiku = 0;
  }
  return dist;
}

/**
 * Confidence in the tier pick, from the tier distribution the policy acts on: 0 when the probability is spread evenly
 * over Haiku, Sonnet and Opus, 1 when one tier has it all. The difficulty answer alone misleads here: a task split
 * between "easy" and "moderate" is uncertain about the level but not about the tier when both levels map to Sonnet.
 * Always measured against three tiers, so `min_confidence` means the same whether or not Fable is allowed.
 */
export function tierConfidence(dist: Distribution<Tier>): number {
  const masses = TIER_NAMES.map((t) => dist[t] ?? 0);
  const total = masses.reduce((s, p) => s + p, 0);
  if (total <= 0) return 0;
  const peak = Math.max(...masses) / total;
  return Math.min(1, Math.max(0, (3 * peak - 1) / 2));
}

/** The tier with the most probability; ties go to the cheaper tier. */
export function mostLikely(dist: Distribution<Tier>): Tier {
  let best: Tier = 'sonnet';
  let bestP = -1;
  for (const t of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
    const p = dist[t] ?? 0;
    if (p > bestP) {
      best = t;
      bestP = p;
    }
  }
  return best;
}

/** A one-line summary for the band and the log: "debug · hard · 0.86". */
export function describe(f: Features): string {
  const total = f.difficulty.reduce((s, p) => s + p, 0) || 1;
  const level = f.difficulty.reduce((s, p, i) => s + (p / total) * i, 0);
  const label = ['trivial', 'easy', 'moderate', 'hard', 'very hard'][Math.round(level)];
  const activity = (Object.entries(f.activity) as [Activity, number][]).sort((x, y) => y[1] - x[1])[0]?.[0];
  return [activity, label, f.confidence.toFixed(2)].filter(Boolean).join(' · ');
}
