import { expect, test } from 'claude-code/testing'
import { backendOf, confidenceOf, endpointFor, hostOf, parseAnswers, warmupBody } from '../src/classifier.ts'
import { mostLikely, tierDistribution } from '../src/features.ts'
import { append, markOverride, recordOf, tune } from '../src/journal.ts'
import type { JournalRecord } from '../src/journal.ts'
import { decide, escalate, usageCap, initialState } from '../src/policy.ts'
import type { DecideInput } from '../src/policy.ts'
import { routeFor, tierOfModel } from '../src/tiers.ts'
import type { Features, Tier } from '../src/types.ts'

// A features object with difficulty concentrated on `level` (0-4).
function features(level: number, extra: Partial<Features> = {}): Features {
  const difficulty = [0, 0, 0, 0, 0]
  difficulty[level] = 0.9
  difficulty[Math.min(4, level + 1)] += 0.05
  difficulty[Math.max(0, level - 1)] += 0.05
  return {
    difficulty,
    confidence: 0.9,
    reasoning: [0.2, 0.8, 1.6, 2.4, 2.9][level],
    scope: { spot: level < 2 ? 1 : 0, file: level === 2 ? 1 : 0, many_files: level > 2 ? 1 : 0 },
    activity: { code: 1 },
    security: 0,
    continuation: 0,
    ...extra,
  }
}
const SETTINGS = { preference: 'balanced', allowFable: true } as const
const dist = (f: Features) => tierDistribution(f, SETTINGS)
const input = (over: Partial<DecideInput>): DecideInput => ({
  state: initialState(),
  distribution: null,
  confidence: 0.9,
  continuation: 0,
  usage: { usedPercent: 10 },
  contextTokens: 20_000,
  preference: 'balanced',
  minConfidence: 0.45,
  baseline: 'sonnet',
  ...over,
})

test('features map to the expected tiers', async () => {
  expect(mostLikely(dist(features(0)))).toBe('haiku')
  expect(mostLikely(dist(features(2)))).toBe('sonnet')
  expect(mostLikely(dist(features(3)))).toBe('opus')
  expect(mostLikely(dist(features(4)))).toBe('fable')
})

test('Fable is gated: off, security work, or not clearly very hard', async () => {
  expect(mostLikely(tierDistribution(features(4), { preference: 'balanced', allowFable: false }))).toBe('opus')
  expect(mostLikely(dist(features(4, { security: 0.9 })))).toBe('opus')
  const unsure = features(4)
  unsure.difficulty = [0, 0, 0.2, 0.4, 0.4]
  expect(dist(unsure).fable ?? 0).toBe(0)
})

test('security work never runs on Haiku', async () => {
  expect(dist(features(0, { security: 0.8 })).haiku).toBe(0)
})

test('the distribution keeps uncertainty instead of one tier', async () => {
  const f = features(2)
  f.difficulty = [0, 0.1, 0.45, 0.45, 0]
  const d = dist(f)
  expect((d.sonnet ?? 0) > 0.3 && (d.opus ?? 0) > 0.3).toBe(true)
})

test('first decision takes the most likely tier', async () => {
  const d = decide(input({ distribution: dist(features(3)) }))
  expect(d.tier).toBe('opus')
  expect(d.reason).toBe('first')
})

test('a moderate answer does not switch on one vote', async () => {
  const state = { tier: 'sonnet' as Tier, votes: ['sonnet' as Tier], hold: 0 }
  const split = { sonnet: 0.35, opus: 0.65 }
  const one = decide(input({ state, distribution: split }))
  expect(one.tier).toBe('sonnet')
  const two = decide(input({ state: one.state, distribution: split }))
  expect(two.tier).toBe('opus')
  expect(two.reason).toBe('upgrade')
})

test('a strong answer switches at once', async () => {
  const state = { tier: 'sonnet' as Tier, votes: [], hold: 0 }
  expect(decide(input({ state, distribution: { opus: 0.85, sonnet: 0.15 } })).tier).toBe('opus')
})

test('a big context raises the bar for switching', async () => {
  const state = { tier: 'sonnet' as Tier, votes: ['opus' as Tier], hold: 0 }
  const split = { sonnet: 0.3, opus: 0.7 }
  expect(decide(input({ state, distribution: split, contextTokens: 10_000 })).tier).toBe('opus')
  expect(decide(input({ state, distribution: split, contextTokens: 600_000 })).tier).toBe('sonnet')
})

test('no move to a cheaper tier in the middle of a task', async () => {
  const state = { tier: 'opus' as Tier, votes: ['haiku' as Tier, 'haiku' as Tier], hold: 0 }
  const d = decide(input({ state, distribution: { haiku: 0.95, sonnet: 0.05 }, continuation: 0.9 }))
  expect(d.tier).toBe('opus')
  expect(d.reason).toBe('same-task')
})

test('a new easy task moves down after two votes', async () => {
  const state = { tier: 'opus' as Tier, votes: ['haiku' as Tier], hold: 0 }
  const d = decide(input({ state, distribution: { haiku: 0.9, sonnet: 0.1 } }))
  expect(d.tier).toBe('haiku')
  expect(d.reason).toBe('downgrade')
})

test('plan usage caps the top tier and raises the bar', async () => {
  expect(usageCap({ usedPercent: 80 })).toBe('opus')
  expect(usageCap({ usedPercent: 96 })).toBe('sonnet')
  expect(decide(input({ distribution: dist(features(4)), usage: { usedPercent: 80 } })).tier).toBe('opus')
  const state = { tier: 'opus' as Tier, votes: [], hold: 0 }
  expect(decide(input({ state, distribution: dist(features(3)), usage: { usedPercent: 97 } })).reason).toBe(
    'usage-cap',
  )
})

test('low confidence and no advice keep the current tier', async () => {
  const state = { tier: 'opus' as Tier, votes: [], hold: 0 }
  expect(decide(input({ state, distribution: dist(features(0)), confidence: 0.2 })).tier).toBe('opus')
  expect(decide(input({ state, distribution: null })).reason).toBe('no-advice')
})

test('escalation moves up one tier and holds', async () => {
  const up = escalate({ tier: 'sonnet', votes: [], hold: 0 }, 'sonnet', { usedPercent: 10 })
  expect(up?.tier).toBe('opus')
  const held = decide(input({ state: up!.state, distribution: dist(features(0)) }))
  expect(held.reason).toBe('hold')
  expect(escalate({ tier: 'opus', votes: [], hold: 0 }, 'sonnet', { usedPercent: 80 })).toBe(null)
})

test('routes fall back when a model is not available', async () => {
  expect(routeFor('fable', null, ['opus', 'sonnet'])?.model).toBe('claude-opus-5-5')
  expect(routeFor('opus', features(3))?.effort).toBe('xhigh')
  expect(routeFor('haiku', features(0))?.effort).toBe('low')
  expect(tierOfModel('claude-sonnet-5-5[1m]')).toBe('sonnet')
})

test('endpoints for the three backends', async () => {
  const w = endpointFor({ backend: 'clef-workers', cloudflareAccountId: 'acct' })
  expect('url' in w && w.url).toMatch(/accounts\/acct\/ai\/run\/@cf\/cloudflare\/clef-flash$/)
  expect('model' in w && w.model).toBe(null)
  expect(endpointFor({ backend: 'clef-workers' })).toEqual({ error: 'missing Cloudflare account ID' })
  const j = endpointFor({ backend: 'jev-api' })
  expect('url' in j && j.url).toBe('https://api.typesafe.ai/v1/systemone')
  const l = endpointFor({ backend: 'local', localUrl: 'http://127.0.0.1:9/v1/systemone' })
  expect('keyRequired' in l && l.keyRequired).toBe(false)
  expect('key' in l && l.key).toBe('local_api_key')
})

test('answers parse, including the Workers AI wrapper', async () => {
  const answers = {
    difficulty: { type: 'score', score: 3, confidence: 0.8, probabilities: { '0': 0, '1': 0, '2': 0.2, '3': 0.7, '4': 0.1 } },
    reasoning: { type: 'score', probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 } },
    scope: { type: 'choice', choice: 'few_files', probabilities: { few_files: 0.9, file: 0.1 } },
    activity: { type: 'choice', choice: 'debug', probabilities: { debug: 0.8, code: 0.2 } },
    security: { type: 'noul', noul: 0.1 },
    continuation: { type: 'noul', noul: 0.2 },
  }
  const f = parseAnswers({ result: { answers }, success: true })
  // The server's own confidence (0.8) is ignored; confidence comes from the probabilities.
  expect(Math.round(f.confidence * 1000) / 1000).toBe(0.625)
  expect(f.reasoning).toBe(2)
  expect(f.activity.debug).toBe(0.8)
  expect(() => parseAnswers({ answers: { scope: answers.scope } })).toThrow()
})

test('the journal tunes from corrections', async () => {
  let records: JournalRecord[] = []
  const decision = decide(input({ distribution: dist(features(1)) }))
  for (let i = 0; i < 25; i += 1) {
    records = append(records, recordOf({ at: i, mode: 'route', decision, features: features(1), usedPercent: 10, latencyMs: 100 + i, error: null }))
    if (i % 3 === 0) records = markOverride(records, 'opus')
  }
  const t = tune(records)
  expect(t.decisions).toBe(25)
  expect(t.suggestion).toBe('raise')
  expect(t.latencyMedianMs).toBe(112)
})

test('confidence is computed the same way for every backend', async () => {
  expect(confidenceOf([0.2, 0.2, 0.2, 0.2, 0.2])).toBe(0)
  expect(confidenceOf([0, 0, 1, 0, 0])).toBe(1)
  expect(Math.round(confidenceOf([0, 0.1, 0.9, 0, 0]) * 1000) / 1000).toBe(0.875)
  // Unnormalized answers are normalized first.
  expect(confidenceOf([0, 0, 2, 0, 0])).toBe(1)
  expect(confidenceOf([])).toBe(0)
})

test('an Unsloth-style local server: optional key, its own URL and model name', async () => {
  const e = endpointFor({ backend: 'local', localUrl: 'http://localhost:8888/v1/systemone', decisionModel: 'laya' })
  expect('url' in e && e.url).toBe('http://localhost:8888/v1/systemone')
  expect('model' in e && e.model).toBe('laya')
  expect('keyRequired' in e && e.keyRequired).toBe(false)
  // Without a model name the server's selected model answers jev-latest.
  const d = endpointFor({ backend: 'local' })
  expect('model' in d && d.model).toBe('default')
  expect('url' in d && d.url).toBe('http://127.0.0.1:8888/v1/systemone')
  // A server's own confidence field is never read: only the probabilities.
  const f = parseAnswers({
    answers: { difficulty: { type: 'score', confidence: 0.01, probabilities: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 } } },
  })
  expect(f.confidence).toBe(1)
})

test('earlier backend names map to local, and hosts are named for errors', async () => {
  expect(backendOf('clef-local')).toBe('local')
  expect(backendOf('jev-local')).toBe('local')
  expect(backendOf('jev-api')).toBe('jev-api')
  expect(backendOf(undefined)).toBe('clef-workers')
  expect(hostOf('http://10.0.0.9:8888/v1/systemone')).toBe('10.0.0.9:8888')
  const e = endpointFor({ backend: 'local', decisionModel: 'laya' })
  expect('label' in e && e.label).toBe('Laya')
  expect('local' in e && e.local).toBe(true)
  const w = 'url' in e ? warmupBody(e) : null
  expect(w?.model).toBe('laya')
  expect(Object.keys(w?.questions ?? {}).length).toBe(1)
})
