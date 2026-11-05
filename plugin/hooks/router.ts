// decision-router: picks the Claude model for each turn. The decision model describes the task, src/ decides and
// draws, and this file only wires Claude Code's events to that logic. Every mods API call lives here, written in full,
// so Claude Code can list what the mod does before it runs.

import { backendOf, buildBody, endpointFor, hostOf, parseAnswers, warmupBody } from '../src/classifier.ts';
import type { Endpoint } from '../src/classifier.ts';
import { tierConfidence, tierDistribution } from '../src/features.ts';
import { append, markEscalated, markOverride, recordOf, tune } from '../src/journal.ts';
import type { JournalRecord } from '../src/journal.ts';
import { decide, escalate, initialState, POLICY } from '../src/policy.ts';
import { accountIdOf, backendOfAnswer, DEFAULT_LOCAL_URL, keyHelp, normalizeUrl, SAMPLE_PROMPT, SETUP_OPTIONS } from '../src/setup.ts';
import { addUsage, appendSpawn, escalatedTier, isCheaper, kindOf, pickFor, recordOfSpawn, summarize, updateSpawn } from '../src/spawn.ts';
import type { PickReason, SpawnKind, SpawnMode, SpawnRecord } from '../src/spawn.ts';
import { requestEffort, routeFor, TIERS, tierOfModel } from '../src/tiers.ts';
import type { Backend, Decision, Features, Mode, PolicyState, Preference, Route, Tier } from '../src/types.ts';
import { bandText, choiceOf, mainMenu, pinMenu, renderBand, renderPane, switchToast, tuneAdvice, usageText } from '../src/view.ts';
import type { Actions, PaneTab, Snapshot } from '../src/view.ts';

type Options = {
  mode?: string;
  backend?: string;
  preference?: string;
  allow_fable?: boolean;
  min_confidence?: number;
  cloudflare_account_id?: string;
  cloudflare_api_token?: string;
  typesafe_api_key?: string;
  local_url?: string;
  local_api_key?: string;
  decision_model?: string;
  timeout_ms?: number;
};

type Advice = { features: Features | null; error: string | null; latencyMs: number | null };
type SpawnJob = { prompt: string; resolve: (advice: Advice) => void };
type SpawnRoute = { route: Route; tier: Tier; ceiling: Tier; features: Features | null; toolErrors: number; escalated: boolean };
// What the router decided before a subagent started. `route` is null when the subagent keeps its usual model.
type SpawnPlan = {
  kind: SpawnKind;
  ceiling: Tier;
  pick: Tier | null;
  reason: PickReason;
  confidence: number | null;
  activity: string | null;
  advice: Advice | null;
  route: Route | null;
};

const PANE = 'decision-router';
const MODE_KEY = 'decision-router:mode';
const JOURNAL_KEY = 'decision-router:journal';
const DETAIL_KEY = 'decision-router:detail';
const SPAWN_MODE_KEY = 'decision-router:subagent-mode';
const SPAWN_LOG_KEY = 'decision-router:subagent-log';
// A hosted decision model answers in well under a second; a model on your own machine or network gets longer.
const HOSTED_TIMEOUT_MS = 2500;
const LOCAL_TIMEOUT_MS = 8000;
// Setup waits longer than a turn does: a local server loads its model on the first request.
const SETUP_TIMEOUT_MS = 20000;
const FAILURES_TO_PAUSE = 3;
const PAUSE_MS = 60_000;
const BASELINE: Tier = 'sonnet';
// Subagents waiting for the decision model. A larger burst goes unasked rather than building a long line.
const MAX_SPAWN_QUEUE = 8;
const SPAWN_WAIT_STEP_MS = 100;

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

// One activation's state. Claude Code runs one session per process, so module state is the session's.
let options: Options = {};
let mode: Mode = 'watch';
let paused = false;
let choosing = false;
let pin: Tier | null = null;
let paneTab: PaneTab = 'now';
let detail = false;
let policy: PolicyState = initialState();
let journal: JournalRecord[] = [];
let current: { decision: Decision; route: Route | null; features: Features | null } | null = null;
let usedPercent: number | null = null;
let windows: { fiveHour: number | null; sevenDay: number | null } = { fiveHour: null, sevenDay: null };
let contextPercent: number | null = null;
let cacheHit: number | null = null;
let nativeModel: string | null = null;
let sessionStart = 0;
let lastError: string | null = null;
let lastLatency: number | null = null;
let toolErrors = 0;
let escalatedTurn: string | null = null;
let failures = 0;
let pausedUntil = 0;
// A request still waiting for its server. $.http.fetch cannot be cancelled, so a timed-out request runs on; no new
// one is sent until it settles, which keeps a slow server from receiving a backlog of requests nobody reads.
let inFlight = false;
// ROUTER_BACKEND, ROUTER_LOCAL_URL and ROUTER_DECISION_MODEL override the saved settings when set, read at session
// start: handy with --plugin-dir, where no settings are saved.
let overrides: { backend?: string; localUrl?: string; decisionModel?: string } = {};
const jobs = new Map<string, Promise<Advice>>();
// Subagents keep to themselves: their own log, their own line and their own failure count, so they cannot take a main
// turn's request, push out the main log or pause main routing.
let spawnMode: SpawnMode = 'off';
let spawnLog: SpawnRecord[] = [];
let spawnQueue: SpawnJob[] = [];
let spawnDraining = false;
// The last subagent request sent: it may outlive its timeout, and no new one goes out until it settles.
let spawnCall: Promise<unknown> | null = null;
let spawnFailures = 0;
let spawnPausedUntil = 0;
// The model and effort of each subagent the router set, by id, for its model requests.
const spawnRoutes = new Map<string, SpawnRoute>();

export function register(on: any, opts: Options) {
  options = opts ?? {};

  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({
      name: 'router',
      description: 'Model routing: quick menu, or setup, test, pane, on, watch, route, off, pin <tier>, log [n], tune, status, subagents [on|watch|off]',
      argumentHint: '[setup|test|pane|on|watch|route|off|pin <tier>|log [n]|tune|status|subagents [on|watch|off]]',
      immediate: true,
    });
    await migrate($);
    mode = pick((await $.store.get(MODE_KEY)) ?? options.mode, ['watch', 'route', 'off'] as const, 'watch');
    detail = (await $.store.get(DETAIL_KEY)) === true;
    const saved = await $.store.get(JOURNAL_KEY);
    journal = Array.isArray(saved) ? saved : [];
    spawnMode = pick(await $.store.get(SPAWN_MODE_KEY), ['on', 'watch', 'off'] as const, 'off');
    const savedSpawns = await $.store.get(SPAWN_LOG_KEY);
    spawnLog = Array.isArray(savedSpawns) ? savedSpawns : [];
    spawnQueue = [];
    spawnRoutes.clear();
    spawnFailures = 0;
    spawnPausedUntil = 0;
    nativeModel = await $.session.model();
    paused = false;
    choosing = false;
    pin = null;
    policy = initialState();
    current = null;
    lastError = null;
    sessionStart = Date.now();
    overrides = {
      backend: (await $.env.get('ROUTER_BACKEND')) || undefined,
      localUrl: (await $.env.get('ROUTER_LOCAL_URL')) || undefined,
      decisionModel: (await $.env.get('ROUTER_DECISION_MODEL')) || undefined,
    };
    // A local server loads its model on the first request, which can take 10-20 seconds: start that now, in the
    // background, so the first prompt finds it ready.
    const endpoint = endpointOf();
    if (mode !== 'off' && !('error' in endpoint) && endpoint.local) warmUp($, endpoint);
    return next(e);
  });

  // Start asking the decision model as soon as the turn exists, so the answer is usually ready by its first request.
  // A pinned turn and a turn without typed text (a continuation) ask nothing.
  on('turn.start', async ($: any, e: any, next: any) => {
    // A subagent's run starts a turn of its own. Routing is the main conversation's, and its prompt stays here.
    if (e.agentId) return next(e);
    toolErrors = 0;
    if (mode !== 'off' && !paused && !pin && e.text.trim()) {
      jobs.set(e.turnId, classify($, e.text));
      choosing = true;
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });

  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId) {
      const routed = spawnMode === 'on' ? spawnRoutes.get(e.agentId) : undefined;
      if (routed && routed.toolErrors >= POLICY.escalateAfterErrors && !routed.escalated) await escalateSpawn($, e.agentId, routed);
      const result = yield* next(routed ? { ...e, model: routed.route.model, effort: requestEffort(routed.route.effort, e.effort) } : e);
      if (result?.usage) spawnLog = updateSpawn(spawnLog, e.agentId, (r) => addUsage(r, result.usage));
      return result;
    }
    if (mode === 'off' || paused) return yield* next(e);
    if (e.index === 0) {
      const before = current?.route ?? null;
      const job = jobs.get(e.turnId);
      jobs.delete(e.turnId);
      if (pin) await pinTurn($, pin);
      else if (job) await decideTurn($, await job);
      choosing = false;
      $.ui.invalidate('ui.render');
      const after = current?.route ?? null;
      if (mode === 'route' && before && after && current && before.model !== after.model)
        $.ui.toast(switchToast(labelOf(), before, after, current.decision));
    } else if (toolErrors >= POLICY.escalateAfterErrors && escalatedTurn !== e.turnId) {
      const up = escalate(policy, BASELINE, { usedPercent });
      escalatedTurn = e.turnId;
      if (up) {
        const before = current?.route ?? null;
        policy = up.state;
        const features = current?.features ?? null;
        current = { decision: up, route: await routeOf($, up.tier, features), features };
        journal = markEscalated(journal);
        if (before && current.route) $.ui.toast(switchToast(labelOf(), before, current.route, up));
        $.ui.invalidate('ui.render');
      }
    }
    const request =
      mode === 'route' && current?.route
        ? { ...e, model: current.route.model, effort: requestEffort(current.route.effort, e.effort) }
        : e;
    const result = yield* next(request);
    readCache(result?.usage);
    return result;
  });

  on('tool.call', async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (!e.agentId && result?.isError) toolErrors += 1;
    if (e.agentId && result?.isError) {
      spawnLog = updateSpawn(spawnLog, e.agentId, (r) => ({ toolErrors: r.toolErrors + 1 }));
      const routed = spawnRoutes.get(e.agentId);
      if (routed) routed.toolErrors += 1;
    }
    return result;
  });

  // On: the pick is settled before the subagent starts, within a bounded wait, and sets its model. Watch: the subagent
  // starts as asked, and the pick is worked out afterward for the log.
  on('agent.spawn', async ($: any, e: any, next: any) => {
    if (spawnMode === 'off' || mode === 'off' || paused) return next(e);
    const plan = spawnMode === 'on' ? await planSpawn($, e) : null;
    const result = await next(plan?.route ? { ...e, model: plan.route.model } : e);
    if (!result?.deny) await noteSpawn($, e, result, plan);
    return result;
  });

  // A subagent's usage and tool errors build up in memory and are saved when it finishes.
  on('turn.complete', async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (e.agentId && spawnLog.some((r) => r.id === e.agentId)) await saveSpawns($);
    return result;
  });

  // Plan usage and context fill arrive with each response; keep the latest for the policy and the band.
  on('session.measure', async ($: any, e: any, next: any) => {
    readWindows(e.rateLimits);
    if (typeof e.context?.percent === 'number') contextPercent = e.context.percent;
    $.ui.invalidate('ui.render');
    return next(e);
  });

  // Picking a model yourself is the strongest signal there is: record it against the last pick and stop routing for
  // this session until you turn it back on.
  on('command.run', { command: 'model' }, async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (e.origin?.kind !== 'plugin' && mode !== 'off') {
      nativeModel = await $.session.model();
      journal = markOverride(journal, tierOfModel(nativeModel));
      await $.store.set(JOURNAL_KEY, journal);
      paused = true;
      $.ui.toast('Router paused: you picked a model. Turn on from the band, or /router on.');
      $.ui.invalidate('ui.render');
    }
    return result;
  });

  on('command.run', { command: 'router' }, async ($: any, e: any) => {
    const args = String(e.args ?? '').trim();
    $.ui.log(`router command args: ${JSON.stringify(e.args ?? null)}`, { to: 'debug' });
    const [verb, arg] = args.split(/\s+/);
    if (verb === 'on' || verb === 'route' || verb === 'watch' || verb === 'off') {
      await setMode($, verb === 'on' ? (mode === 'off' ? 'watch' : mode) : verb);
      return { text: modeText() };
    }
    if (verb === 'pin') {
      const tier = TIERS.find((t) => t === arg) ?? null;
      if (!tier) return { text: 'Usage: /router pin haiku | sonnet | opus | fable' };
      pin = tier;
      $.ui.invalidate('ui.render');
      return { text: `The next turn runs on ${tier}.` };
    }
    if (verb === 'log') return { text: logText(journal, Number(arg) || 10) };
    if (verb === 'tune') return { text: tuneText(journal) };
    if (verb === 'status') return { text: statusText() };
    if (verb === 'subagents') {
      if (arg === 'on' || arg === 'watch' || arg === 'off') return { text: await setSpawnMode($, arg) };
      if (arg) return { text: 'Usage: /router subagents [on | watch | off]' };
      return { text: spawnText(spawnLog) };
    }
    if (verb === 'test') return { text: await testText($) };
    if (verb === 'setup') return { text: await setup($) };
    if (verb === 'pane' || verb === 'details') {
      await openPane($);
      return {};
    }
    if (args && verb !== 'menu') return { text: `Unknown option "${args}".\n${HELP}` };
    // No argument: the quick menu where someone can answer it, the status as text where no one can.
    if (!(await $.session.surfaces()).length) return { text: statusText() };
    await openMenu($);
    return {};
  });

  // While the decision model answers, the spinner says so; Claude Code's own word returns once the model is chosen.
  on('ui.render', { component: 'Spinner' }, async ($: any, e: any, next: any) => {
    if (!choosing || e.props.message !== null) return next(e);
    return next({ ...e, props: { ...e.props, message: 'Choosing model' } });
  });

  // In the terminal the band sits on the line under the prompt, below the permission mode ("auto mode"): the hint line
  // is drawn as Claude Code draws it, and the band under it.
  on('ui.render', { component: 'PromptHint' }, async ($: any, e: any, next: any) => {
    const elements = $.ui.resolve(e);
    const columns = Math.max(40, (e.viewport?.columns ?? 120) - 4);
    return elements.Box({ flexDirection: 'column', children: [await next(e), renderBand(elements, snapshot(), actionsOf($), columns)] });
  });

  // The desktop app draws no hint line, so there the band stays above the prompt. The pane is the same everywhere.
  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($: any, e: any, next: any) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const elements = $.ui.resolve(e);
    if (e.component === 'Pane') return renderPane(elements, snapshot(), paneTab, actionsOf($), e.props.bodyColumns);
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e);
    return elements.Box({
      flexDirection: 'column',
      children: [await next(e), renderBand(elements, snapshot(), actionsOf($), e.props.bodyColumns ?? 120)],
    });
  });
}

// --- Functions that take $ (top level, so validation can follow the calls) ---

function actionsOf($: any): Actions {
  return {
    setMode: (m) => setMode($, m),
    resume: () => setMode($, mode === 'off' ? 'watch' : mode),
    pin: (tier) => pinNext($, tier),
    open: () => openPane($),
    close: () => closePane($),
    tab: (tab) => showTab($, tab),
    toggleDetail: () => toggleDetail($),
    menu: () => openMenu($),
  };
}

// The quick menu, in Claude Code's own question dialog: numbered, answered from the keyboard. Pin next turn asks a
// second question for the tier. Dismissing it changes nothing.
async function openMenu($: any) {
  let step = mainMenu(snapshot());
  for (let i = 0; i < 2; i += 1) {
    let answer: string;
    try {
      answer = await $.ui.ask(step.question, step.options.map((o) => o.label));
    } catch {
      return;
    }
    const choice = choiceOf(step, answer);
    if (!choice) return;
    if (choice.kind === 'pin-menu') {
      step = pinMenu(snapshot());
      continue;
    }
    if (choice.kind === 'mode') await setMode($, choice.mode);
    else if (choice.kind === 'resume') await setMode($, mode === 'off' ? 'watch' : mode);
    else if (choice.kind === 'pin') await pinNext($, choice.tier);
    else await openPane($);
    return;
  }
}

// The plugin was called router-enhanced before 0.6. Its saved mode, band layout and decision log move to the new keys
// the first time the renamed plugin starts; the old keys are left as they were.
async function migrate($: any) {
  for (const [from, to] of [
    ['router-enhanced:mode', MODE_KEY],
    ['router-enhanced:detail', DETAIL_KEY],
    ['router-enhanced:journal', JOURNAL_KEY],
  ]) {
    try {
      if ((await $.store.get(to)) !== undefined) continue;
      const old = await $.store.get(from);
      if (old !== undefined) await $.store.set(to, old);
    } catch {}
  }
}

async function setMode($: any, m: Mode) {
  paused = false;
  mode = m;
  await $.store.set(MODE_KEY, mode);
  $.ui.invalidate('ui.render');
}

async function setSpawnMode($: any, m: SpawnMode): Promise<string> {
  spawnMode = m;
  await $.store.set(SPAWN_MODE_KEY, m);
  if (m === 'off') {
    const waiting = spawnQueue;
    spawnQueue = [];
    spawnRoutes.clear();
    for (const job of waiting) job.resolve({ features: null, error: 'subagent routing was turned off', latencyMs: null });
    await saveSpawns($);
    return 'Subagent routing is off.';
  }
  const sends = `The task text of general subagents now also goes to ${labelOf()}.`;
  if (m === 'on') return `Subagent routing is on: the router sets the model of Explore and general subagents, never above the one they would use anyway. ${sends}`;
  return `Watching subagents: each one still runs on its usual model. ${sends} /router subagents shows what the router would have picked.`;
}

async function pinNext($: any, tier: Tier | null) {
  pin = tier;
  $.ui.invalidate('ui.render');
}

async function toggleDetail($: any) {
  detail = !detail;
  await $.store.set(DETAIL_KEY, detail);
  $.ui.invalidate('ui.render');
}

async function openPane($: any) {
  paneTab = 'now';
  await $.ui.open({ id: PANE, title: 'Router', focus: true, closeOnEscape: true });
}

async function closePane($: any) {
  await $.ui.close({ id: PANE });
}

async function showTab($: any, tab: PaneTab) {
  paneTab = tab;
  $.ui.invalidate('ui.render');
}

// Fire and forget: the answer is not used, and a failure here changes nothing.
async function warmUp($: any, endpoint: Endpoint) {
  try {
    const key = await secretFor($, endpoint);
    await $.http.fetch(endpoint.url, {
      method: 'POST',
      headers: headersOf(key),
      body: JSON.stringify(warmupBody(endpoint)),
    });
  } catch {}
}

type TestResult = { ok: true; ms: number } | { ok: false; error: string };

// One real request, with every question, to a candidate endpoint: nothing of the router's failure counters or
// in-flight bookkeeping is touched, so a test never pauses routing.
async function runTest($: any, endpoint: Endpoint, key: string | null, timeoutMs: number): Promise<TestResult> {
  const where = hostOf(endpoint.url);
  const started = Date.now();
  try {
    const call = askSystemOne($, endpoint, key, SAMPLE_PROMPT, []);
    call.catch(() => {});
    const response = await Promise.race([call, $.clock.sleep(timeoutMs).then(() => null)]);
    if (!response) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)} s at ${where}` };
    parseAnswers(response);
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    return { ok: false, error: message.includes(where) ? message : `${message} (${where})` };
  }
}

// /router test: the configured decision model, tried once.
async function testText($: any): Promise<string> {
  const account = options.cloudflare_account_id || (await $.env.get('CLOUDFLARE_ACCOUNT_ID'));
  const endpoint = endpointOf(account);
  if ('error' in endpoint) return `The decision model is not set up: ${endpoint.error}. Run /router setup.`;
  const key = await secretFor($, endpoint);
  if (endpoint.keyRequired && !key) return keyHelp(backendOf(overrides.backend ?? options.backend));
  const result = await runTest($, endpoint, key, endpoint.local ? SETUP_TIMEOUT_MS : Math.max(HOSTED_TIMEOUT_MS, 8000));
  return result.ok
    ? `${endpoint.label} answered in ${result.ms} ms at ${hostOf(endpoint.url)}.`
    : `${endpoint.label} did not answer: ${result.error}\nRun /router setup to change the decision model.`;
}

// /router setup: pick a backend, find or name the server, test it, and save what worked. Keys are never asked for in
// the dialog: whatever is typed there stays in the scrollback, so they come from the shell or Configure options.
async function setup($: any): Promise<string> {
  if (!(await $.session.surfaces()).length)
    return 'Setup asks questions, so it needs an interactive session. Settings are under /plugin > decision-router > Configure options.';
  let picked: string;
  try {
    picked = await $.ui.ask('Which decision model should the router use?', { options: SETUP_OPTIONS.map((o) => o.label), header: 'Setup' });
  } catch {
    return 'Setup cancelled.';
  }
  const backend = backendOfAnswer(picked);
  if (!backend) return 'Setup cancelled: that was not one of the options.';
  try {
    const saved = backend === 'llamacpp' || backend === 'local' ? await setupLocal($, backend) : await setupHosted($, backend);
    const shell = overrides.backend && overrides.backend !== backend ? ' ROUTER_BACKEND is set in your shell and overrides this until you unset it.' : '';
    return `${saved}${shell}`;
  } catch {
    return 'Setup cancelled.';
  }
}

async function setupLocal($: any, backend: 'llamacpp' | 'local'): Promise<string> {
  let url = DEFAULT_LOCAL_URL[backend];
  const probe = (address: string) => {
    const endpoint = endpointFor({ backend, localUrl: address, decisionModel: options.decision_model });
    if ('error' in endpoint) return Promise.resolve<TestResult>({ ok: false, error: endpoint.error });
    $.ui.toast(`Testing ${hostOf(endpoint.url)} ...`);
    return secretFor($, endpoint).then((key) => runTest($, endpoint, key, SETUP_TIMEOUT_MS));
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await probe(url);
    if (result.ok) return `${await save($, { backend, local_url: url })}\nThe decision model answered in ${result.ms} ms at ${hostOf(url)}. ${modeText()} ${nextStep()}`;
    const hint =
      backend === 'llamacpp'
        ? 'Start llama-server with a decision model such as Clef or Laya loaded (see the README).'
        : 'Turn on Serve requests under Settings > API > Decision API in Unsloth.';
    const answer = await $.ui.ask(`Nothing usable answered at ${hostOf(url)}: ${result.error}. ${hint} Type the server's address below, or:`, {
      options: ['Retry', 'Save anyway', 'Cancel setup'],
      header: 'Setup',
    });
    if (answer === 'Cancel setup') return 'Setup cancelled. Nothing was saved.';
    if (answer === 'Save anyway') return `${await save($, { backend, local_url: url })}\nSaved without a working test. Run /router test once the server is up.`;
    if (answer === 'Retry') continue;
    const typed = normalizeUrl(answer);
    if (typed) url = typed;
    else $.ui.toast(`"${answer}" is not an address. Try host:port, for example 10.0.0.9:9931.`);
  }
  return 'Setup stopped after four tries. Nothing was saved. Check that the server is running, then run /router setup again.';
}

async function setupHosted($: any, backend: Backend): Promise<string> {
  const values: Record<string, string> = { backend };
  if (backend === 'clef-workers') {
    // An account ID already in settings or the shell is used as it is; only one typed here is saved.
    let account: string | null = options.cloudflare_account_id || (await $.env.get('CLOUDFLARE_ACCOUNT_ID')) || null;
    while (!account) {
      const answer = await $.ui.ask('What is your Cloudflare account ID? Type it below (32 characters, shown on the Workers AI page).', {
        options: ['Cancel setup', 'Skip for now'],
        header: 'Setup',
      });
      if (answer === 'Cancel setup') return 'Setup cancelled. Nothing was saved.';
      if (answer === 'Skip for now') break;
      account = accountIdOf(answer);
      if (account) values.cloudflare_account_id = account;
      else $.ui.toast('That is not a Cloudflare account ID: it is 32 letters and digits.');
    }
    if (!account) return `${await save($, values)}\nThe account ID is still missing: set CLOUDFLARE_ACCOUNT_ID, or add it under /plugin > decision-router > Configure options.`;
  }
  const saved = await save($, values);
  const endpoint = endpointFor({
    backend,
    cloudflareAccountId: values.cloudflare_account_id || options.cloudflare_account_id || (await $.env.get('CLOUDFLARE_ACCOUNT_ID')),
    decisionModel: options.decision_model,
  });
  if ('error' in endpoint) return `${saved}\n${endpoint.error}`;
  const key = await secretFor($, endpoint);
  if (!key) return `${saved}\n${keyHelp(backend)}`;
  const result = await runTest($, endpoint, key, Math.max(HOSTED_TIMEOUT_MS, 8000));
  return result.ok
    ? `${saved}\n${endpoint.label} answered in ${result.ms} ms. ${modeText()} ${nextStep()}`
    : `${saved}\n${endpoint.label} did not answer: ${result.error}\nCheck the key, then run /router test.`;
}

const nextStep = () => (mode === 'route' ? '' : 'Run /router route when the picks look right.');

// Writes the plugin's own settings the way /config would. A refusal comes back as text.
async function save($: any, values: Record<string, string>): Promise<string> {
  for (const [field, value] of Object.entries(values)) {
    const result = await $.config.set({ key: `decision-router.${field}`, value });
    if (result?.deny) return `Could not save ${field}: ${result.deny}`;
  }
  return `Saved: ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join(', ')}.`;
}

// The configured endpoint and its key, or why they are not usable.
async function connectionOf($: any): Promise<{ endpoint: Endpoint; key: string | null } | { error: string }> {
  const account = options.cloudflare_account_id || (await $.env.get('CLOUDFLARE_ACCOUNT_ID'));
  const endpoint = endpointOf(account);
  if ('error' in endpoint) return { error: endpoint.error };
  const key = await secretFor($, endpoint);
  if (endpoint.keyRequired && !key) return { error: `missing ${endpoint.key}` };
  return { endpoint, key };
}

async function classify($: any, text: string): Promise<Advice> {
  if (Date.now() < pausedUntil) return { features: null, error: 'paused for a minute after 3 failures', latencyMs: null };
  if (inFlight) return { features: null, error: 'the previous request is still running', latencyMs: null };
  const connection = await connectionOf($);
  if ('error' in connection) return { features: null, error: connection.error, latencyMs: null };
  const { endpoint, key } = connection;
  const timeoutMs = timeoutOf(endpoint);
  const where = hostOf(endpoint.url);
  const started = Date.now();
  try {
    const recent = await recentDialogue($);
    const prompt = text.slice(0, 6000);
    inFlight = true;
    const call = askSystemOne($, endpoint, key, prompt, recent);
    call.then(
      () => {
        inFlight = false;
      },
      () => {
        inFlight = false;
      },
    );
    const response = await Promise.race([call, $.clock.sleep(timeoutMs).then(() => null)]);
    if (!response) throw new Error(`timed out after ${timeoutMs / 1000} s at ${where}`);
    const features = parseAnswers(response);
    failures = 0;
    return { features, error: null, latencyMs: Date.now() - started };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURES_TO_PAUSE) pausedUntil = Date.now() + PAUSE_MS;
    const message = String((error as Error)?.message ?? error);
    // Network errors from the engine rarely name the host; add it once.
    return { features: null, error: message.includes(where) ? message : `${message} (${where})`, latencyMs: Date.now() - started };
  }
}

// What the router would do for a subagent about to start, or null when it should be left alone. Never throws: the
// subagent starts either way.
async function planSpawn($: any, e: any): Promise<SpawnPlan | null> {
  try {
    const kind = kindOf(e);
    if (kind !== 'explore' && kind !== 'general') return null;
    // A session that forces one model on every subagent has already decided.
    if (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')) return null;
    const ceiling = tierOfModel(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ?? tierOfModel(e.parentModel);
    if (!ceiling) return null;
    if (kind === 'explore') return { kind, ceiling, pick: 'haiku', reason: 'rule', confidence: null, activity: null, advice: null, route: await routeOf($, 'haiku', null) };
    const advice = await boundedAdvice($, e.prompt);
    const { pick: tier, reason, confidence } = pickOfAdvice(advice, ceiling);
    return { kind, ceiling, pick: tier, reason, confidence, activity: activityOf(advice), advice, route: tier ? await routeOf($, tier, advice.features) : null };
  } catch (error) {
    $.ui.log(`subagent routing: ${String((error as Error)?.message ?? error)}`, { to: 'debug' });
    return null;
  }
}

// Waits for the decision model no longer than one timeout, counted from now, so a subagent is never held long. A wait
// that runs out counts as a failure: a server that stopped answering soon stops holding subagents at all.
async function boundedAdvice($: any, prompt: string): Promise<Advice> {
  if (Date.now() < pausedUntil || Date.now() < spawnPausedUntil) return { features: null, error: 'paused for a minute after 3 failures', latencyMs: null };
  const connection = await connectionOf($);
  if ('error' in connection) return { features: null, error: connection.error, latencyMs: null };
  const limit = timeoutOf(connection.endpoint);
  const started = Date.now();
  const expired = Symbol('expired');
  let job: SpawnJob | undefined;
  const asked = new Promise<Advice>((resolve) => {
    if (spawnQueue.length >= MAX_SPAWN_QUEUE) return resolve({ features: null, error: 'too many subagents at once', latencyMs: null });
    job = { prompt, resolve };
    spawnQueue.push(job);
    drainSpawns($);
  });
  const answer = await Promise.race([asked, $.clock.sleep(limit).then(() => expired)]);
  if (answer !== expired) return answer as Advice;
  spawnQueue = spawnQueue.filter((j) => j !== job);
  spawnFailures += 1;
  if (spawnFailures >= FAILURES_TO_PAUSE) spawnPausedUntil = Date.now() + PAUSE_MS;
  return { features: null, error: `no answer within ${limit / 1000} s`, latencyMs: Date.now() - started };
}

function pickOfAdvice(advice: Advice, ceiling: Tier | null) {
  const preference = pick(options.preference, ['cost', 'balanced', 'quality'] as const, 'balanced') as Preference;
  const minConfidence = typeof options.min_confidence === 'number' ? options.min_confidence : 0.45;
  return pickFor(advice.features, ceiling, { preference, minConfidence, usage: { usedPercent } });
}

function activityOf(advice: Advice): string | null {
  const top = advice.features ? Object.entries(advice.features.activity).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] : undefined;
  return top ? top[0] : null;
}

// Records a subagent that just started. A watched general one goes in line for the decision model; its answer only
// fills in the record. A fault here is logged and goes no further: the subagent is already running.
async function noteSpawn($: any, e: any, result: any, plan: SpawnPlan | null) {
  try {
    const id = String(result?.agentId ?? e.tool_use_id);
    const actual = tierOfModel(result?.model);
    const blank = recordOfSpawn(id, Date.now(), plan?.kind ?? kindOf(e), actual);
    if (plan) {
      const { advice } = plan;
      spawnLog = appendSpawn(spawnLog, { ...blank, pick: plan.pick, reason: plan.reason, confidence: plan.confidence, activity: plan.activity, latencyMs: advice?.latencyMs ?? null, error: advice?.error ?? null, usual: plan.ceiling, routed: plan.route !== null });
      if (plan.route && plan.pick && result?.agentId) spawnRoutes.set(result.agentId, { route: plan.route, tier: plan.pick, ceiling: plan.ceiling, features: advice?.features ?? null, toolErrors: 0, escalated: false });
    } else if (spawnMode === 'watch') {
      spawnLog = appendSpawn(spawnLog, blank);
      if (blank.reason === 'pending') askAboutSpawn($, id, e.prompt, actual);
    } else {
      spawnLog = appendSpawn(spawnLog, { ...blank, pick: null, reason: 'not-routed' });
    }
    await saveSpawns($);
  } catch (error) {
    $.ui.log(`subagent routing: ${String((error as Error)?.message ?? error)}`, { to: 'debug' });
  }
}

// A watched subagent's question: nothing waits on it, and the answer goes to its record.
function askAboutSpawn($: any, id: string, prompt: string, actual: Tier | null) {
  const asked = new Promise<Advice>((resolve) => {
    if (spawnQueue.length >= MAX_SPAWN_QUEUE) return resolve({ features: null, error: 'too many subagents at once', latencyMs: null });
    spawnQueue.push({ prompt, resolve });
    drainSpawns($);
  });
  asked
    .then(async (advice) => {
      const { pick: tier, reason, confidence } = pickOfAdvice(advice, actual);
      spawnLog = updateSpawn(spawnLog, id, () => ({ pick: tier, reason, confidence, activity: activityOf(advice), latencyMs: advice.latencyMs, error: advice.error }));
      await saveSpawns($);
    })
    // The session may be closing by the time the answer comes; the record is in memory, and only the save is lost.
    .catch(() => {});
}

// One tier up after repeated tool errors, within the subagent's ceiling, once. A subagent already at its ceiling stays.
async function escalateSpawn($: any, id: string, routed: SpawnRoute) {
  routed.escalated = true;
  const tier = escalatedTier(routed.tier, routed.ceiling);
  if (!tier) return;
  const route = await routeOf($, tier, routed.features);
  if (!route) return;
  routed.tier = tier;
  routed.route = route;
  spawnLog = updateSpawn(spawnLog, id, () => ({ actual: tier, escalated: true }));
}

// Asks about one waiting subagent at a time, in the background. A request for a main turn goes first: nothing is sent
// while one is running, and a subagent that waits longer than one timeout goes unasked.
async function drainSpawns($: any) {
  if (spawnDraining) return;
  spawnDraining = true;
  try {
    while (spawnQueue.length) {
      await spawnCall;
      const connection = await connectionOf($);
      const limit = 'error' in connection ? 0 : timeoutOf(connection.endpoint);
      let waited = 0;
      while (inFlight && waited < limit) {
        await $.clock.sleep(SPAWN_WAIT_STEP_MS);
        waited += SPAWN_WAIT_STEP_MS;
      }
      const job = spawnQueue.shift();
      if (!job) break;
      job.resolve(await adviceForSpawn($, connection, job.prompt));
    }
  } catch (error) {
    $.ui.log(`subagent routing: ${String((error as Error)?.message ?? error)}`, { to: 'debug' });
  } finally {
    spawnDraining = false;
  }
}

// One decision-model request about a subagent's task. Its own prompt says all there is: the main conversation's last
// messages describe something else.
async function adviceForSpawn($: any, connection: { endpoint: Endpoint; key: string | null } | { error: string }, prompt: string): Promise<Advice> {
  if ('error' in connection) return { features: null, error: connection.error, latencyMs: null };
  if (inFlight) return { features: null, error: 'a main turn was still asking', latencyMs: null };
  if (Date.now() < pausedUntil || Date.now() < spawnPausedUntil) return { features: null, error: 'paused for a minute after 3 failures', latencyMs: null };
  const { endpoint, key } = connection;
  const timeoutMs = timeoutOf(endpoint);
  const where = hostOf(endpoint.url);
  const started = Date.now();
  const call = askSystemOne($, endpoint, key, prompt.slice(0, 6000), []);
  spawnCall = call.catch(() => {});
  try {
    const response = await Promise.race([call, $.clock.sleep(timeoutMs).then(() => null)]);
    if (!response) throw new Error(`timed out after ${timeoutMs / 1000} s at ${where}`);
    const features = parseAnswers(response);
    spawnFailures = 0;
    return { features, error: null, latencyMs: Date.now() - started };
  } catch (error) {
    spawnFailures += 1;
    if (spawnFailures >= FAILURES_TO_PAUSE) spawnPausedUntil = Date.now() + PAUSE_MS;
    const message = String((error as Error)?.message ?? error);
    return { features: null, error: message.includes(where) ? message : `${message} (${where})`, latencyMs: Date.now() - started };
  }
}

async function saveSpawns($: any) {
  await $.store.set(SPAWN_LOG_KEY, spawnLog);
}

// One System One request with every question. Resolves to the answer body.
async function askSystemOne($: any, endpoint: Endpoint, key: string | null, prompt: string, recent: string[]) {
  const response = await $.http.fetch(endpoint.url, {
    method: 'POST',
    headers: headersOf(key),
    body: JSON.stringify(buildBody(endpoint, prompt, recent)),
  });
  if (!response.ok) {
    // llama-server answers /v1/systemone only when it runs a decision model such as Laya or Clef.
    if (endpoint.llama && response.status === 501)
      throw new Error(`HTTP 501 from ${hostOf(endpoint.url)}: llama-server is not running a decision model (Laya, Clef)`);
    throw new Error(`HTTP ${response.status} from ${hostOf(endpoint.url)}${serverMessage(response.text)}`);
  }
  return JSON.parse(response.text);
}

// Sensitive options may not reach `options`; Claude Code also exports every option to the environment.
async function secretFor($: any, endpoint: Endpoint): Promise<string | null> {
  if (endpoint.key === 'typesafe_api_key')
    return pickKey(
      options.typesafe_api_key,
      await $.env.get('CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY'),
      await $.env.get('TYPESAFE_API_KEY'),
    );
  if (endpoint.key === 'cloudflare_api_token')
    return pickKey(
      options.cloudflare_api_token,
      await $.env.get('CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN'),
      await $.env.get('CLOUDFLARE_API_TOKEN'),
    );
  return pickKey(
    options.local_api_key,
    await $.env.get('CLAUDE_PLUGIN_OPTION_LOCAL_API_KEY'),
    await $.env.get('ROUTER_LOCAL_API_KEY'),
  );
}

// Claude Code's key fields can be replaced but never emptied, so "none" (or "-", "off", "clear") in one means no key,
// and stops the lookup there. The saved setting comes first, then the shell.
const CLEARED = /^(none|-|off|clear)$/i;
function pickKey(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v !== 'string' || !v.trim()) continue;
    return CLEARED.test(v.trim()) ? null : v.trim();
  }
  return null;
}

// The last two messages, clipped, so the decision model can tell "yes, do it" from a new task.
async function recentDialogue($: any): Promise<string[]> {
  try {
    const messages = await $.session.messages();
    return messages.slice(-2).map((m: any) => `${m.role}: ${typeof m.text === 'string' ? m.text.slice(0, 500) : ''}`);
  } catch {
    return [];
  }
}

async function readUsage($: any): Promise<number | null> {
  try {
    const usage = await $.session.usage();
    readWindows(usage.rateLimits);
    if (typeof usage.context?.percent === 'number') contextPercent = usage.context.percent;
    return typeof usage.context?.tokens === 'number' ? usage.context.tokens : null;
  } catch {
    return null;
  }
}

async function decideTurn($: any, advice: Advice) {
  const contextTokens = await readUsage($);
  const preference = pick(options.preference, ['cost', 'balanced', 'quality'] as const, 'balanced') as Preference;
  const allowFable = options.allow_fable === true;
  const distribution = advice.features ? tierDistribution(advice.features, { preference, allowFable }) : null;
  // The confidence that gates the pick is the one in the tier, so it is also the one the band, pane and log show.
  const f = advice.features && distribution ? { ...advice.features, confidence: tierConfidence(distribution) } : advice.features;
  const decision = decide({
    state: policy,
    distribution,
    confidence: f?.confidence ?? 0,
    continuation: f?.continuation ?? 0,
    usage: { usedPercent },
    contextTokens,
    preference,
    minConfidence: typeof options.min_confidence === 'number' ? options.min_confidence : 0.45,
    baseline: BASELINE,
  });
  policy = decision.state;
  lastError = advice.error;
  if (advice.latencyMs !== null && !advice.error) lastLatency = advice.latencyMs;
  current = { decision, route: await routeOf($, decision.tier, f), features: f };
  await record($, decision, f, advice.latencyMs, advice.error);
}

// A pin serves one turn and leaves the policy's tier where it was, as in claude-router.
async function pinTurn($: any, tier: Tier) {
  await readUsage($);
  pin = null;
  const decision: Decision = { tier, reason: 'pinned', distribution: null, bar: null, mass: null, state: policy };
  current = { decision, route: await routeOf($, tier, null), features: null };
  await record($, decision, null, null, null);
}

async function record($: any, decision: Decision, f: Features | null, latencyMs: number | null, error: string | null) {
  journal = append(journal, recordOf({ at: Date.now(), mode, decision, features: f, usedPercent, windows, latencyMs, error }));
  await $.store.set(JOURNAL_KEY, journal);
}

async function routeOf($: any, tier: Tier, f: Features | null): Promise<Route | null> {
  let available: string[] | undefined;
  try {
    const settings = await $.settings.read();
    if (Array.isArray(settings?.availableModels)) available = settings.availableModels;
  } catch {}
  return routeFor(tier, f, available);
}

// --- Plain functions ---

function endpointOf(account?: string | null) {
  return endpointFor({
    backend: backendOf(overrides.backend ?? options.backend),
    cloudflareAccountId: account ?? options.cloudflare_account_id,
    localUrl: overrides.localUrl ?? options.local_url,
    decisionModel: overrides.decisionModel ?? options.decision_model,
  });
}

// The reason a server gave with an error, briefly: llama-server says, for example, that the batch is too small.
function serverMessage(text: unknown): string {
  let message = '';
  try {
    const body = JSON.parse(String(text));
    message = String(body?.error?.message ?? body?.error ?? body?.message ?? body?.detail ?? '');
  } catch {
    message = String(text ?? '');
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message ? `: ${message.slice(0, 140)}` : '';
}

function headersOf(key: string | null): Record<string, string> {
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

function labelOf(): string {
  const endpoint = endpointOf(options.cloudflare_account_id || 'unset');
  return 'error' in endpoint ? 'Decision model' : endpoint.label;
}

function timeoutOf(endpoint: Endpoint): number {
  const set = options.timeout_ms;
  if (typeof set === 'number' && set >= 200) return set;
  return endpoint.local ? LOCAL_TIMEOUT_MS : HOSTED_TIMEOUT_MS;
}

function snapshot(): Snapshot {
  const endpoint = endpointOf(options.cloudflare_account_id || 'unset');
  return {
    mode,
    paused,
    choosing,
    pin,
    current,
    windows,
    contextPercent,
    cacheHit,
    journal,
    sessionStart,
    label: labelOf(),
    timeoutMs: 'error' in endpoint ? HOSTED_TIMEOUT_MS : timeoutOf(endpoint),
    error: lastError,
    latencyMs: lastLatency,
    nativeModel,
    preference: options.preference ?? 'balanced',
    fable: options.allow_fable === true,
    detail,
  };
}

function readWindows(limits: unknown) {
  if (!Array.isArray(limits)) return;
  const of = (kind: string) => {
    const w = limits.find((l: any) => l?.kind === kind);
    return typeof w?.percentUsed === 'number' ? w.percentUsed : null;
  };
  windows = { fiveHour: of('five_hour'), sevenDay: of('seven_day') };
  const known = [windows.fiveHour, windows.sevenDay].filter((x): x is number => x !== null);
  usedPercent = known.length ? Math.max(...known) : null;
}

// Share of the request's input the prompt cache served.
function readCache(usage: any) {
  if (!usage) return;
  const read = Number(usage.cache_read_input_tokens) || 0;
  const total = read + (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
  if (total > 0) cacheHit = read / total;
}

const HELP = 'Commands: /router (quick menu) | setup | test | pane | on | watch | route | off | pin <tier> | log [n] | tune | status | subagents [on | watch | off]';

function modeText(): string {
  return `Routing is ${mode === 'route' ? 'on' : mode === 'watch' ? 'in watch mode (picks shown, nothing changed)' : 'off'}.`;
}

function statusText(): string {
  const s = snapshot();
  const usage = usageText(s.windows);
  return [
    `${bandText(s)}${usage ? ` · ${usage}` : ''}`,
    `Mode: ${mode}${paused ? ' (paused for this session)' : ''}. Decision model: ${s.label} (${backendOf(overrides.backend ?? options.backend)}). Preference: ${s.preference}. Fable: ${s.fable ? 'allowed' : 'off'}.`,
    lastError ? `Last decision model error: ${lastError}\nRun /router setup to change the decision model, or /router test to try it.` : '',
    HELP,
  ]
    .filter(Boolean)
    .join('\n');
}

function logText(records: JournalRecord[], n: number): string {
  if (!records.length) return 'No decisions yet.';
  return records
    .slice(-Math.min(50, n))
    .map((r) => {
      const when = new Date(r.at).toISOString().slice(5, 16).replace('T', ' ');
      const what = r.error ? `error: ${r.error}` : `${r.activity ?? '-'} d${r.difficulty ?? '-'} c${r.confidence ?? '-'}`;
      const lean = r.lean && r.lean !== r.tier ? `  leaned ${r.lean}` : '';
      return `${when}  ${r.mode.padEnd(5)} ${r.tier.padEnd(6)} ${r.reason.padEnd(14)} ${what}${lean}${r.outcome === 'ok' ? '' : `  [${r.outcome}]`}`;
    })
    .join('\n');
}

function spawnText(records: SpawnRecord[]): string {
  const state =
    spawnMode === 'on'
      ? 'on: the router sets the model of Explore and general subagents'
      : spawnMode === 'watch'
        ? 'watching: subagents still run on their usual models'
        : 'off. /router subagents on routes them; /router subagents watch only shows the picks';
  const heading = `Subagents: ${state}.`;
  if (!records.length) return `${heading}\nNo subagents recorded yet.`;
  const s = summarize(records);
  const kinds = Object.entries(s.byKind)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  const of = (tokens: number) => `${s.totalTokens ? Math.round((tokens / s.totalTokens) * 100) : 0}% of all subagent tokens (${tokens.toLocaleString('en-US')} of ${s.totalTokens.toLocaleString('en-US')})`;
  const recent = records.slice(-10).map((r) => {
    const when = new Date(r.at).toISOString().slice(5, 16).replace('T', ' ');
    const usual = r.usual ?? r.actual;
    const target = r.routed ? r.actual : r.pick;
    const move = target && usual !== target ? `${usual} → ${target}` : `${usual ?? 'unknown'}`;
    const flag = r.escalated ? '  escalated' : isCheaper(r) ? (r.routed ? '  routed' : '  cheaper') : '';
    const fault = r.error ? `  error: ${r.error}` : r.toolErrors ? `  ${r.toolErrors} tool errors` : '';
    return `${when}  ${r.kind.padEnd(8)} ${move.padEnd(16)} ${r.reason.padEnd(14)} ${(r.inputTokens + r.outputTokens).toLocaleString('en-US')} tokens${flag}${fault}`;
  });
  const lines = [
    heading,
    `Seen: ${s.seen} (${kinds}).`,
    s.routed ? `Routed: ${s.routed}, of which ${s.moved} ran cheaper than usual, using ${of(s.movedTokens)}.` : '',
    s.picked ? `Could have been cheaper: ${s.cheaper} of ${s.picked} with a pick, using ${of(s.cheaperTokens)}.` : '',
    s.escalated ? `Moved up after tool errors: ${s.escalated}.` : '',
    `Tool errors: ${s.toolErrors} across ${s.withErrors} subagents.`,
    `Decision model: asked ${s.asked} times, ${s.askErrors} failed, median ${s.latencyMedianMs ?? '-'} ms.`,
  ].filter(Boolean);
  return [...lines, '', ...recent].join('\n');
}

function tuneText(records: JournalRecord[]): string {
  const t = tune(records);
  const share = Object.entries(t.tierShare)
    .map(([tier, s]) => `${tier} ${Math.round((s ?? 0) * 100)}%`)
    .join(', ');
  const lean = Object.entries(t.leanShare)
    .map(([tier, s]) => `${tier} ${Math.round((s ?? 0) * 100)}%`)
    .join(', ');
  return [
    `Decisions: ${t.decisions}. Tier mix: ${share || 'none'}.`,
    t.leaned ? `The decision model leaned (before the confidence filter and the policy): ${lean} of ${t.leaned}.` : '',
    `Corrected upward: ${Math.round(t.upRate * 100)}%. Corrected downward: ${Math.round(t.downRate * 100)}%.`,
    `Decision model: median ${t.latencyMedianMs ?? '-'} ms, errors ${Math.round(t.errorRate * 100)}%.`,
    tuneAdvice(t.suggestion, t.decisions),
  ]
    .filter(Boolean)
    .join('\n');
}
