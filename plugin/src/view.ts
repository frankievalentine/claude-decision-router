// What the router draws: the band above the prompt and the pane. Pure: it takes Claude Code's element functions, a
// snapshot of the router, and the actions buttons call, and returns element trees.
//
// The look is claude-router's (MIT, Alexei Ledenev): signal bars lit up to the tier, a tier pill, the activity in
// orange italic, the route, the reason with its arrow, the evidence against the bar, and readings, separated by dots;
// pins and the mode control in a row revealed on hover. Plan usage stands where claude-router shows dollars.

import { mostLikely } from './features.ts';
import type { JournalRecord } from './journal.ts';
import { tune } from './journal.ts';
import { rank, TIERS } from './tiers.ts';
import type { Activity, Decision, Features, Mode, Route, Tier } from './types.ts';

export type Snapshot = {
  mode: Mode;
  paused: boolean;
  choosing: boolean;
  pin: Tier | null;
  current: { decision: Decision; route: Route | null; features: Features | null } | null;
  windows: { fiveHour: number | null; sevenDay: number | null };
  /** Context window fill, 0-100, or null before the first reading. */
  contextPercent: number | null;
  /** Share of the last request's input read from the prompt cache, 0-1, or null. */
  cacheHit: number | null;
  journal: JournalRecord[];
  /** When this session started, to tell its records from earlier sessions'. */
  sessionStart: number;
  /** The decision model's name: "Clef Flash", "Jev", "Laya". */
  label: string;
  timeoutMs: number;
  /** The last decision model error, or null when it answered. */
  error: string | null;
  latencyMs: number | null;
  /** The session's own model, which runs when routing is off. */
  nativeModel: string | null;
  preference: string;
  fable: boolean;
  /** The band's second row. */
  detail: boolean;
};

export type Actions = {
  setMode: (mode: Mode) => void;
  resume: () => void;
  pin: (tier: Tier | null) => void;
  open: () => void;
  close: () => void;
  tab: (tab: PaneTab) => void;
  toggleDetail: () => void;
};

export type PaneTab = 'now' | 'log' | 'tune';
type El = any;
type Elements = { Box: (p: any) => El; Text: (p: any) => El; Button: (p: any) => El };

// Hex, so every surface draws the same shades. Yellow stays out of the tiers: it marks a fault that needs action.
export const TIER_COLOR: Record<Tier, string> = { haiku: '#5f9fe0', sonnet: '#d7af5f', opus: '#e0708a', fable: '#c792ea' };
const COLOR = {
  accent: '#7c9cff',
  off: '#2a3040',
  muted: '#8b93a7',
  warn: '#f0b429',
  ink: '#0d1016',
  activity: '#d77757',
  head: 'cyan',
};
const BARS = '▂▄▆█';
const SEPARATOR = '  ·  ';
const GAP = '  ';
// Space the band keeps for the trailing Router button.
const ROUTER_BUTTON = 8;

const ACTIVITY_VERB: Record<Activity, string> = {
  code: 'coding',
  debug: 'debugging',
  explore: 'exploring',
  plan: 'planning',
  review: 'reviewing',
  ops: 'running',
  docs: 'documenting',
};

const SHORT_REASON: Record<string, string> = {
  first: '• first pick',
  stay: '= fits',
  upgrade: '↑ upgrade',
  jump: '↑ jump',
  downgrade: '↓ downgrade',
  hold: '= holding',
  'same-task': '= same task',
  'low-confidence': '= unsure',
  'no-advice': '= no advice',
  escalation: '↑ tool errors',
  'usage-cap': '↓ plan usage',
  pinned: '⏵ pinned',
};
const LONG_REASON: Record<string, string> = {
  first: 'first pick of the session',
  stay: 'the current model fits',
  upgrade: 'clear need for a stronger model',
  jump: 'a much harder task: skipped a tier',
  downgrade: 'a lighter task: a cheaper model is enough',
  hold: 'holding after an escalation',
  'same-task': 'same task: no cheaper move mid-task',
  'low-confidence': 'the decision model was unsure, so the model stays',
  'no-advice': 'no answer from the decision model, so the model stays',
  escalation: 'repeated tool errors moved it up',
  'usage-cap': 'plan usage is high: capped to a cheaper tier',
  pinned: 'pinned for this turn',
};

// --- Words ---

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelName(id: string | null | undefined): string {
  if (!id) return 'your model';
  return id
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-([0-9])-([0-9])(-\d{8})?$/, ' $1.$2')
    .replace(/^./, (c) => c.toUpperCase());
}
export const routeLabel = (r: Route) => `${modelName(r.model)} · ${r.effort}`;
const pct = (x: number | null | undefined, scale = 1) =>
  typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * scale)}%` : '?';

/** The move's reason; a stay that fell short of its bar says which way it was waiting to go. */
export function reasonText(d: Decision): string {
  if (d.reason === 'stay' && d.distribution && typeof d.bar === 'number' && typeof d.mass === 'number' && d.mass < d.bar) {
    return rank(mostLikely(d.distribution)) > rank(d.tier) ? '… waiting to go up' : '… waiting to go down';
  }
  return SHORT_REASON[d.reason] ?? d.reason;
}

/** "Clef 88% ≥ 82%": what the decision model gave against what the move needed. */
export function supportText(label: string, d: Decision): string | null {
  if (typeof d.bar !== 'number' || typeof d.mass !== 'number') return null;
  return `${label} ${pct(d.mass, 100)} ${d.mass >= d.bar ? '≥' : '<'} ${pct(d.bar, 100)}`;
}

function topActivity(f: Features | null): [Activity, number][] {
  if (!f) return [];
  return (Object.entries(f.activity) as [Activity, number][]).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
}

export function usageText(w: Snapshot['windows']): string {
  const parts = [];
  if (w.fiveHour !== null) parts.push(`5h ${pct(w.fiveHour)}`);
  if (w.sevenDay !== null) parts.push(`7d ${pct(w.sevenDay)}`);
  return parts.join(' · ');
}

/** A plain-text summary of the band, for /router status and the debug log. */
export function bandText(s: Snapshot): string {
  if (s.mode === 'off') return `Routing off · every turn uses ${modelName(s.nativeModel)}`;
  if (s.paused) return `Routing paused · every turn uses ${modelName(s.nativeModel)} (/model)`;
  if (s.choosing) return 'choosing for this turn…';
  const pinned = s.pin ? ` · next turn: ${s.pin}` : '';
  if (!s.current) return `${s.mode === 'watch' ? 'Watching' : 'Routing on'} · ready${pinned}`;
  const { decision, route, features } = s.current;
  const verb = topActivity(features)[0]?.[0];
  return [
    `${decision.tier}${verb ? ` ${ACTIVITY_VERB[verb]} →` : ''} ${route ? routeLabel(route) : modelName(s.nativeModel)}`,
    s.mode === 'watch' ? 'watch only' : null,
    reasonText(decision),
    supportText(s.label, decision),
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(pinned);
}

/** The label Claude Code shows in the prompt footer, or null for nothing. */
export function footerLabel(s: Snapshot): string | null {
  if (s.paused) return 'router paused';
  if (s.mode === 'off') return 'routing off';
  if (s.mode === 'watch') return 'router watching';
  return null;
}

// --- Segments: parts that drop, highest priority first, when the band is narrow ---

type Style = Record<string, unknown>;
type Part = { text?: string; style?: Style; button?: any; priority?: number };
type Segment = { priority: number; parts: Part[] };

const part = (text: string, style: Style = {}): Part => ({ text, style });
// A filled chip: the text on a background. The space after it keeps the background off the next word.
const pill = (text: string, background: string): Part =>
  part(` ${text} `, { backgroundColor: background, color: COLOR.ink, weight: 'bold' });
const button = (props: any): Part => ({ button: props });
const segment = (priority: number, ...parts: (Part | Part[] | null | false)[]): Segment => ({
  priority,
  parts: (parts.flat() as (Part | null | false)[]).filter(Boolean) as Part[],
});
const partWidth = (p: Part) => (p.button ? p.button.label.length + (p.button.plain ? 0 : 4) : (p.text ?? '').length);
const lineWidth = (segments: Segment[], separator: string) =>
  segments.reduce((sum, s, i) => sum + (i ? separator.length : 0) + s.parts.reduce((n, p) => n + partWidth(p), 0), 0);

/**
 * Drops the highest-priority segments and parts, later ones first on a tie, until the line fits `columns`. Priority-0
 * segments never drop; if they alone are too wide, the first is cut with an ellipsis, so the terminal never shrinks
 * and garbles every part of the row.
 */
export function fitSegments(segments: Segment[], columns: number, separator = SEPARATOR): Segment[] {
  const kept = [...segments];
  while (lineWidth(kept, separator) > columns) {
    let drop: { priority: number; i: number; j?: number } | null = null;
    kept.forEach((s, i) => {
      s.parts.forEach((p, j) => {
        if ((p.priority ?? 0) > 0 && (!drop || (p.priority ?? 0) >= drop.priority)) drop = { priority: p.priority ?? 0, i, j };
      });
      if (kept.length > 1 && s.priority > 0 && (!drop || s.priority >= drop.priority)) drop = { priority: s.priority, i };
    });
    const d = drop as { priority: number; i: number; j?: number } | null;
    if (d && d.j !== undefined) kept[d.i] = { ...kept[d.i], parts: kept[d.i].parts.filter((_, j) => j !== d.j) };
    else if (d) kept.splice(d.i, 1);
    else if (kept.length > 1) kept.pop();
    else break;
  }
  const overflow = lineWidth(kept, separator) - columns;
  if (overflow > 0 && kept.length) {
    const parts = [...kept[0].parts];
    let last = -1;
    parts.forEach((p, i) => {
      if (!p.button && (p.text ?? '').length > overflow) last = i;
    });
    if (last >= 0) parts[last] = { ...parts[last], text: `${(parts[last].text ?? '').slice(0, -overflow - 1)}…` };
    kept[0] = { ...kept[0], parts };
  }
  return kept;
}

// Signal bars: lit up to the tier in its color, dim above it or when `tier` is null.
function meter(tier: Tier | null): Part[] {
  const lit = tier ? rank(tier) : -1;
  return [...BARS].map((b, i) => part(b, i <= lit && tier ? { color: TIER_COLOR[tier] } : { dimColor: true }));
}
// The decision model is working: every bar in the accent color.
const pendingMeter = () => [...BARS].map((b) => part(b, { color: COLOR.accent }));

const level = (percent: number | null, warnAt = 60, badAt = 80) =>
  percent === null ? 'gray' : percent > badAt ? 'red' : percent > warnAt ? 'yellow' : 'green';
const reading = (percent: number | null, color: string) => part(percent === null ? '?' : `${Math.round(percent)}%`, { color });

function readings(s: Snapshot): Segment[] {
  const out: Segment[] = [];
  const { fiveHour, sevenDay } = s.windows;
  if (fiveHour !== null || sevenDay !== null)
    out.push(
      segment(
        2,
        part('5h '),
        reading(fiveHour, level(fiveHour, 50, 75)),
        part(' · 7d '),
        reading(sevenDay, level(sevenDay, 50, 75)),
      ),
    );
  if (s.contextPercent !== null || s.cacheHit !== null) {
    const cache = s.cacheHit === null ? null : s.cacheHit * 100;
    out.push(
      segment(
        3,
        part('ctx '),
        reading(s.contextPercent, level(s.contextPercent)),
        part(' · cache hit '),
        reading(cache, cache === null ? 'gray' : cache >= 60 ? 'green' : cache >= 20 ? 'yellow' : 'gray'),
      ),
    );
  }
  return out;
}

export function bandSegments(s: Snapshot, a: Actions): Segment[] {
  // Off or paused: the state and the one way back on lead, and never drop.
  if (s.mode === 'off' || s.paused)
    return [
      segment(
        0,
        part('○ ', { dimColor: true }),
        { ...part('Routing '), priority: 1 },
        part(s.paused ? 'paused' : 'off', { backgroundColor: COLOR.off, color: COLOR.muted }),
        part(' '),
        s.paused
          ? button({ key: 'band-resume', label: 'Turn on', variant: 'primary', onPress: a.resume })
          : button({ key: 'band-on', label: 'Turn on', variant: 'primary', onPress: () => a.setMode('watch') }),
      ),
      segment(
        1,
        { ...part('every turn uses '), priority: 3 },
        part(modelName(s.nativeModel)),
        s.paused ? { ...part(' (/model)', { dimColor: true }), priority: 2 } : null,
      ),
      ...readings(s),
    ];
  if (s.choosing)
    return [
      segment(0, pendingMeter(), part(' choosing for this turn…', { dimColor: true })),
      segment(3, part(`${s.label} · ${s.timeoutMs / 1000} s deadline`, { dimColor: true })),
    ];
  const pin = s.pin
    ? segment(
        0,
        part('⏵ next turn: ', { color: COLOR.accent }),
        part(s.pin, { weight: 'bold', color: TIER_COLOR[s.pin] }),
        part(' '),
        button({ key: 'band-unpin', label: '✕', plain: true, onPress: () => a.pin(null) }),
      )
    : null;
  const watching = s.mode === 'watch' ? segment(1, part('watch only', { color: COLOR.accent })) : null;
  if (!s.current)
    return [
      segment(0, meter(null), part(` ${s.mode === 'watch' ? 'Watching' : 'Routing on'} · ready`, { dimColor: true })),
      pin,
      segment(5, part(preferenceText(s), { dimColor: true })),
      ...readings(s),
    ].filter(Boolean) as Segment[];

  const { decision, route, features } = s.current;
  const verb = topActivity(features)[0]?.[0];
  const main = segment(
    0,
    [...meter(decision.tier), pill(decision.tier, TIER_COLOR[decision.tier]), part(' ')],
    verb ? { ...part(`${ACTIVITY_VERB[verb]} → `, { color: COLOR.activity, italic: true }), priority: 2 } : null,
    part(route ? routeLabel(route) : modelName(s.nativeModel)),
  );
  // A fault leads: what to fix matters more than the model kept.
  if (s.error && decision.reason === 'no-advice')
    return [
      segment(0, part(`⚠ ${s.label}: ${s.error}`, { color: COLOR.warn })),
      segment(2, button({ key: 'band-fix', label: 'Details', onPress: a.open })),
      { ...main, priority: 1 },
      pin,
      segment(3, part('keeping model', { color: COLOR.warn })),
    ].filter(Boolean) as Segment[];
  const support = supportText(s.label, decision);
  return [
    main,
    watching,
    pin,
    segment(1, part(reasonText(decision), { dimColor: true })),
    segment(5, part(preferenceText(s), { dimColor: true })),
    support ? segment(4, part(support, { dimColor: true })) : null,
    ...readings(s),
  ].filter(Boolean) as Segment[];
}

const preferenceText = (s: Snapshot) => `${s.preference}${s.preference === 'balanced' ? ' (default)' : ''}`;

// The row revealed under the pointer: pins and the mode control, and the one- or two-row choice. No digit hotkeys,
// since a bare digit in an empty prompt would press them.
function hoverSegments(s: Snapshot, a: Actions): Segment[] {
  const on = s.mode !== 'off' && !s.paused;
  const tiers = TIERS.filter((t) => t !== 'fable' || s.fable);
  const pins = tiers.flatMap((t, i) => [
    i ? part(' ') : null,
    button({ key: `band-pin-${t}`, label: t, onPress: () => a.pin(t) }),
  ]).filter(Boolean) as Part[];
  return [
    on ? segment(1, { ...part('pin next turn ', { dimColor: true }), priority: 2 }, pins) : null,
    on
      ? segment(
          0,
          { ...part(s.mode === 'route' ? 'routing on ' : 'watching ', { dimColor: true }), priority: 4 },
          s.mode === 'watch' ? button({ key: 'band-route', label: 'Route', onPress: () => a.setMode('route') }) : null,
          s.mode === 'watch' ? part(' ') : null,
          button({ key: 'band-off', label: 'Turn off', onPress: () => a.setMode('off') }),
        )
      : null,
    segment(s.detail ? 0 : 3, button({ key: 'band-detail', label: s.detail ? '1 row' : '2 rows', onPress: a.toggleDetail })),
  ].filter(Boolean) as Segment[];
}

// --- Session summary, for the band's second row and the pane ---

export type SessionSummary = {
  turns: number;
  counts: Partial<Record<Tier, number>>;
  switches: number;
  corrections: number;
  since: number | null;
  strip: Tier[];
  lastSwitch: { at: number; from: Tier; to: Tier } | null;
};

export function sessionSummary(s: Snapshot): SessionSummary {
  const records = s.journal.filter((r) => r.at >= s.sessionStart && !r.error);
  const counts: Partial<Record<Tier, number>> = {};
  let switches = 0;
  let lastSwitch: SessionSummary['lastSwitch'] = null;
  records.forEach((r, i) => {
    counts[r.tier] = (counts[r.tier] ?? 0) + 1;
    const prev = records[i - 1];
    if (prev && prev.tier !== r.tier) {
      switches += 1;
      lastSwitch = { at: r.at, from: prev.tier, to: r.tier };
    }
  });
  return {
    turns: records.length,
    counts,
    switches,
    corrections: records.filter((r) => r.outcome !== 'ok').length,
    since: records[0]?.at ?? null,
    strip: records.slice(-40).map((r) => r.tier),
    lastSwitch,
  };
}

function sessionRow(s: Snapshot, columns: number): Part[] {
  const sum = sessionSummary(s);
  const label = part('session  ', { dimColor: true });
  if (!sum.turns) return [label, part('no routed turns yet', { dimColor: true })];
  const tiers = TIERS.filter((t) => sum.counts[t]).flatMap((t) => [
    part('■ ', { color: TIER_COLOR[t] }),
    part(`${t} ${sum.counts[t]}  `),
  ]);
  const segs = [
    segment(0, label, part(`${sum.turns} turn${sum.turns === 1 ? '' : 's'}  `, { weight: 'bold' }), tiers),
    segment(1, part(`${sum.switches} switch${sum.switches === 1 ? '' : 'es'}`, { dimColor: true })),
    sum.corrections ? segment(2, part(`${sum.corrections} corrected`, { color: COLOR.warn })) : null,
    segment(3, part(s.mode === 'watch' ? 'watch only: nothing applied' : `${s.label} · ${s.latencyMs ?? '-'} ms`, { dimColor: true })),
  ].filter(Boolean) as Segment[];
  return fitSegments(segs, columns).flatMap((seg, i) => (i ? [part(SEPARATOR, { dimColor: true }), ...seg.parts] : seg.parts));
}

// --- Drawing ---

function draw(el: Elements, p: Part): El {
  return p.button ? el.Button(p.button) : el.Text({ ...p.style, children: p.text });
}

export function renderBand(el: Elements, s: Snapshot, a: Actions, columns = 120): El {
  const row = (parts: Part[]) => el.Box({ children: parts.map((p) => draw(el, p)) });
  const kept = fitSegments(bandSegments(s, a), Math.max(0, columns - ROUTER_BUTTON));
  const line = kept.flatMap((seg, i) => (i ? [part(SEPARATOR, { dimColor: true }), ...seg.parts] : seg.parts));
  line.push(part('  '), button({ key: 'details', label: 'Router', plain: true, onPress: a.open }));
  const hover = fitSegments(hoverSegments(s, a), columns, GAP);
  return el.Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      row(line),
      s.detail && s.mode !== 'off' ? row(sessionRow(s, columns)) : null,
      el.Box({
        display: 'none',
        hover: { display: 'flex' },
        children: hover.flatMap((seg, i) => (i ? [part(GAP), ...seg.parts] : seg.parts)).map((p) => draw(el, p)),
      }),
    ].filter(Boolean),
  });
}

/** "Model changed: Haiku 5.5 · medium → Opus 5.5 · xhigh · ↑ jump (Clef 92% ≥ 75%)". */
export function switchToast(label: string, before: Route, after: Route, d: Decision): string {
  const support = supportText(label, d);
  const why = reasonText(d).replace(/^\W+\s*/, '');
  return `Model changed: ${routeLabel(before)} → ${routeLabel(after)} · ${why}${support ? ` (${support})` : ''}`;
}

// --- The pane ---

const BLOCK = 16;
function blocks(fraction: number | null, width = BLOCK): string {
  if (fraction === null || !Number.isFinite(fraction)) return '░'.repeat(width);
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

export function renderPane(el: Elements, s: Snapshot, tab: PaneTab, a: Actions): El {
  const t = (children: string, style: Style = {}) => el.Text({ ...style, children });
  const line = (...children: (El | null | false)[]) => el.Box({ flexDirection: 'row', children: children.filter(Boolean) });
  const head = (text: string) => t(text, { weight: 'bold', color: COLOR.head });
  const dim = (text: string) => t(text, { dimColor: true });
  const gap = () => t(' ');
  const on = s.mode !== 'off' && !s.paused;
  const radio = (key: string, label: string, active: boolean, onPress: () => void) =>
    el.Button({ key, label: `${active ? '◉' : '○'} ${label}`, variant: active ? 'primary' : 'secondary', onPress });
  const status = s.error
    ? t(`${s.label}: ${s.error}`, { color: COLOR.warn })
    : t(`${s.label} ready${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}`, { color: 'green' });

  const header = [
    line(
      head('ROUTING'),
      gap(),
      radio('mode-route', 'on', on && s.mode === 'route', () => (s.paused ? a.resume() : a.setMode('route'))),
      gap(),
      radio('mode-watch', 'watch', on && s.mode === 'watch', () => a.setMode('watch')),
      gap(),
      radio('mode-off', 'off', !on, () => a.setMode('off')),
      gap(),
      status,
    ),
    line(
      ...(['now', 'log', 'tune'] as const).flatMap((id, i) => [
        i ? gap() : null,
        el.Button({
          key: `tab-${id}`,
          label: id === 'now' ? 'Now' : id === 'log' ? 'Log' : 'Tune',
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => a.tab(id),
        }),
      ]),
    ),
    t(' '),
  ];
  const body = tab === 'log' ? logTab() : tab === 'tune' ? tuneTab() : nowTab();
  return el.Box({
    flexDirection: 'column',
    children: [
      ...header,
      ...body,
      t(' '),
      el.Button({ key: 'close', label: 'Close', role: 'dismiss', onPress: a.close }),
    ],
  });

  function label(text: string) {
    return t(text.padEnd(11));
  }

  function nowTab(): El[] {
    const rows: El[] = [];
    const cur = s.current;
    if (!cur) {
      rows.push(line(label('Next turn'), dim(s.paused ? 'paused: model picked by hand' : 'waiting for the first prompt')));
    } else {
      const { decision, route, features } = cur;
      rows.push(
        line(
          label(s.mode === 'watch' ? 'Would use' : 'Next turn'),
          t('▌', { color: TIER_COLOR[decision.tier] }),
          t(decision.tier, { weight: 'bold', color: TIER_COLOR[decision.tier] }),
          t('  '),
          t(route ? routeLabel(route) : modelName(s.nativeModel), { weight: 'bold' }),
        ),
      );
      const acts = topActivity(features);
      if (acts.length)
        rows.push(
          line(
            label('Activity'),
            t(ACTIVITY_VERB[acts[0][0]], { color: COLOR.activity, italic: true }),
            t(` ${pct(acts[0][1], 100)}`),
            acts.length > 1 ? dim(`   ${acts.slice(1, 3).map(([k, p]) => `${ACTIVITY_VERB[k]} ${pct(p, 100)}`).join(' · ')}`) : null,
          ),
        );
      rows.push(line(label('Why'), t(LONG_REASON[decision.reason] ?? decision.reason)));
      const support = typeof decision.bar === 'number' && typeof decision.mass === 'number';
      if (support)
        rows.push(
          line(
            label(''),
            dim(
              `${s.label} gave ${pct(decision.mass, 100)} (needs ${pct(decision.bar, 100)})${
                features ? ` · confidence ${features.confidence.toFixed(2)}` : ''
              }`,
            ),
          ),
        );
    }
    rows.push(line(label('Mode'), t(`${s.mode}${s.paused ? ' (paused)' : ''} · ${preferenceText(s)} · Fable ${s.fable ? 'allowed' : 'off'}`)));
    const dist = cur?.decision.distribution ?? null;
    if (on)
      rows.push(
        line(
          label('Pin next'),
          ...TIERS.filter((x) => x !== 'fable' || s.fable).flatMap((x, i) => {
            const p = dist?.[x];
            const chosen = s.pin === x;
            return [
              i ? gap() : null,
              el.Button({
                key: `pin-${x}`,
                label: `${chosen ? '▶ ' : ''}${x}${typeof p === 'number' ? ` ${pct(p, 100)}` : ''}`,
                variant: chosen ? 'primary' : 'secondary',
                onPress: () => a.pin(chosen ? null : x),
              }),
            ];
          }),
          dim('  next turn only'),
        ),
      );

    rows.push(t(' '));
    const sum = sessionSummary(s);
    const since = sum.since ? new Date(sum.since).toTimeString().slice(0, 5) : null;
    rows.push(
      line(
        head('SESSION'),
        dim(
          sum.turns
            ? ` · since ${since} · ${sum.turns} routed turn${sum.turns === 1 ? '' : 's'} · ${sum.switches} switch${sum.switches === 1 ? '' : 'es'}`
            : ' · no routed turns yet',
        ),
      ),
    );
    if (sum.turns) {
      rows.push(line(t('  '), ...sum.strip.map((x) => t('█', { color: TIER_COLOR[x] }))));
      rows.push(
        line(
          t('  '),
          ...TIERS.filter((x) => sum.counts[x]).flatMap((x) => [t('■ ', { color: TIER_COLOR[x] }), t(`${x} ${sum.counts[x]}   `)]),
        ),
      );
      if (sum.lastSwitch)
        rows.push(
          line(
            dim(`  last switch ${new Date(sum.lastSwitch.at).toTimeString().slice(0, 5)}  `),
            t(sum.lastSwitch.from, { weight: 'bold', color: TIER_COLOR[sum.lastSwitch.from] }),
            dim(' → '),
            t(sum.lastSwitch.to, { weight: 'bold', color: TIER_COLOR[sum.lastSwitch.to] }),
          ),
        );
      if (sum.corrections) rows.push(line(t('  '), t(`${sum.corrections} corrected by you (/model or escalation)`, { color: COLOR.warn })));
    }

    rows.push(t(' '));
    rows.push(line(head('PLAN'), dim(' · the higher window sets the bar for expensive tiers')));
    for (const [name, value] of [
      ['5-hour', s.windows.fiveHour],
      ['Weekly', s.windows.sevenDay],
    ] as const) {
      rows.push(
        line(
          t(`  ${name.padEnd(9)}`),
          t(blocks(value === null ? null : value / 100), { color: level(value, 50, 75) }),
          t(`  ${value === null ? 'not reported yet' : pct(value)}`, { tabular: true }),
        ),
      );
    }

    rows.push(t(' '));
    rows.push(
      line(
        t('Context    '),
        t(blocks(s.contextPercent === null ? null : s.contextPercent / 100), { color: level(s.contextPercent) }),
        t(`  ${s.contextPercent === null ? '?' : pct(s.contextPercent)}`, { tabular: true }),
      ),
    );
    rows.push(
      line(
        t('Cache      '),
        s.cacheHit === null ? dim('no reply yet') : t(`${pct(s.cacheHit, 100)} reused on the last reply`, { color: s.cacheHit >= 0.6 ? 'green' : 'yellow' }),
      ),
    );
    return rows;
  }

  function logTab(): El[] {
    const records = s.journal.slice(-15).reverse();
    if (!records.length) return [dim('No decisions yet.')];
    return [
      line(head('LOG'), dim(' · newest first')),
      ...records.map((r) => {
        const when = new Date(r.at).toTimeString().slice(0, 5);
        const what = r.error
          ? t(`error: ${r.error}`, { color: COLOR.warn })
          : dim(`${r.activity ? ACTIVITY_VERB[r.activity as Activity] ?? r.activity : '-'} · difficulty ${r.difficulty ?? '-'} · confidence ${r.confidence ?? '-'}`);
        return line(
          dim(`${when}  `),
          t(r.tier.padEnd(7), { weight: 'bold', color: TIER_COLOR[r.tier] }),
          dim(`${(SHORT_REASON[r.reason] ?? r.reason).padEnd(16)}`),
          what,
          r.outcome === 'ok' ? null : t(`  [${r.outcome}]`, { color: COLOR.warn }),
        );
      }),
    ];
  }

  function tuneTab(): El[] {
    const u = tune(s.journal);
    const rows: El[] = [
      line(head('TUNE'), dim(` · ${u.decisions} decisions`)),
      line(t(`  corrected up ${pct(u.upRate, 100)} · down ${pct(u.downRate, 100)}`, { tabular: true })),
      line(dim(`  ${s.label}: median ${u.latencyMedianMs ?? '-'} ms · errors ${pct(u.errorRate, 100)}`)),
      t(' '),
    ];
    for (const x of TIERS) {
      const share = u.tierShare[x] ?? 0;
      if (share > 0)
        rows.push(
          line(
            t(`  ${x.padEnd(8)}`, { weight: 'bold', color: TIER_COLOR[x] }),
            t(blocks(share), { color: TIER_COLOR[x] }),
            t(`  ${pct(share, 100)}`, { tabular: true }),
          ),
        );
    }
    rows.push(t(' '));
    rows.push(t(tuneAdvice(u.suggestion, u.decisions)));
    return rows;
  }
}

export function tuneAdvice(suggestion: 'raise' | 'lower' | 'keep', decisions: number): string {
  if (decisions < 20) return 'Not enough decisions yet to suggest a change (20 needed).';
  if (suggestion === 'raise') return 'You correct it upward more often: try preference quality.';
  if (suggestion === 'lower') return 'You correct it downward more often: try preference cost.';
  return 'Corrections are balanced: keep the current settings.';
}
