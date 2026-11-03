// The llama.cpp backend: llama-server running a decision model (Laya, Clef) answers /v1/systemone itself. These tests
// cover what is specific to it, through the hooks module against a mock llama-server.
import { expect, mock, test } from 'claude-code/testing'
import { endpointFor, llamaBase } from '../src/classifier.ts'

test('llama-server addresses: a bare host and port is enough', async () => {
  expect(llamaBase('http://10.0.0.9:9931')).toBe('http://10.0.0.9:9931')
  expect(llamaBase('http://10.0.0.9:9931/')).toBe('http://10.0.0.9:9931')
  expect(llamaBase('http://10.0.0.9:9931/v1')).toBe('http://10.0.0.9:9931')
  expect(llamaBase('http://10.0.0.9:9931/v1/systemone')).toBe('http://10.0.0.9:9931')
  const e = endpointFor({ backend: 'llamacpp', localUrl: 'http://10.0.0.9:9931/v1', decisionModel: 'clef-flash' })
  expect('url' in e && e.url).toBe('http://10.0.0.9:9931/v1/systemone')
  expect('label' in e && e.label).toBe('Clef Flash')
  expect('llama' in e && e.llama).toBe(true)
  const d = endpointFor({ backend: 'llamacpp' })
  expect('url' in d && d.url).toBe('http://127.0.0.1:9931/v1/systemone')
  expect('label' in d && d.label).toBe('llama.cpp')
  // A single-model server needs no model name.
  expect('model' in d && d.model).toBe(null)
  expect('local' in d && d.local).toBe(true)
})

// System One answers for a task of difficulty `level` (0-4), as llama-server's decision models return them.
function systemOne(level: number) {
  const p: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 }
  p[String(level)] = 0.9
  p[String(Math.max(0, level - 1))] += 0.1
  return {
    model: 'clef-flash',
    answers: {
      difficulty: { type: 'score', score: level, probabilities: p, confidence: 0.9 },
      reasoning: { type: 'score', probabilities: { '0': level < 2 ? 1 : 0, '1': 0, '2': 0, '3': level >= 2 ? 1 : 0 } },
      scope: { type: 'choice', probabilities: level >= 3 ? { system: 1 } : { spot: 1 } },
      activity: { type: 'choice', probabilities: level >= 3 ? { plan: 1 } : { explore: 1 } },
      security: { type: 'noul', noul: 0 },
      continuation: { type: 'noul', noul: 0 },
    },
    usage: { input_tokens: 420, output_tokens: 0 },
  }
}

type Server = { level?: number; reply?: () => { status: number; body: unknown } }

function stubs(on: any, server: Server, extraEnv: Record<string, string> = {}) {
  const seen = { requests: [] as any[], models: [] as string[], store: new Map<string, unknown>([['decision-router:mode', 'route']]) }
  mock.clock(on)
  mock.env(on, { ROUTER_BACKEND: 'llamacpp', ROUTER_LOCAL_URL: 'http://10.0.0.9:9931', ...extraEnv })
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 1 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', ($: any, e: any) => {
    seen.requests.push({ url: e.url, headers: e.init?.headers, body: e.init?.body ? JSON.parse(e.init.body) : null })
    const r = server.reply ? server.reply() : { status: 200, body: systemOne(server.level ?? 2) }
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: JSON.stringify(r.body) } }
  })
  on('turn.step', async function* ($: any, e: any) {
    seen.models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('command.run', () => ({ text: '' }))
  return seen
}

async function turn($: any, turnId: string, text: string) {
  await $.turn.start({ turnId, text })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'medium' })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const asks = (seen: { requests: any[] }) => seen.requests.filter((r) => Object.keys(r.body?.questions ?? {}).length === 6)

test('llama-server warms up, then gets one /v1/systemone request per turn', async ($, on) => {
  const seen = stubs(on, { level: 0 })
  await start($)
  await turn($, 't1', 'where is the config loaded?')
  expect(seen.requests.every((r) => r.url === 'http://10.0.0.9:9931/v1/systemone')).toBe(true)
  const warm = seen.requests.filter((r) => Object.keys(r.body?.questions ?? {}).length === 1)
  expect(warm.length).toBe(1)
  expect(asks(seen).length).toBe(1)
  // A single-model server needs no model name.
  expect(asks(seen)[0].body.model).toBeUndefined()
  expect(seen.models[0]).toBe('claude-haiku-5-5')
})

test('a very hard task from llama-server goes to Opus', async ($, on) => {
  const seen = stubs(on, { level: 4 })
  await start($)
  await turn($, 't1', 'redesign the storage engine')
  expect(seen.models[0]).toBe('claude-opus-5-5')
})

test('a model name is sent when one is set', async ($, on) => {
  const seen = stubs(on, { level: 1 }, { ROUTER_DECISION_MODEL: 'clef-flash' })
  await start($)
  await turn($, 't1', 'list the files')
  expect(asks(seen)[0].body.model).toBe('clef-flash')
})

test("llama.cpp's own error text reaches the log", async ($, on) => {
  stubs(on, {
    reply: () => ({
      status: 400,
      body: { error: { code: 400, message: 'input (2345 tokens) is too large to process. increase the physical batch size', type: 'invalid_request_error' } },
    }),
  })
  await start($)
  await turn($, 't1', 'refactor the parser')
  const log = await $.command.run({ command: 'router', args: 'log' })
  expect(log.text).toMatch(/HTTP 400 from 10\.0\.0\.9:9931: input \(2345 tokens\) is too large to process\. increase the physical batch size/)
})

test('a server that is not running a decision model says so', async ($, on) => {
  const seen = stubs(on, { reply: () => ({ status: 501, body: { error: { message: 'not a decision model' } } }) })
  await start($)
  await turn($, 't1', 'list the files')
  expect(seen.models[0]).toBe('claude-sonnet-5-5')
  const log = await $.command.run({ command: 'router', args: 'log' })
  expect(log.text).toMatch(/HTTP 501 from 10\.0\.0\.9:9931: llama-server is not running a decision model \(Laya, Clef\)/)
})

test('the local key reaches llama-server as a bearer token', async ($, on) => {
  const seen = stubs(on, { level: 1 }, { ROUTER_LOCAL_API_KEY: 'sk-local' })
  await start($)
  await turn($, 't1', 'list the files')
  expect(seen.requests.every((r) => r.headers?.authorization === 'Bearer sk-local')).toBe(true)
})

test('the band names llama.cpp', async ($, on) => {
  stubs(on, { level: 3 })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['prompt'] }))
  await start($)
  await $.turn.start({ turnId: 't1', text: 'track down the leak' })
  const ui = await $.ui.mount({
    plugin: 'decision-router',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 160, rows: 40 },
    props: { hasSurvey: false, isWorking: true, maxRows: 5, bodyColumns: 150, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  // While choosing, the band names the decision model and its deadline.
  expect(await ui.find({ type: 'Text', text: 'llama.cpp · 8 s deadline' })).toBeDefined()
})

test('a key set to none sends no key, even with one in the shell', async ($, on) => {
  const seen = stubs(on, { level: 1 }, { CLAUDE_PLUGIN_OPTION_LOCAL_API_KEY: 'none', ROUTER_LOCAL_API_KEY: 'sk-old' })
  await start($)
  await turn($, 't1', 'list the files')
  expect(seen.requests.length > 0).toBe(true)
  expect(seen.requests.every((r) => r.headers?.authorization === undefined)).toBe(true)
})
