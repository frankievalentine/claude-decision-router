// End to end: the real hooks module, with Claude Code's answers stubbed. Each test drives a session start, a turn
// and its model requests, and checks which model each request went to and what the band and pane draw.
import { expect, mock, test } from 'claude-code/testing'

// Decision-model answers for a task of difficulty `level` (0-4).
function answers(level: number, extra: Record<string, unknown> = {}) {
  const p: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 }
  p[String(level)] = 0.9
  p[String(Math.max(0, level - 1))] += 0.1
  return {
    answers: {
      difficulty: { type: 'score', score: level, confidence: 0.9, probabilities: p },
      reasoning: {
        type: 'score',
        probabilities: { '0': level < 2 ? 1 : 0, '1': 0, '2': level >= 2 && level < 4 ? 1 : 0, '3': level >= 4 ? 1 : 0 },
      },
      scope: { type: 'choice', probabilities: level >= 3 ? { many_files: 1 } : { spot: 1 } },
      activity: { type: 'choice', probabilities: level >= 3 ? { debug: 0.84, code: 0.16 } : { explore: 1 } },
      security: { type: 'noul', noul: 0 },
      continuation: { type: 'noul', noul: 0 },
      ...extra,
    },
  }
}

type Setup = { mode?: string; level?: number; fetch?: (e: any) => any; usage?: number; env?: Record<string, string> }

// Registers every stub a session needs. Returns what the test reads back.
function stubs(on: any, setup: Setup) {
  const seen = {
    opened: [] as string[],
    models: [] as string[],
    efforts: [] as unknown[],
    toasts: [] as string[],
    logs: [] as string[],
    bodies: [] as any[],
    store: new Map<string, unknown>(),
    clock: null as any,
    answers: [] as string[],
    asked: [] as { question: string; options: string[] }[],
    config: [] as { key: string; value: unknown }[],
    closed: [] as unknown[],
  }
  const clock = mock.clock(on)
  mock.env(on, setup.env ?? { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' })
  if (setup.mode) seen.store.set('decision-router:mode', setup.mode)
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('config.set', ($: any, e: any) => {
    seen.config.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'earlier', toolUses: [] }] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 20_000, window: 1_000_000, percent: 40 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: setup.usage ?? 10 },
        { kind: 'seven_day', percentUsed: 5 },
      ],
    },
  }))
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.toast', ($: any, e: any) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', ($: any, e: any) => {
    seen.bodies.push({ url: e.url, init: e.init, body: JSON.parse(e.init.body) })
    const custom = setup.fetch?.(e)
    if (custom !== undefined) return custom
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers(setup.level ?? 2)) } }
  })
  on('turn.step', async function* ($: any, e: any) {
    seen.models.push(e.model)
    seen.efforts.push(e.effort)
    const usage = { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('tool.call', ($: any, e: any) => {
    // The quick menu reaches Claude Code as an AskUserQuestion call: answer it from the queue, or dismiss it.
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]
      seen.asked.push({ question: q.question, options: q.options.map((o: any) => o.label ?? o) })
      const answer = seen.answers.shift()
      return answer === undefined ? { deny: 'dismissed' } : { result: { answers: { [q.question]: answer } } }
    }
    return e.command === 'fail' ? { result: 'boom', isError: true } : { result: 'ok' }
  })
  on('command.run', () => ({ text: '' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', ($: any, e: any) => {
    seen.opened.push(e.id ?? e.options?.id ?? 'pane')
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  seen.clock = clock
  return seen
}

async function step($: any, turnId: string, index: number, effort = 'medium') {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1, effort })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

async function turn($: any, turnId: string, text: string, steps = 1) {
  await $.turn.start({ turnId, text })
  for (let i = 0; i < steps; i += 1) await step($, turnId, i)
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const VIEWPORT = { columns: 160, rows: 40 }
// The hint line under the prompt in the terminal, where the band sits below the permission mode.
const HINT = {
  plugin: 'decision-router',
  component: 'PromptHint',
  surface: 'terminal',
  viewport: VIEWPORT,
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
} as const
// The desktop app has no hint line: there the band is drawn above the prompt.
const DESKTOP_BAND = {
  plugin: 'decision-router',
  component: 'AbovePrompt',
  surface: 'desktop',
  viewport: VIEWPORT,
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 150, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const
const PANE = {
  plugin: 'decision-router',
  component: 'Pane',
  requestId: 'decision-router',
  surface: 'terminal',
  viewport: VIEWPORT,
  props: { title: 'Router', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
// What Claude Code would draw at the site when the mod passes it on.
const engineDraws = (on: any) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['prompt'] }))

// --- Routing ---

test('route mode sends an easy task to Haiku and a very hard one straight to Opus', async ($, on) => {
  const setup: Setup = { mode: 'route', level: 0 }
  const seen = stubs(on, setup)
  await start($)
  await turn($, 't1', 'where is parseConfig defined?')
  expect(seen.models[0]).toBe('claude-haiku-5-5')
  setup.level = 4
  await turn($, 't2', 'redesign the scheduler to remove the race between workers')
  expect(seen.models[1]).toBe('claude-opus-5-5')
  expect(seen.efforts[1]).toBe('xhigh')
})

test('the request asks every question in one call, without naming a model', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 2 })
  await start($)
  await turn($, 't1', 'add a retry to the uploader')
  expect(seen.bodies.length).toBe(1)
  const { url, init, body } = seen.bodies[0]
  expect(url).toMatch(/accounts\/acct\/ai\/run\/@cf\/cloudflare\/clef-flash$/)
  expect(init.headers.authorization).toBe('Bearer token')
  expect(Object.keys(body.questions).sort()).toEqual(['activity', 'continuation', 'difficulty', 'reasoning', 'scope', 'security'])
  expect(body.model).toBeUndefined()
})

test('watch mode changes nothing but shows the pick', async ($, on) => {
  const seen = stubs(on, { mode: 'watch', level: 0 })
  await start($)
  await turn($, 't1', 'list the files')
  expect(seen.models[0]).toBe('claude-opus-5-5')
  const status = await $.command.run({ command: 'router', args: 'status' })
  expect(status.text).toMatch(/^haiku exploring → Haiku 5\.5 · low · watch only · • first pick/)
})

test('a continuation turn asks nothing and keeps the route', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 3 })
  await start($)
  await turn($, 't1', 'fix the flaky integration test')
  await turn($, 't2', '')
  expect(seen.bodies.length).toBe(1)
  expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('near the plan limit the top tier is capped', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 4, usage: 97 })
  await start($)
  await turn($, 't1', 'design a new storage engine')
  expect(seen.models[0]).toBe('claude-sonnet-5-5')
})

test('ultrathink keeps its xhigh effort on a routed turn', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 2 })
  await start($)
  await $.turn.start({ turnId: 't1', text: 'ultrathink about this refactor' })
  await step($, 't1', 0, 'xhigh')
  expect(seen.models[0]).toBe('claude-sonnet-5-5')
  expect(seen.efforts[0]).toBe('xhigh')
})

test('repeated tool errors escalate mid-turn', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 1 })
  await start($)
  await $.turn.start({ turnId: 't1', text: 'rename the helper' })
  await step($, 't1', 0)
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'fail' })
  await step($, 't1', 1)
  expect(seen.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
  expect(seen.toasts).toContain('Model changed: Haiku 5.5 · low → Sonnet 5.5 · low · tool errors')
})

test('a model switch names the move and its evidence', async ($, on) => {
  const setup: Setup = { mode: 'route', level: 0 }
  const seen = stubs(on, setup)
  await start($)
  await turn($, 't1', 'list the routes')
  setup.level = 4
  await turn($, 't2', 'redesign the whole persistence layer')
  expect(seen.toasts[0]).toMatch(/^Model changed: Haiku 5\.5 · low → Opus 5\.5 · xhigh · jump \(Clef Flash \d+% ≥ \d+%\)$/)
})

test('a pin serves one turn without asking the decision model', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  await start($)
  await turn($, 't1', 'where is main?')
  expect((await $.command.run({ command: 'router', args: 'pin opus' })).text).toBe('The next turn runs on opus.')
  await turn($, 't2', 'and what calls it?')
  await turn($, 't3', 'and where is it tested?')
  expect(seen.bodies.length).toBe(2)
  expect(seen.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
})

test('picking a model by hand pauses routing and is recorded', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  await start($)
  await turn($, 't1', 'what does this flag do?')
  await $.command.run({ command: 'model', args: 'opus', origin: { kind: 'composer' } })
  await turn($, 't2', 'what about this one?')
  expect(seen.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect((seen.store.get('decision-router:journal') as any[])[0].outcome).toBe('override-up')
  expect((await $.command.run({ command: 'router', args: 'on' })).text).toMatch(/Routing is on/)
})

// --- Failures name where they happened ---

test('a timeout names the host and keeps the model', async ($, on) => {
  const seen = stubs(on, {
    mode: 'route',
    fetch: () => new Promise(() => {}),
  })
  await start($)
  await $.turn.start({ turnId: 't1', text: 'refactor the parser' })
  const stepping = step($, 't1', 0)
  await seen.clock.advance(3000)
  await stepping
  expect(seen.models[0]).toBe('claude-sonnet-5-5')
  const log = await $.command.run({ command: 'router', args: 'log' })
  expect(log.text).toMatch(/error: timed out after 2\.5 s at api\.cloudflare\.com/)
})

test('an HTTP error names the host', async ($, on) => {
  stubs(on, { mode: 'route', fetch: () => ({ value: { status: 401, ok: false, headers: {}, text: '' } }) })
  await start($)
  await turn($, 't1', 'refactor the parser')
  const status = await $.command.run({ command: 'router', args: 'status' })
  expect(status.text).toMatch(/Last decision model error: HTTP 401 from api\.cloudflare\.com/)
})

test('no new request goes out while the last one is still running', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: () => new Promise(() => {}) })
  await start($)
  await $.turn.start({ turnId: 't1', text: 'first prompt' })
  const first = step($, 't1', 0)
  await seen.clock.advance(3000)
  await first
  await turn($, 't2', 'second prompt')
  expect(seen.bodies.length).toBe(1)
  const log = await $.command.run({ command: 'router', args: 'log' })
  expect(log.text).toMatch(/error: the previous request is still running/)
})

// --- The command ---

test('bare /router opens the quick menu; Details opens the pane; unknown words get help', async ($, on) => {
  const seen = stubs(on, { mode: 'watch' })
  seen.answers.push('Details')
  await start($)
  const bare = await $.command.run({ command: 'router', args: '' })
  expect(bare).toEqual({})
  expect(seen.asked[0].options).toEqual(['Route: switch models', 'Pin next turn', 'Turn off', 'Details'])
  expect(seen.opened.length).toBe(1)
  await $.command.run({ command: 'router', args: 'pane' })
  expect(seen.opened.length).toBe(2)
  expect(seen.logs).toContain('router command args: ""')
  const odd = await $.command.run({ command: 'router', args: 'banana' })
  expect(odd.text).toMatch(/^Unknown option "banana"\.\nCommands:/)
})

// --- The band ---

test('the band draws the meter, tier pill, activity, route, reason and readings', async ($, on) => {
  stubs(on, { mode: 'route', level: 3 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'debug the deadlock in the cache layer')
  const ui = await $.ui.mount(HINT)
  // Claude Code's own line comes first, with the band under it.
  expect(await ui.find({ type: 'Text', text: 'prompt' })).toBeDefined()
  // Signal bars lit up to opus (the third of four) in its color, the fourth dim.
  expect((await ui.find({ type: 'Text', text: '▆' }))?.props.color).toBe('#e0708a')
  expect((await ui.find({ type: 'Text', text: '█' }))?.props.dimColor).toBe(true)
  const pill = await ui.find({ type: 'Text', text: ' opus ' })
  expect(pill?.props.backgroundColor).toBe('#e0708a')
  const activity = await ui.find({ type: 'Text', text: 'debugging → ' })
  expect(activity?.props.italic).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 · high' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '• first pick' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'balanced (default)' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '10%' }))?.props.color).toBe('green')
  expect((await ui.find({ type: 'Text', text: '40%' }))?.props.color).toBe('green')
  expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
  expect(await ui.find({ key: 'details' })).toBeDefined()
})

test('the quick menu pins the next turn, switches modes, and turns routing back on', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'list the files')
  // Pin: two steps, the tier on the second.
  seen.answers.push('Pin next turn', 'opus')
  await $.command.run({ command: 'router', args: '' })
  expect(seen.asked[0].question).toBe('Routing is on (now haiku). What would you like to change?')
  expect(seen.asked[1].options).toEqual(['haiku', 'sonnet', 'opus'])
  const ui = await $.ui.mount(HINT)
  expect(await ui.find({ type: 'Text', text: '⏵ next turn: ' })).toBeDefined()
  // A pin already set can be cancelled from the same step.
  seen.answers.push('Pin next turn (now opus)', 'Cancel the opus pin')
  await $.command.run({ command: 'router', args: '' })
  expect(seen.asked[3].options[0]).toBe('Cancel the opus pin')
  expect(await ui.find({ type: 'Text', text: '⏵ next turn: ' })).toBeUndefined()
  // Off, then back on from the off-state menu.
  seen.answers.push('Turn off')
  await $.command.run({ command: 'router', args: '' })
  expect(await ui.find({ type: 'Text', text: 'off' })).toBeDefined()
  seen.answers.push('Watch: show picks only')
  await $.command.run({ command: 'router', args: '' })
  expect(seen.asked[5].options).toEqual(['Route: switch models', 'Watch: show picks only', 'Details'])
  expect(seen.store.get('decision-router:mode')).toBe('watch')
  // Router on the band opens the same menu.
  seen.answers.push('Route: switch models')
  await ui.press({ key: 'details' })
  expect(seen.store.get('decision-router:mode')).toBe('route')
})

test('dismissing the quick menu changes nothing', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  await start($)
  await $.command.run({ command: 'router', args: '' })
  expect(seen.asked.length).toBe(1)
  expect(seen.store.get('decision-router:mode')).toBe('route')
})

test('there is no hover row any more', async ($, on) => {
  stubs(on, { mode: 'route', level: 0 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'list the files')
  const ui = await $.ui.mount(HINT)
  expect(await ui.find({ key: 'band-pin-opus' })).toBeUndefined()
  expect(await ui.find({ key: 'band-off' })).toBeUndefined()
})

test('in the terminal the band leaves the space above the prompt; the desktop app keeps it there', async ($, on) => {
  stubs(on, { mode: 'route', level: 3 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'debug the deadlock')
  const above = await $.ui.mount({ ...DESKTOP_BAND, surface: 'terminal' })
  expect(await above.find({ type: 'Text', text: ' opus ' })).toBeUndefined()
  await above.unmount()
  const desktop = await $.ui.mount(DESKTOP_BAND)
  expect(await desktop.find({ type: 'Text', text: ' opus ' })).toBeDefined()
})

test('the session row is switched on from the pane', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'list the files')
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'band-detail' })
  expect(seen.store.get('decision-router:detail')).toBe(true)
  const ui = await $.ui.mount(HINT)
  expect(await ui.find({ type: 'Text', text: 'session  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'haiku 1  ' })).toBeDefined()
})

test('a decision-model fault leads the band', async ($, on) => {
  stubs(on, { mode: 'route', fetch: () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }) })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'refactor the parser')
  const ui = await $.ui.mount(HINT)
  const warning = await ui.find({ type: 'Text', text: '⚠ Clef Flash: HTTP 503 from api.cloudflare.com' })
  expect(warning?.props.color).toBe('#f0b429')
  expect(await ui.find({ type: 'Text', text: 'keeping model' })).toBeDefined()
})

test('a narrow band drops readings before the route', async ($, on) => {
  stubs(on, { mode: 'route', level: 3 })
  engineDraws(on)
  await start($)
  await turn($, 't1', 'debug the deadlock in the cache layer')
  const ui = await $.ui.mount({ ...HINT, viewport: { columns: 54, rows: 40 } })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 · high' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'balanced (default)' })).toBeUndefined()
})

test('the spinner says Choosing model while the decision model answers', async ($, on) => {
  stubs(on, { mode: 'route', level: 2 })
  on('ui.render', ($: any, e: any) => ({ type: 'Text', props: {}, children: [String(e.props?.message ?? '')] }))
  await start($)
  await $.turn.start({ turnId: 't1', text: 'add input validation' })
  const spinner = { plugin: 'decision-router', component: 'Spinner', surface: 'terminal', viewport: VIEWPORT, props: { word: 'Thinking', message: null, suffix: '', mode: 'normal' } } as const
  const during = await $.ui.mount(spinner)
  expect(await during.find({ type: 'Text', text: 'Choosing model' })).toBeDefined()
  await during.unmount()
  await step($, 't1', 0)
  const after = await $.ui.mount(spinner)
  expect(await after.find({ type: 'Text', text: 'Choosing model' })).toBeUndefined()
})

// --- Setup ---

const LLAMA = 'llama.cpp (a server on your machine)'
const CLOUDFLARE = 'Cloudflare Clef (hosted)'
const DOWN = { value: { status: 503, ok: false, headers: {}, text: 'down' } }
const run = ($: any, args: string) => $.command.run({ command: 'router', args })

test('/router setup finds a llama.cpp server on its default port and saves it', async ($, on) => {
  const seen = stubs(on, { mode: 'watch' })
  seen.answers.push(LLAMA)
  await start($)
  const result = await run($, 'setup')
  expect(seen.asked[0].options).toEqual([LLAMA, 'Unsloth (a server on your machine)', CLOUDFLARE, 'TypeSafe Jev (hosted)'])
  expect(seen.bodies[0].url).toBe('http://127.0.0.1:9931/v1/systemone')
  expect(seen.config).toEqual([
    { key: 'decision-router.backend', value: 'llamacpp' },
    { key: 'decision-router.local_url', value: 'http://127.0.0.1:9931' },
  ])
  expect(result.text).toMatch(/answered in \d+ ms at 127\.0\.0\.1:9931/)
  expect(result.text).toContain('/router route')
})

test('/router setup takes a typed address when the default does not answer', async ($, on) => {
  const seen = stubs(on, { mode: 'watch', fetch: (e: any) => (e.url.includes('10.0.0.9') ? undefined : DOWN) })
  seen.answers.push(LLAMA, '10.0.0.9:9931')
  await start($)
  const result = await run($, 'setup')
  expect(seen.asked[1].question).toContain('Nothing usable answered at 127.0.0.1:9931')
  expect(seen.asked[1].options).toEqual(['Retry', 'Save anyway', 'Cancel setup'])
  expect(seen.config).toContainEqual({ key: 'decision-router.local_url', value: 'http://10.0.0.9:9931' })
  expect(result.text).toContain('10.0.0.9:9931')
})

test('/router setup can be cancelled, or save an address that does not answer yet', async ($, on) => {
  const seen = stubs(on, { mode: 'watch', fetch: () => DOWN })
  seen.answers.push(LLAMA, 'Cancel setup')
  await start($)
  expect((await run($, 'setup')).text).toBe('Setup cancelled. Nothing was saved.')
  expect(seen.config).toEqual([])
  seen.answers.push(LLAMA, 'Save anyway')
  const saved = await run($, 'setup')
  expect(seen.config.map((c) => c.key)).toEqual(['decision-router.backend', 'decision-router.local_url'])
  expect(saved.text).toContain('Saved without a working test')
})

test('/router setup for Cloudflare asks for the account ID but never for the key', async ($, on) => {
  const seen = stubs(on, { mode: 'watch', env: {} })
  seen.answers.push(CLOUDFLARE, 'A'.repeat(32))
  await start($)
  const result = await run($, 'setup')
  expect(seen.config).toEqual([
    { key: 'decision-router.backend', value: 'clef-workers' },
    { key: 'decision-router.cloudflare_account_id', value: 'a'.repeat(32) },
  ])
  expect(result.text).toContain('No Cloudflare API token found. Set CLOUDFLARE_API_TOKEN in your shell')
  // Nothing was sent, and no question asked for a token.
  expect(seen.bodies.length).toBe(0)
  expect(seen.asked.every((q) => !/token|key/i.test(q.question))).toBe(true)
})

test('/router setup for Cloudflare tests the connection when the shell already has the key', async ($, on) => {
  const seen = stubs(on, { mode: 'watch' })
  seen.answers.push(CLOUDFLARE)
  await start($)
  const result = await run($, 'setup')
  expect(seen.config).toEqual([{ key: 'decision-router.backend', value: 'clef-workers' }])
  expect(seen.bodies[0].url).toContain('/accounts/acct/ai/run/@cf/cloudflare/clef-flash')
  expect(result.text).toMatch(/Clef Flash answered in \d+ ms/)
})

test('dismissing /router setup saves nothing', async ($, on) => {
  const seen = stubs(on, { mode: 'watch' })
  await start($)
  expect((await run($, 'setup')).text).toBe('Setup cancelled.')
  expect(seen.config).toEqual([])
})

test('/router test reports the decision model answering, or why it did not', async ($, on) => {
  let healthy = true
  const seen = stubs(on, { mode: 'watch', fetch: () => (healthy ? undefined : DOWN) })
  await start($)
  expect((await run($, 'test')).text).toMatch(/^Clef Flash answered in \d+ ms at api\.cloudflare\.com\.$/)
  healthy = false
  const bad = await run($, 'test')
  expect(bad.text).toContain('Clef Flash did not answer: HTTP 503 from api.cloudflare.com: down')
  expect(bad.text).toContain('/router setup')
  // A test never pauses routing, however often it fails.
  for (let i = 0; i < 4; i += 1) await run($, 'test')
  expect(seen.logs.join('\n')).not.toContain('paused for a minute')
})

test('/router test names a missing key and where to put it', async ($, on) => {
  stubs(on, { mode: 'watch', env: { CLOUDFLARE_ACCOUNT_ID: 'acct' } })
  await start($)
  expect((await run($, 'test')).text).toContain('No Cloudflare API token found')
})

// --- What the journal keeps, and the confidence that gates the pick ---

// Difficulty split between two levels, both of which are Sonnet work at a single spot with some reasoning.
const SAME_TIER = {
  difficulty: { type: 'score', probabilities: { '0': 0, '1': 0.5, '2': 0.5, '3': 0, '4': 0 } },
  reasoning: { type: 'score', probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 } },
  scope: { type: 'choice', probabilities: { spot: 1 } },
  activity: { type: 'choice', probabilities: { code: 1 } },
}
// Difficulty split between a Sonnet level and an Opus level: the tier itself is in doubt.
const SPLIT_TIERS = { ...SAME_TIER, difficulty: { type: 'score', probabilities: { '0': 0, '1': 0.4, '2': 0, '3': 0.6, '4': 0 } } }
const withAnswers = (extra: Record<string, unknown>) => () => ({
  value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers(2, extra)) },
})

test('a task split between two levels of the same tier is not low confidence', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: withAnswers(SAME_TIER) })
  await start($)
  await turn($, 't1', 'rename the helper in the settings file')
  const [record] = seen.store.get('decision-router:journal') as any[]
  // The difficulty answer alone is 0.375, under the 0.45 bar; the tier is certain.
  expect(record.reason).toBe('first')
  expect(record.confidence).toBe(1)
})

test('a split between tiers is low confidence, and the journal keeps which way the model leaned', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: withAnswers(SPLIT_TIERS) })
  await start($)
  await turn($, 't1', 'rework the sync engine')
  const [record] = seen.store.get('decision-router:journal') as any[]
  expect(record).toMatchObject({ tier: 'sonnet', reason: 'low-confidence', lean: 'opus' })
  // The Log tab and /router log and /router tune all say it: the filter kept Sonnet, the model leaned Opus.
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-log' })
  expect(await pane.find({ type: 'Text', text: 'leaned opus' })).toBeDefined()
  await pane.press({ key: 'tab-tune' })
  expect(await pane.find({ type: 'Text', text: /leaned, before the confidence filter \(1\)/ })).toBeDefined()
  expect((await run($, 'log')).text).toContain('leaned opus')
  expect((await run($, 'tune')).text).toContain('leaned (before the confidence filter and the policy): opus 100% of 1')
})

test('each record keeps both plan windows, not only the higher one', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 2, usage: 10 })
  await start($)
  await turn($, 't1', 'explain the cache layer')
  const [record] = seen.store.get('decision-router:journal') as any[]
  // The stub reports 10% of the 5-hour window and 5% of the weekly one; usedPercent is the higher.
  expect(record).toMatchObject({ fiveHour: 10, sevenDay: 5, usedPercent: 10 })
})

// --- The pane ---

test('the Close button closes the pane it opened', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  await start($)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'close' })
  // $.ui.close names the pane by { id }; a bare string would close nothing.
  expect(seen.closed).toEqual(['decision-router'])
})

test('a narrow pane stacks labels above values, wraps its rows and shortens its bars', async ($, on) => {
  stubs(on, { mode: 'route', level: 3 })
  await start($)
  await turn($, 't1', 'track down the memory leak')
  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  // Wide: the label sits beside its value in an 11-cell column.
  expect((await wide.find({ type: 'Text', text: 'Next turn' }))?.text).toBe('Next turn'.padEnd(11))
  const barOf = async (ui: any) => (await ui.findAll({ type: 'Text', text: /^[█░]+$/ })).map((b: any) => b.text.length)
  expect(Math.max(...(await barOf(wide)))).toBe(16)
  await wide.unmount()
  // Narrow: the label stands alone on its own line, every row may wrap, and the bars shorten to fit.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 44 } })
  expect((await narrow.find({ type: 'Text', text: 'Next turn' }))?.text).toBe('Next turn')
  const wrapping = (await narrow.findAll({ type: 'Box' })).filter((b: any) => b.props.flexWrap === 'wrap')
  expect(wrapping.length).toBeGreaterThanOrEqual(4)
  expect(Math.max(...(await barOf(narrow)))).toBe(14)
})

test('the status stands on its own line, so a long fault wraps instead of pushing the buttons out', async ($, on) => {
  const long = 'timed out after 8 s at 10.0.0.9:8888'
  stubs(on, { mode: 'route', fetch: () => ({ value: { status: 503, ok: false, headers: {}, text: long } }) })
  await start($)
  await turn($, 't1', 'refactor the parser')
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const status = await ui.find({ type: 'Text', text: 'HTTP 503' })
  expect(status).toBeDefined()
  expect(status?.text).toContain(long)
  expect(await ui.find({ key: 'mode-route' })).toBeDefined()
})

test('the Log tab gives each entry one line in a wide pane and two in a narrow one', async ($, on) => {
  stubs(on, { mode: 'route', level: 3 })
  await start($)
  await turn($, 't1', 'track down the memory leak')
  const tierText = async (columns: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns } })
    await ui.press({ key: 'tab-log' })
    const first = (await ui.findAll({ type: 'Text', text: /^(haiku|sonnet|opus|fable)/ }))[0]
    await ui.unmount()
    return first?.text
  }
  // Wide: the tier is padded to a column that the reason and detail follow on the same line. Narrow: it stands alone.
  expect(await tierText(100)).toBe('opus   ')
  expect(await tierText(60)).toBe('opus')
})

test('the pane shows the next turn, why, pins with odds, session, plan and context', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 3 })
  await start($)
  await turn($, 't1', 'track down the memory leak')
  await $.command.run({ command: 'router', args: 'pane' })
  expect(seen.opened.length).toBe(1)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'ROUTING' })).toBeDefined()
  expect(await ui.find({ key: 'mode-route' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Clef Flash ready · \d+ ms$/ }))?.props.color).toBe('green')
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 · high' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'debugging' }))?.props.color).toBe('#d77757')
  expect(await ui.find({ type: 'Text', text: 'first pick of the session' })).toBeDefined()
  expect((await ui.find({ key: 'pin-opus' }))?.props.label).toBe('opus 100%')
  expect(await ui.find({ type: 'Text', text: /^ · since \d\d:\d\d · 1 routed turn · 0 switches$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PLAN' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  10%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '90% reused on the last reply' })).toBeDefined()
  await ui.press({ key: 'pin-haiku' })
  expect((await ui.find({ key: 'pin-haiku' }))?.props.label).toBe('▶ haiku 0%')
  await ui.press({ key: 'tab-log' })
  expect(await ui.find({ type: 'Text', text: 'LOG' })).toBeDefined()
  // Confidence is in the tier, and the whole probability is on Opus.
  expect(await ui.find({ type: 'Text', text: /^debugging · difficulty 2\.9 · confidence 1$/ })).toBeDefined()
  await ui.press({ key: 'tab-tune' })
  expect(await ui.find({ type: 'Text', text: /Not enough decisions yet/ })).toBeDefined()
})

test('settings saved under the old router-enhanced name carry over', async ($, on) => {
  const seen = stubs(on, { level: 0 })
  seen.store.set('router-enhanced:mode', 'route')
  seen.store.set('router-enhanced:journal', [{ at: 1, mode: 'route', tier: 'opus', reason: 'first', difficulty: 3, confidence: 0.9, activity: 'debug', usedPercent: 10, latencyMs: 300, error: null, outcome: 'ok' }])
  await start($)
  expect(seen.store.get('decision-router:mode')).toBe('route')
  expect((seen.store.get('decision-router:journal') as any[]).length).toBe(1)
  await turn($, 't1', 'where is main?')
  // Routing is on, as it was saved.
  expect(seen.models[0]).toBe('claude-haiku-5-5')
})

// --- Watching subagents ---

const SPAWN_LOG = 'decision-router:subagent-log'
const ENGINE = { plugin: 'engine', tier: 'core' }
// A stand-in for Claude Code starting the subagent: the model it resolves, unless the call names one.
function subagents(on: any) {
  const started: any[] = []
  on('agent.spawn', ($: any, e: any) => {
    started.push(e)
    return { model: e.model ?? 'claude-sonnet-5-5', agentId: `agent-${started.length}` }
  })
  return started
}
const spawn = ($: any, subagentType: string, prompt = 'look through the code', extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ prompt, subagentType, description: 'task', provider: ENGINE, ...extra })
// Lets the background line run: each await gives it a chance to move.
async function settle(seen: any) {
  for (let i = 0; i < 40; i += 1) await seen.clock.advance(100)
}
const spawnLog = (seen: any): any[] => (seen.store.get(SPAWN_LOG) as any[]) ?? []
const watching = async ($: any) => $.command.run({ command: 'router', args: 'subagents watch' })

test('subagents are not watched until asked, so no task text is sent', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  subagents(on)
  await start($)
  await spawn($, 'general-purpose')
  await settle(seen)
  expect(seen.bodies.length).toBe(0)
  expect(spawnLog(seen)).toEqual([])
  const text = await $.command.run({ command: 'router', args: 'subagents' })
  expect(text.text).toMatch(/not watching/)
})

test('turning watching on says where task text goes, and the choice is remembered', async ($, on) => {
  const seen = stubs(on, { mode: 'route' })
  subagents(on)
  await start($)
  const on1 = await watching($)
  expect(on1.text).toMatch(/also goes to .*Clef/)
  expect(seen.store.get('decision-router:subagent-mode')).toBe('watch')
  const usage = await $.command.run({ command: 'router', args: 'subagents banana' })
  expect(usage.text).toMatch(/^Usage/)
})

test('a watched subagent starts exactly as asked, on its usual model', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  const started = subagents(on)
  await start($)
  await watching($)
  const result = await spawn($, 'general-purpose', 'rename a variable')
  await settle(seen)
  expect(result.model).toBe('claude-sonnet-5-5')
  expect(started[0].model).toBeUndefined()
  expect(started[0].prompt).toBe('rename a variable')
  const [r] = spawnLog(seen)
  expect(r.kind).toBe('general')
  expect(r.actual).toBe('sonnet')
  expect(r.pick).toBe('haiku')
  expect(r.reason).toBe('advice')
})

test('Explore gets Haiku by rule, without asking the decision model', async ($, on) => {
  const seen = stubs(on, { mode: 'route' })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'Explore')
  await settle(seen)
  expect(seen.bodies.length).toBe(0)
  expect(spawnLog(seen)[0].pick).toBe('haiku')
  expect(spawnLog(seen)[0].reason).toBe('rule')
})

test('what should be left alone gets no pick and no request', async ($, on) => {
  const seen = stubs(on, { mode: 'route' })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'Plan')
  await spawn($, 'general-purpose', 'task', { model: 'opus' })
  await spawn($, 'pinned', 'task', { provider: { plugin: 'project', tier: 'user' } })
  await spawn($, 'Explore', 'task', { provider: { plugin: 'project', tier: 'user' } })
  await spawn($, 'general-purpose', 'task', { fork: true })
  await spawn($, 'general-purpose', 'task', { isTeammate: true })
  await spawn($, 'general-purpose', 'task', { workflow: { runId: 'wf_1', agentIndex: 1 } })
  await spawn($, 'general-purpose', 'task', { resume: { agentId: 'old' } })
  await settle(seen)
  expect(seen.bodies.length).toBe(0)
  expect(spawnLog(seen).map((r) => r.kind)).toEqual(['plan', 'explicit', 'custom', 'custom', 'fork', 'teammate', 'workflow', 'resume'])
  expect(spawnLog(seen).every((r) => r.pick === null)).toBe(true)
})

test('a pick never goes above the model the subagent ran on', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 4 })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose', 'redesign the scheduler')
  await settle(seen)
  expect(spawnLog(seen)[0].pick).toBe('sonnet')
  const text = await $.command.run({ command: 'router', args: 'subagents' })
  expect(text.text).toMatch(/Could have been cheaper: 0 of 1/)
})

test('a burst is asked about one at a time, and past the line it goes unasked', async ($, on) => {
  let running = 0
  let most = 0
  const seen = stubs(on, {
    mode: 'route',
    level: 0,
    fetch: async () => {
      running += 1
      most = Math.max(most, running)
      await Promise.resolve()
      await Promise.resolve()
      running -= 1
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers(0)) } }
    },
  })
  subagents(on)
  await start($)
  await watching($)
  for (let i = 0; i < 12; i += 1) await spawn($, 'general-purpose', `task ${i}`)
  await settle(seen)
  expect(most).toBe(1)
  const log = spawnLog(seen)
  expect(log.length).toBe(12)
  expect(log.filter((r) => r.reason === 'pending')).toEqual([])
  expect(log.filter((r) => r.pick === 'haiku').length).toBeGreaterThanOrEqual(8)
  expect(log.filter((r) => r.error === 'too many subagents at once').length).toBe(12 - log.filter((r) => r.pick === 'haiku').length)
})

test('a request for a main turn is not lost to a subagent waiting in line', async ($, on) => {
  let release: (v: any) => void = () => {}
  const ok = { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers(0)) } }
  let calls = 0
  const seen = stubs(on, {
    mode: 'route',
    fetch: () => {
      calls += 1
      return calls === 1 ? new Promise((r) => (release = r)) : ok
    },
  })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose')
  await seen.clock.advance(0)
  await $.turn.start({ turnId: 't1', text: 'where is parseConfig?' })
  const first = step($, 't1', 0)
  await seen.clock.advance(50)
  release(ok)
  await first
  await settle(seen)
  expect(calls).toBe(2)
  const log = await $.command.run({ command: 'router', args: 'log' })
  expect(log.text).not.toMatch(/still running/)
  expect(log.text).toMatch(/haiku/)
})

test('a subagent waits while a main request is running, then goes unasked past one timeout', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: () => new Promise(() => {}) })
  subagents(on)
  await start($)
  await watching($)
  await $.turn.start({ turnId: 't1', text: 'first prompt' })
  await seen.clock.advance(0)
  await spawn($, 'general-purpose')
  await seen.clock.advance(3000)
  await settle(seen)
  expect(seen.bodies.length).toBe(1)
  expect(spawnLog(seen)[0].error).toBe('a main turn was still asking')
  expect(spawnLog(seen)[0].pick).toBe(null)
})

test('failures while watching subagents do not pause main routing', async ($, on) => {
  const setup: Setup = { mode: 'route', level: 0, fetch: () => ({ value: { status: 500, ok: false, headers: {}, text: 'down' } }) }
  const seen = stubs(on, setup)
  subagents(on)
  await start($)
  await watching($)
  for (let i = 0; i < 5; i += 1) await spawn($, 'general-purpose')
  await settle(seen)
  const faults = spawnLog(seen).map((r) => r.error)
  expect(faults[0]).toMatch(/HTTP 500/)
  expect(faults[4]).toMatch(/paused for a minute/)
  setup.fetch = undefined
  await turn($, 't1', 'where is parseConfig?')
  expect(seen.models[0]).toBe('claude-haiku-5-5')
})

test('tokens and tool errors are added up per subagent and saved when it finishes', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  subagents(on)
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await watching($)
  const { agentId } = await spawn($, 'Explore')
  await settle(seen)
  const stream = $.turn.step({ turnId: 'sub', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  await $.tool.call({ tool: 'Bash', command: 'fail', agentId })
  await $.turn.complete({ turnId: 'sub', agentId, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' })
  const [r] = spawnLog(seen)
  expect(r.inputTokens).toBe(1000)
  expect(r.cachedTokens).toBe(900)
  expect(r.outputTokens).toBe(10)
  expect(r.toolErrors).toBe(1)
  const text = await $.command.run({ command: 'router', args: 'subagents' })
  expect(text.text).toMatch(/Could have been cheaper: 1 of 1 with a pick, using 100% of all subagent tokens \(1,010 of 1,010\)/)
  expect(text.text).toMatch(/Tool errors: 1 across 1 subagents/)
})

test('nothing of a subagent\'s prompt is saved', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose', 'SECRET-PROMPT-TEXT in the task')
  await settle(seen)
  expect(seen.bodies[0].body.input ?? JSON.stringify(seen.bodies[0].body)).toMatch(/SECRET-PROMPT-TEXT/)
  expect(JSON.stringify([...seen.store.entries()])).not.toMatch(/SECRET-PROMPT-TEXT/)
})

test('watching stays out of the main log, and a subagent\'s request leaves the main route alone', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 0 })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose')
  await settle(seen)
  expect(seen.store.get('decision-router:journal')).toBeUndefined()
  const stream = $.turn.step({ turnId: 'sub', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'agent-1' })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  expect(seen.models).toEqual(['claude-sonnet-5-5'])
})

test('turning watching off clears the line and stops new records', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: () => new Promise(() => {}) })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose', 'one')
  await spawn($, 'general-purpose', 'two')
  await seen.clock.advance(0)
  const off = await $.command.run({ command: 'router', args: 'subagents off' })
  expect(off.text).toMatch(/off/)
  await spawn($, 'Explore')
  expect(spawnLog(seen).map((r) => r.kind)).toEqual(['general', 'general'])
  expect(spawnLog(seen)[1].error).toBe('watching was turned off')
})

test('a subagent request that times out is recorded at once, and nothing new goes out until it settles', async ($, on) => {
  const seen = stubs(on, { mode: 'route', fetch: () => new Promise(() => {}) })
  subagents(on)
  await start($)
  await watching($)
  await spawn($, 'general-purpose', 'one')
  await spawn($, 'general-purpose', 'two')
  await settle(seen)
  expect(spawnLog(seen)[0].error).toMatch(/timed out after 2\.5 s/)
  expect(spawnLog(seen)[1].reason).toBe('pending')
  expect(seen.bodies.length).toBe(1)
})

test('a subagent\'s own turn sends nothing and leaves the main turn\'s state alone', async ($, on) => {
  const seen = stubs(on, { mode: 'route', level: 2 })
  await start($)
  await $.turn.start({ turnId: 't1', text: 'run the failing command' })
  await step($, 't1', 0)
  await $.tool.call({ tool: 'Bash', command: 'fail' })
  await $.tool.call({ tool: 'Bash', command: 'fail' })
  await $.tool.call({ tool: 'Bash', command: 'fail' })
  const asked = seen.bodies.length
  await $.turn.start({ turnId: 'sub', text: 'SUBAGENT-TASK-TEXT', agentId: 'agent-1' })
  await seen.clock.advance(0)
  expect(seen.bodies.length).toBe(asked)
  await step($, 't1', 1)
  expect(seen.models[1]).toBe('claude-opus-5-5')
})
