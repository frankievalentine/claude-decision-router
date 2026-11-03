import type { Effort, Features, Route, Tier } from './types.ts';

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const MODEL_IDS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

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
