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
  }
  const clock = mock.clock(on)
  mock.env(on, setup.env ?? { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' })
  if (setup.mode) seen.store.set('decision-router:mode', setup.mode)
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
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
    if (setup.fetch) return setup.fetch(e)
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
  on('ui.close', () => ({ value: undefined }))
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

test('watching shows in the prompt footer', async ($, on) => {
  stubs(on, { mode: 'watch' })
  on('ui.render', ($: any, e: any) => ({ type: 'Text', props: {}, children: [(e.props?.modes ?? []).join(',')] }))
  await start($)
  const footer = await $.ui.mount({ plugin: 'decision-router', component: 'SessionMode', surface: 'terminal', viewport: VIEWPORT, props: { modes: [] } })
  expect(await footer.find({ type: 'Text', text: 'router watching' })).toBeDefined()
})

// --- The pane ---

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
  expect(await ui.find({ type: 'Text', text: /^debugging · difficulty 2\.9 · confidence 0\.88$/ })).toBeDefined()
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
