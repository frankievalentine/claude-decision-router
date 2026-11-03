// decision-router: picks the Claude model for each turn. The decision model describes the task, src/ decides and
// draws, and this file only wires Claude Code's events to that logic. Every mods API call lives here, written in full,
// so Claude Code can list what the mod does before it runs.

import { backendOf, buildBody, endpointFor, hostOf, parseAnswers, warmupBody } from '../src/classifier.ts';
import type { Endpoint } from '../src/classifier.ts';
import { tierDistribution } from '../src/features.ts';
import { append, markEscalated, markOverride, recordOf, tune } from '../src/journal.ts';
import type { JournalRecord } from '../src/journal.ts';
import { decide, escalate, initialState, POLICY } from '../src/policy.ts';
import { requestEffort, routeFor, TIERS, tierOfModel } from '../src/tiers.ts';
import type { Decision, Features, Mode, PolicyState, Preference, Route, Tier } from '../src/types.ts';
import { bandText, footerLabel, renderBand, renderPane, switchToast, tuneAdvice, usageText } from '../src/view.ts';
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

const PANE = 'decision-router';
const MODE_KEY = 'decision-router:mode';
const JOURNAL_KEY = 'decision-router:journal';
const DETAIL_KEY = 'decision-router:detail';
// A hosted decision model answers in well under a second; a model on your own machine or network gets longer.
const HOSTED_TIMEOUT_MS = 2500;
const LOCAL_TIMEOUT_MS = 8000;
const FAILURES_TO_PAUSE = 3;
const PAUSE_MS = 60_000;
const BASELINE: Tier = 'sonnet';

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

export function register(on: any, opts: Options) {
  options = opts ?? {};

  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({
      name: 'router',
      description: 'Model routing: open the pane, or on, watch, route, off, pin <tier>, log [n], tune, status',
      argumentHint: '[on|watch|route|off|pin <tier>|log [n]|tune|status]',
      immediate: true,
    });
    await migrate($);
    mode = pick((await $.store.get(MODE_KEY)) ?? options.mode, ['watch', 'route', 'off'] as const, 'watch');
    detail = (await $.store.get(DETAIL_KEY)) === true;
    const saved = await $.store.get(JOURNAL_KEY);
    journal = Array.isArray(saved) ? saved : [];
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
    toolErrors = 0;
    if (mode !== 'off' && !paused && !pin && e.text.trim()) {
      jobs.set(e.turnId, classify($, e.text));
      choosing = true;
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });

  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId || mode === 'off' || paused) return yield* next(e);
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
    if (args) return { text: `Unknown option "${args}".\n${HELP}` };
    // No argument: the pane where the surface can draw it, the status as text where it cannot.
    if (!(await $.session.surfaces()).length) return { text: statusText() };
    paneTab = 'now';
    await $.ui.open({ id: PANE, title: 'Router', focus: true, closeOnEscape: true });
    return {};
  });

  // While the decision model answers, the spinner says so; Claude Code's own word returns once the model is chosen.
  on('ui.render', { component: 'Spinner' }, async ($: any, e: any, next: any) => {
    if (!choosing || e.props.message !== null) return next(e);
    return next({ ...e, props: { ...e.props, message: 'Choosing model' } });
  });

  // Watching, paused or off stays visible in the prompt footer.
  on('ui.render', { component: 'SessionMode' }, async ($: any, e: any, next: any) => {
    const label = footerLabel(snapshot());
    return label ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } }) : next(e);
  });

  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($: any, e: any, next: any) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const elements = $.ui.resolve(e);
    const actions: Actions = {
      setMode: (m) => setMode($, m),
      resume: () => setMode($, mode === 'off' ? 'watch' : mode),
      pin: (tier) => pinNext($, tier),
      open: () => openPane($),
      close: () => closePane($),
      tab: (tab) => showTab($, tab),
      toggleDetail: () => toggleDetail($),
    };
    if (e.component === 'Pane') return renderPane(elements, snapshot(), paneTab, actions);
    if (e.props.hasSurvey) return next(e);
    return elements.Box({
      flexDirection: 'column',
      children: [await next(e), renderBand(elements, snapshot(), actions, e.props.bodyColumns ?? 120)],
    });
  });
}

// --- Functions that take $ (top level, so validation can follow the calls) ---

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
  await $.ui.close(PANE);
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

async function classify($: any, text: string): Promise<Advice> {
  if (Date.now() < pausedUntil) return { features: null, error: 'paused for a minute after 3 failures', latencyMs: null };
  if (inFlight) return { features: null, error: 'the previous request is still running', latencyMs: null };
  const account = options.cloudflare_account_id || (await $.env.get('CLOUDFLARE_ACCOUNT_ID'));
  const endpoint = endpointOf(account);
  if ('error' in endpoint) return { features: null, error: endpoint.error, latencyMs: null };
  const key = await secretFor($, endpoint);
  if (endpoint.keyRequired && !key) return { features: null, error: `missing ${endpoint.key}`, latencyMs: null };
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
  const f = advice.features;
  const decision = decide({
    state: policy,
    distribution: f ? tierDistribution(f, { preference, allowFable: options.allow_fable === true }) : null,
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
  journal = append(journal, recordOf({ at: Date.now(), mode, decision, features: f, usedPercent, latencyMs, error }));
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

const HELP = 'Commands: /router (pane) | on | watch | route | off | pin <tier> | log [n] | tune | status';

function modeText(): string {
  return `Routing is ${mode === 'route' ? 'on' : mode === 'watch' ? 'in watch mode (picks shown, nothing changed)' : 'off'}.`;
}

function statusText(): string {
  const s = snapshot();
  const usage = usageText(s.windows);
  return [
    `${bandText(s)}${usage ? ` · ${usage}` : ''}`,
    `Mode: ${mode}${paused ? ' (paused for this session)' : ''}. Decision model: ${s.label} (${backendOf(overrides.backend ?? options.backend)}). Preference: ${s.preference}. Fable: ${s.fable ? 'allowed' : 'off'}.`,
    lastError ? `Last decision model error: ${lastError}` : '',
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
      return `${when}  ${r.mode.padEnd(5)} ${r.tier.padEnd(6)} ${r.reason.padEnd(14)} ${what}${r.outcome === 'ok' ? '' : `  [${r.outcome}]`}`;
    })
    .join('\n');
}

function tuneText(records: JournalRecord[]): string {
  const t = tune(records);
  const share = Object.entries(t.tierShare)
    .map(([tier, s]) => `${tier} ${Math.round((s ?? 0) * 100)}%`)
    .join(', ');
  return [
    `Decisions: ${t.decisions}. Tier mix: ${share || 'none'}.`,
    `Corrected upward: ${Math.round(t.upRate * 100)}%. Corrected downward: ${Math.round(t.downRate * 100)}%.`,
    `Decision model: median ${t.latencyMedianMs ?? '-'} ms, errors ${Math.round(t.errorRate * 100)}%.`,
    tuneAdvice(t.suggestion, t.decisions),
  ].join('\n');
}
