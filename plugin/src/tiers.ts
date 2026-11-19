import type { Effort, Features, Route, Tier } from './types.ts';

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const MODEL_IDS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-2',
};

/**
 * Each model's context window in tokens, from Anthropic's model table. A conversation that has outgrown a model's
 * window cannot move to it.
 */
export const CONTEXT_WINDOW: Record<Tier, number> = { haiku: 1_000_000, sonnet: 1_000_000, opus: 1_000_000, fable: 1_000_000 };

export const TIER_NAMES: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/** Effort each tier starts from; reasoning depth moves it one step either way. */
const BASE_EFFORT: Record<Tier, Effort> = { haiku: 'medium', sonnet: 'medium', opus: 'high', fable: 'high' };
/** The most a tier is pushed to. xhigh and max cost a lot of plan usage for small gains on most coding work. */
const MAX_EFFORT: Record<Tier, Effort> = { haiku: 'high', sonnet: 'high', opus: 'xhigh', fable: 'xhigh' };

export const rank = (tier: Tier): number => TIERS.indexOf(tier);

export function tierOfModel(id: string | null | undefined): Tier | null {
  const s = String(id ?? '').toLowerCase();
  return TIERS.find((t) => s.includes(t)) ?? null;
}

/** Whether two model ids name the same model: a dated id matches its undated one, and an alias any id of its family. */
export function sameModel(a: string, b: string): boolean {
  const plain = (id: string) => id.toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const x = plain(a);
  const y = plain(b);
  if (x === y) return true;
  const alias = (id: string) => (TIERS as readonly string[]).includes(id);
  return (alias(x) || alias(y)) && tierOfModel(x) === tierOfModel(y);
}

/**
 * Each model's advisor rank, from Claude Code's model catalog. An advisor runs beside a main model only when its rank
 * is at least the main model's; below that the main model runs without it.
 */
const ADVISOR_RANK: Record<string, number> = {
  'claude-haiku-4-5': 1,
  'claude-sonnet-4-6': 2,
  'claude-opus-4-6': 3,
  'claude-haiku-5-5': 4,
  'claude-sonnet-5': 4,
  'claude-opus-4-7': 5,
  'claude-opus-4-8': 5,
  'claude-sonnet-5-5': 6,
  'claude-opus-5': 7,
  'claude-opus-5-5': 7,
  'claude-fable-5': 8,
  'claude-mythos-5': 8,
  'claude-fable-5-1': 9,
  'claude-mythos-5-1': 9,
  'claude-fable-5-2': 10,
  'claude-mythos-5-2': 10,
};

/**
 * A model's advisor rank, by its id or alias, or null for a model the catalog does not rank. An alias ("opus") is its
 * family's current model.
 */
export function advisorRank(model: string | null | undefined): number | null {
  const id = String(model ?? '').toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  if (id in ADVISOR_RANK) return ADVISOR_RANK[id];
  const family = (TIERS as readonly string[]).includes(id) ? (id as Tier) : null;
  return family ? ADVISOR_RANK[MODEL_IDS[family]] : null;
}

/** Whether `advisor` runs beside `model`: its rank is at least the model's. Unranked either way counts as running. */
export function advisorRuns(advisor: string, model: string | null | undefined): boolean {
  const a = advisorRank(advisor);
  const m = advisorRank(model);
  return a === null || m === null || a >= m;
}

/** The strongest tier whose model `advisor` (an alias or a full id) runs beside, or null when it runs beside none. */
export function advisorCeiling(advisor: string): Tier | null {
  const a = advisorRank(advisor);
  if (a === null) return null;
  for (let i = TIERS.length - 1; i >= 0; i -= 1) if (ADVISOR_RANK[MODEL_IDS[TIERS[i]]] <= a) return TIERS[i];
  return null;
}

export function effortFor(tier: Tier, features: Features | null): Effort {
  const base = EFFORTS.indexOf(BASE_EFFORT[tier]);
  const cap = EFFORTS.indexOf(MAX_EFFORT[tier]);
  if (!features) return BASE_EFFORT[tier];
  const step = features.reasoning >= 2.2 ? 1 : features.reasoning <= 0.6 ? -1 : 0;
  return EFFORTS[Math.max(0, Math.min(cap, base + step))];
}

/**
 * The effort a request goes out with. A request Claude Code already raised to xhigh or max (as `ultrathink` does) is
 * never lowered; otherwise the route's effort applies.
 */
export function requestEffort(route: Effort, requested: unknown): Effort {
  if (requested === 'xhigh' || requested === 'max') {
    return EFFORTS.indexOf(requested) > EFFORTS.indexOf(route) ? requested : route;
  }
  return route;
}

/**
 * The route for a tier, stepping down to the next tier the account can use when `available` (the session's
 * availableModels setting) leaves the model out. Returns null when nothing in the table is available.
 */
export function routeFor(tier: Tier, features: Features | null, available?: readonly string[]): Route | null {
  for (let i = rank(tier); i >= 0; i -= 1) {
    const t = TIERS[i];
    if (!available || isAvailable(MODEL_IDS[t], available)) return { model: MODEL_IDS[t], effort: effortFor(t, features) };
  }
  return null;
}

// availableModels may list aliases ("opus") or full ids.
function isAvailable(id: string, available: readonly string[]): boolean {
  const tier = tierOfModel(id);
  return available.some((entry) => entry === id || (tier !== null && entry.toLowerCase() === tier));
}
