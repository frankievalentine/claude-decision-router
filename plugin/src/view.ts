// What the router draws: the band above the prompt and the pane. Pure: it takes Claude Code's element functions, a
// snapshot of the router, and the actions buttons call, and returns element trees.
//
// The look is claude-router's (MIT, Alexei Ledenev): signal bars lit up to the tier, a tier pill, the activity in
// orange italic, the route, the reason with its arrow, the evidence against the bar, and readings, separated by dots.
// Plan usage stands where claude-router shows dollars. Controls live in the quick menu (/router, or Router options on the band)
// and the pane, not in a row revealed on hover.

import { mostLikely } from './features.ts';
import type { JournalRecord } from './journal.ts';
import { tune } from './journal.ts';
import { settingLabel } from './settings.ts';
import { rank, sameModel, TIER_NAMES, TIERS, tierOfModel } from './tiers.ts';
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
  /** Claude Code's advisor, by name, and the strongest tier it applies to; null without one. */
  advisor?: { name: string; cap: Tier } | null;
  /** The model the API reported answering this turn's latest reply, and the one the request asked for; null until then. */
  answered?: { model: string; asked: string } | null;
};

export type Actions = {
  setMode: (mode: Mode) => void;
  resume: () => void;
  pin: (tier: Tier | null) => void;
  open: () => void;
  close: () => void;
  tab: (tab: PaneTab) => void;
  toggleDetail: () => void;
  setFable: (allow: boolean) => void;
  /** The quick menu: mode, pin, details. */
  menu: () => void;
};

export type PaneTab = 'now' | 'log' | 'tune';
type El = any;
type Elements = { Box: (p: any) => El; Text: (p: any) => El; Button: (p: any) => El; Svg?: (p: any) => El };

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
// Space the band keeps for the trailing Router options button.
const ROUTER_BUTTON = 16;

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
  'advisor-cap': '↓ advisor',
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
  'advisor-cap': 'kept at or below the advisor, so the advisor still applies',
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

/**
 * Whether the reply came from the model the request asked for, by the API's own report: 'confirmed', 'mismatch', or
 * null before a reply. In watch mode the band shows a pick that did not run, so there is nothing of it to confirm.
 */
export function answerState(s: Snapshot): 'confirmed' | 'mismatch' | null {
  if (s.mode !== 'route' || !s.answered) return null;
  return sameModel(s.answered.model, s.answered.asked) ? 'confirmed' : 'mismatch';
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
  const answer = answerState(s);
  return [
    `${decision.tier}${verb ? ` ${ACTIVITY_VERB[verb]} →` : ''} ${route ? routeLabel(route) : modelName(s.nativeModel)}${answer === 'confirmed' ? ' ✓' : ''}`,
    answer === 'mismatch' ? `answered by ${modelName(s.answered?.model)}` : null,
    s.mode === 'watch' ? 'watch only' : null,
    reasonText(decision),
    supportText(s.label, decision),
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(pinned);
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
      advisorSegment(s),
      ...readings(s),
    ].filter(Boolean) as Segment[];

  const { decision, route, features } = s.current;
  const verb = topActivity(features)[0]?.[0];
  const answer = answerState(s);
  const main = segment(
    0,
    [...meter(decision.tier), pill(decision.tier, TIER_COLOR[decision.tier]), part(' ')],
    verb ? { ...part(`${ACTIVITY_VERB[verb]} → `, { color: COLOR.activity, italic: true }), priority: 2 } : null,
    part(route ? routeLabel(route) : modelName(s.nativeModel)),
    answer === 'confirmed' ? part(' ✓', { color: 'green' }) : null,
  );
  // A reply from another model than the one asked for is a fault too, and leads: where the band is narrow, the model
  // that answered stays and the one asked for drops, so the band never claims a model that did not run.
  const mismatch =
    answer === 'mismatch' ? segment(0, part(`⚠ answered by ${modelName(s.answered?.model)}`, { color: COLOR.warn })) : null;
  const lead = mismatch ? [mismatch, { ...main, priority: 1 }] : [main];
  // A fault leads: what to fix matters more than the model kept.
  if (s.error && decision.reason === 'no-advice')
    return [
      segment(0, part(`⚠ ${s.label}: ${s.error}`, { color: COLOR.warn })),
      segment(2, button({ key: 'band-fix', label: 'Status', onPress: a.open })),
      { ...main, priority: 1 },
      mismatch && { ...mismatch, priority: 1 },
      pin,
      segment(3, part('keeping model', { color: COLOR.warn })),
    ].filter(Boolean) as Segment[];
  const support = supportText(s.label, decision);
  return [
    ...lead,
    watching,
    pin,
    segment(1, part(reasonText(decision), { dimColor: true })),
    segment(5, part(preferenceText(s), { dimColor: true })),
    advisorSegment(s),
    support ? segment(4, part(support, { dimColor: true })) : null,
    ...readings(s),
  ].filter(Boolean) as Segment[];
}

const advisorSegment = (s: Snapshot) => (s.advisor ? segment(4, part(`advisor ${s.advisor.name}`, { dimColor: true })) : null);

// The Priority setting by the label the settings show it under.
const preferenceText = (s: Snapshot) => `${settingLabel('preference', s.preference)}${s.preference === 'balanced' ? ' (default)' : ''}`;

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
  line.push(part('  '), button({ key: 'details', label: 'Router options', plain: true, onPress: a.menu }));
  return el.Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [row(line), s.detail && s.mode !== 'off' ? row(sessionRow(s, columns)) : null].filter(Boolean),
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

/** Below this many columns the pane stacks each label above its value. */
const NARROW = 56;
/** Below this many columns a Log entry takes two lines. */
const LOG_WIDE = 90;

/**
 * The pane. `graphical` is for the surfaces that draw `Svg` (the desktop app, VS Code, mobile): they get a layout of
 * their own; the terminal keeps the text one.
 */
export function renderPane(el: Elements, s: Snapshot, tab: PaneTab, a: Actions, columns = 60, graphical = false): El {
  const Svg = graphical ? el.Svg : undefined;
  const narrow = columns < NARROW;
  const barWidth = Math.max(6, Math.min(BLOCK, columns - 30));
  const t = (children: string, style: Style = {}) => el.Text({ ...style, children });
  // A row of text: a long text shrinks and wraps inside its own cell, so it stays under its column.
  const line = (...children: (El | null | false)[]) => el.Box({ flexDirection: 'row', children: children.filter(Boolean) });
  // A row of buttons, which cannot shrink: they wrap onto the next line instead of running past the pane.
  const wrapRow = (...children: (El | null | false)[]) =>
    el.Box({ flexDirection: 'row', flexWrap: 'wrap', children: children.filter(Boolean) });
  // Section headings: the terminal's in capitals and color, the graphical surfaces' in plain bold sentence case.
  const head = (text: string) =>
    Svg ? t(text.charAt(0) + text.slice(1).toLowerCase(), { weight: 'bold' }) : t(text, { weight: 'bold', color: COLOR.head });
  // A tier's share: on one padded line with block characters in the terminal; elsewhere the name and share above a
  // drawn bar, since a proportional font cannot pad a column.
  const shareRow = (x: Tier, share: number) => {
    const name = t(Svg ? x : `  ${x.padEnd(8)}`, { weight: 'bold', color: TIER_COLOR[x] });
    if (!Svg) return line(name, t(blocks(share, barWidth), { color: TIER_COLOR[x] }), t(`  ${pct(share, 100)}`, { tabular: true }));
    const width = Math.max(160, Math.min(320, columns * 7));
    return el.Box({
      flexDirection: 'column',
      gap: 'xs',
      children: [
        el.Box({ flexDirection: 'row', justifyContent: 'space-between', children: [name, t(pct(share, 100), { tabular: true })] }),
        Svg({ source: barSvg(share, TIER_COLOR[x], width), alt: `${x} ${pct(share, 100)}`, width, height: 6 }),
      ],
    });
  };
  const dim = (text: string) => t(text, { dimColor: true });
  const gap = () => t(' ');
  const on = s.mode !== 'off' && !s.paused;
  const radio = (key: string, label: string, active: boolean, onPress: () => void) =>
    el.Button({ key, label: `${active ? '◉' : '○'} ${label}`, variant: active ? 'primary' : 'secondary', onPress });
  const status = s.error
    ? t(`${s.label}: ${s.error}`, { color: COLOR.warn })
    : t(`${s.label} ready${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}`, { color: 'green' });
  const tabs = (['now', 'log', 'tune'] as const).map((id) =>
    el.Button({
      key: `tab-${id}`,
      label: id === 'now' ? 'Now' : id === 'log' ? 'Log' : 'Tune',
      variant: tab === id ? 'primary' : 'secondary',
      onPress: () => a.tab(id),
    }),
  );
  if (Svg) return panel(Svg);

  const header = [
    wrapRow(
      head('ROUTING'),
      gap(),
      radio('mode-route', 'Switch models', on && s.mode === 'route', () => (s.paused ? a.resume() : a.setMode('route'))),
      gap(),
      radio('mode-watch', 'Watch only', on && s.mode === 'watch', () => a.setMode('watch')),
      gap(),
      radio('mode-off', 'Off', !on, () => a.setMode('off')),
    ),
    status,
    wrapRow(...tabs.flatMap((b, i) => [i ? gap() : null, b])),
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

  // A labeled row: the label beside its value where there is room, above it where there is not. The value is its own
  // cell, so a long one wraps inside its column instead of running back under the label; one made of buttons wraps
  // between them.
  function fieldOf(wrap: boolean, name: string, children: (El | null | false)[]): El {
    const value = el.Box({ flexDirection: 'row', flexShrink: 1, ...(wrap ? { flexWrap: 'wrap' } : {}), children: children.filter(Boolean) });
    if (!narrow) return el.Box({ flexDirection: 'row', children: [label(name), value] });
    return el.Box({
      flexDirection: 'column',
      children: [name ? dim(name) : null, el.Box({ flexDirection: 'row', children: [t('  '), value] })].filter(Boolean),
    });
  }
  function field(name: string, ...children: (El | null | false)[]): El {
    return fieldOf(false, name, children);
  }
  function buttons(name: string, ...children: (El | null | false)[]): El {
    return fieldOf(true, name, children);
  }

  function nowTab(): El[] {
    const rows: El[] = [];
    const cur = s.current;
    if (!cur) {
      rows.push(field('Next turn', dim(s.paused ? 'paused: model picked by hand' : 'waiting for the first prompt')));
    } else {
      const { decision, route, features } = cur;
      rows.push(
        field(
          s.mode === 'watch' ? 'Would use' : 'Next turn',
          t('▌', { color: TIER_COLOR[decision.tier] }),
          t(decision.tier, { weight: 'bold', color: TIER_COLOR[decision.tier] }),
          t('  '),
          t(route ? routeLabel(route) : modelName(s.nativeModel), { weight: 'bold' }),
        ),
      );
      const answer = answerState(s);
      if (s.answered)
        rows.push(
          field(
            'Answered by',
            t(modelName(s.answered.model), { weight: 'bold', ...(answer === 'mismatch' ? { color: COLOR.warn } : {}) }),
            answer === 'confirmed' ? t(' ✓', { color: 'green' }) : null,
            dim(
              answer === 'mismatch'
                ? ` · not the ${modelName(s.answered.asked)} asked for: Claude Code can change models itself, as when one is overloaded`
                : ' · as reported by the API',
            ),
          ),
        );
      else if (s.mode === 'route') rows.push(field('Answered by', dim('no reply reported yet')));
      const acts = topActivity(features);
      if (acts.length)
        rows.push(
          field(
            'Activity',
            t(ACTIVITY_VERB[acts[0][0]], { color: COLOR.activity, italic: true }),
            t(` ${pct(acts[0][1], 100)}`),
            acts.length > 1 ? dim(`   ${acts.slice(1, 3).map(([k, p]) => `${ACTIVITY_VERB[k]} ${pct(p, 100)}`).join(' · ')}`) : null,
          ),
        );
      rows.push(field('Why', t(LONG_REASON[decision.reason] ?? decision.reason)));
      const support = typeof decision.bar === 'number' && typeof decision.mass === 'number';
      if (support)
        rows.push(
          field(
            '',
            dim(
              `${s.label} gave ${pct(decision.mass, 100)} (needs ${pct(decision.bar, 100)})${
                features ? ` · confidence ${features.confidence.toFixed(2)}` : ''
              }`,
            ),
          ),
        );
    }
    rows.push(field('Mode', t(`${MODE_LABEL[s.mode]}${s.paused ? ' (paused)' : ''} · ${preferenceText(s)} · Fable ${s.fable ? 'allowed' : 'off'}`)));
    if (s.advisor) rows.push(field('Advisor', t(`${s.advisor.name} · routes up to ${s.advisor.cap}`)));
    rows.push(
      buttons(
        'Band',
        el.Button({
          key: 'band-detail',
          label: s.detail ? 'Session row: on' : 'Session row: off',
          variant: s.detail ? 'primary' : 'secondary',
          onPress: a.toggleDetail,
        }),
        dim('  turns and switches'),
      ),
    );
    rows.push(
      buttons(
        'Fable',
        el.Button({ key: 'fable', label: s.fable ? 'Fable: allowed' : 'Fable: off', variant: s.fable ? 'primary' : 'secondary', onPress: () => a.setFable(!s.fable) }),
        dim('  hardest tasks; may use extra credits'),
      ),
    );
    const dist = cur?.decision.distribution ?? null;
    if (on)
      rows.push(
        buttons(
          'Pin next',
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
      rows.push(line(t('  '), ...sum.strip.slice(-Math.max(8, columns - 4)).map((x) => t('█', { color: TIER_COLOR[x] }))));
      rows.push(
        wrapRow(
          t('  '),
          ...TIERS.filter((x) => sum.counts[x]).map((x) => line(t('■ ', { color: TIER_COLOR[x] }), t(`${x} ${sum.counts[x]}   `))),
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
          t(blocks(value === null ? null : value / 100, barWidth), { color: level(value, 50, 75) }),
          t(`  ${value === null ? 'not reported yet' : pct(value)}`, { tabular: true }),
        ),
      );
    }

    rows.push(t(' '));
    rows.push(
      field(
        'Context',
        t(blocks(s.contextPercent === null ? null : s.contextPercent / 100, barWidth), { color: level(s.contextPercent) }),
        t(`  ${s.contextPercent === null ? '?' : pct(s.contextPercent)}`, { tabular: true }),
      ),
    );
    rows.push(
      field(
        'Cache',
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
        const outcome = r.outcome === 'ok' ? null : t(`  [${r.outcome}]`, { color: COLOR.warn });
        const reason = SHORT_REASON[r.reason] ?? r.reason;
        const leaned = r.lean && r.lean !== r.tier ? t(`  leaned ${r.lean}`, { color: TIER_COLOR[r.lean] }) : null;
        // Watching, the session's own model runs and the tier is only the pick; routing, a different model is a fault.
        const ran =
          r.answered && tierOfModel(r.answered) !== r.tier
            ? t(`  ran ${modelName(r.answered)}`, r.mode === 'route' ? { color: COLOR.warn } : { dimColor: true })
            : null;
        // Where the pane is wide the entry is one line; narrower, the detail drops to a second line under the tier.
        if (columns >= LOG_WIDE)
          return line(dim(`${when}  `), t(r.tier.padEnd(7), { weight: 'bold', color: TIER_COLOR[r.tier] }), dim(reason.padEnd(16)), what, leaned, ran, outcome);
        return el.Box({
          flexDirection: 'column',
          children: [
            line(dim(`${when}  `), t(r.tier, { weight: 'bold', color: TIER_COLOR[r.tier] }), dim(`  ${reason}`), leaned, ran, outcome),
            line(t('  '), el.Box({ flexDirection: 'row', flexShrink: 1, children: [what] })),
          ],
        });
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
          shareRow(x, share),
        );
    }
    if (u.leaned) {
      rows.push(t(' '));
      rows.push(line(dim(`  The decision model leaned, before the confidence filter (${u.leaned}):`)));
      for (const x of TIERS) {
        const share = u.leanShare[x] ?? 0;
        if (share > 0)
          rows.push(
            shareRow(x, share),
          );
      }
    }
    rows.push(t(' '));
    rows.push(t(tuneAdvice(u.suggestion, u.decisions)));
    return rows;
  }

  // The desktop app, VS Code and mobile: cards with real type sizes, drawn bars and tags, and no padded columns,
  // which a proportional font cannot line up. Status leads, then what this turn ran on, the one-turn pin, the session
  // and the settings. Plan usage and context fill are left out: the desktop app shows both itself.
  function panel(Svg: (p: any) => El): El {
    const width = Math.max(160, Math.min(320, columns * 7));
    const column = (gap: string, ...children: (El | null | false)[]) =>
      el.Box({ flexDirection: 'column', gap, children: children.filter(Boolean) });
    const row = (...children: (El | null | false)[]) =>
      el.Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'sm', children: children.filter(Boolean) });
    const spread = (left: El, right: El | null) =>
      el.Box({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 'sm', children: [left, right].filter(Boolean) });
    const caption = (text: string, style: Style = {}) => t(text, { size: 'caption', dimColor: true, ...style });
    const card = (title: string, aside: El | null, ...children: (El | null | false)[]) =>
      el.Box({
        flexDirection: 'column',
        gap: 'sm',
        borderStyle: 'round',
        borderDimColor: true,
        padding: 'md',
        children: [spread(t(title, { weight: 'semibold' }), aside), ...children.filter(Boolean)],
      });
    const tag = (tier: Tier) => t(` ${TIER_NAMES[tier]} `, { backgroundColor: TIER_COLOR[tier], color: COLOR.ink, weight: 'semibold' });
    const dot = (color: string) => t('●', { color });
    const stat = (value: string, name: string) => column('xs', t(value, { size: 'title', weight: 'semibold', tabular: true }), caption(name));
    const body = tab === 'log' ? logCards() : tab === 'tune' ? tuneCards() : nowCards();
    return column(
      'md',
      statusCard(),
      tabBar(),
      ...body,
      el.Box({ flexDirection: 'row', justifyContent: 'flex-end', children: [el.Button({ key: 'close', label: 'Close', role: 'dismiss', onPress: a.close })] }),
    );

    // A tab bar, so the three read as views of one panel rather than as actions: plain labels on a divider, the open
    // one in the accent color with a bar under it.
    function tabBar(): El {
      const names = { now: 'Overview', log: 'History', tune: 'Tuning' } as const;
      return column(
        'xs',
        el.Box({
          flexDirection: 'row',
          gap: 'lg',
          children: (['now', 'log', 'tune'] as const).map((id) => {
            const open = tab === id;
            const name = names[id];
            return el.Box({
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'xs',
              children: [
                el.Button({
                  key: `tab-${id}`,
                  plain: true,
                  label: name,
                  onPress: () => a.tab(id),
                  children: [t(name, open ? { weight: 'semibold', color: COLOR.accent } : { dimColor: true })],
                }),
                Svg({ source: ruleSvg(name.length * 8, open ? COLOR.accent : null, 2), alt: open ? `${name}, open` : name, width: name.length * 8, height: 2 }),
              ],
            });
          }),
        }),
        Svg({ source: ruleSvg(width, '#8b93a7', 1, 0.3), alt: '', width, height: 1 }),
      );
    }

    function statusCard(): El {
      const what =
        s.mode === 'off'
          ? `Off: every message uses ${modelName(s.nativeModel)}`
          : s.paused
            ? 'Paused: you picked a model with /model'
            : s.mode === 'route'
              ? 'On: switching models for you'
              : 'Watching: picks are shown, nothing changes';
      return card(
        'Status',
        null,
        row(dot(on && s.mode === 'route' ? 'green' : on ? COLOR.accent : COLOR.muted), t(what)),
        row(
          dot(s.error ? COLOR.warn : 'green'),
          s.error ? t(`${s.label}: ${s.error}`, { color: COLOR.warn }) : t(`${s.label} ready`),
          !s.error && s.latencyMs !== null ? caption(`${s.latencyMs} ms`) : null,
        ),
        row(
          el.Button({ key: 'mode-route', label: 'Switch models', variant: on && s.mode === 'route' ? 'primary' : 'secondary', onPress: () => (s.paused ? a.resume() : a.setMode('route')) }),
          el.Button({ key: 'mode-watch', label: 'Watch only', variant: on && s.mode === 'watch' ? 'primary' : 'secondary', onPress: () => a.setMode('watch') }),
          el.Button({ key: 'mode-off', label: 'Off', variant: on ? 'secondary' : 'primary', onPress: () => a.setMode('off') }),
        ),
      );
    }

    function nowCards(): El[] {
      const out: El[] = [];
      const cur = s.current;
      const answer = answerState(s);
      if (!cur) out.push(card('This turn', null, caption(s.paused ? 'Paused: the model is picked by hand.' : 'Waiting for your first message.')));
      else {
        const { decision, route, features } = cur;
        const verb = topActivity(features)[0]?.[0];
        const support = typeof decision.bar === 'number' && typeof decision.mass === 'number';
        const why = LONG_REASON[decision.reason] ?? decision.reason;
        out.push(
          card(
            s.mode === 'watch' ? 'Would use' : 'This turn',
            answer === 'confirmed' ? t('✓ Answered', { size: 'caption', color: 'green', weight: 'semibold' }) : null,
            row(
              tag(decision.tier),
              t(route ? modelName(route.model) : modelName(s.nativeModel), { size: 'heading', weight: 'semibold' }),
              route ? caption(`${route.effort.charAt(0).toUpperCase()}${route.effort.slice(1)} effort`) : null,
            ),
            t(`${why.charAt(0).toUpperCase()}${why.slice(1)}.`),
            verb || support
              ? caption(
                  [
                    verb ? `${ACTIVITY_VERB[verb].charAt(0).toUpperCase()}${ACTIVITY_VERB[verb].slice(1)}` : null,
                    support ? `${s.label} ${pct(decision.mass, 100)} sure, needs ${pct(decision.bar, 100)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
              : null,
            answer === 'mismatch'
              ? column(
                  'xs',
                  t(`⚠ Answered by ${modelName(s.answered?.model)}`, { color: COLOR.warn, weight: 'semibold' }),
                  caption('Claude Code can change models itself, as when one is overloaded.'),
                )
              : null,
          ),
        );
      }
      const dist = cur?.decision.distribution ?? null;
      if (on)
        out.push(
          card(
            'Pin the next turn',
            null,
            caption('Runs your next message on this model, once.'),
            row(
              ...TIERS.filter((x) => x !== 'fable' || s.fable).map((x) => {
                const p = dist?.[x];
                const chosen = s.pin === x;
                return el.Button({
                  key: `pin-${x}`,
                  label: `${chosen ? '✓ ' : ''}${TIER_NAMES[x]}${typeof p === 'number' ? ` · ${pct(p, 100)}` : ''}`,
                  variant: chosen ? 'primary' : 'secondary',
                  onPress: () => a.pin(chosen ? null : x),
                });
              }),
            ),
          ),
        );
      const sum = sessionSummary(s);
      const since = sum.since ? new Date(sum.since).toTimeString().slice(0, 5) : null;
      out.push(
        card(
          'This session',
          since ? caption(`since ${since}`) : null,
          sum.turns ? Svg({ source: stripSvg(sum.strip, width), alt: `${sum.turns} routed turns`, width, height: 10 }) : caption('No routed turns yet.'),
          sum.turns
            ? row(...TIERS.filter((x) => sum.counts[x]).flatMap((x) => [dot(TIER_COLOR[x]), caption(`${TIER_NAMES[x]} ${sum.counts[x]}`, { dimColor: false })]))
            : null,
          el.Box({
            flexDirection: 'row',
            gap: 'lg',
            children: [
              stat(String(sum.turns), sum.turns === 1 ? 'turn' : 'turns'),
              stat(String(sum.switches), sum.switches === 1 ? 'switch' : 'switches'),
              stat(s.cacheHit === null ? '–' : pct(s.cacheHit, 100), 'cache reuse'),
            ],
          }),
          sum.corrections ? t(`${sum.corrections} corrected by you (/model or escalation)`, { color: COLOR.warn }) : null,
        ),
      );
      out.push(
        card(
          'Settings',
          null,
          spread(t('Priority'), t(preferenceText(s), { weight: 'semibold' })),
          spread(
            column('xs', t('Fable for the hardest tasks'), caption('May use extra usage credits.')),
            el.Button({ key: 'fable', label: s.fable ? 'On' : 'Off', variant: s.fable ? 'primary' : 'secondary', onPress: () => a.setFable(!s.fable) }),
          ),
          s.advisor ? spread(t('Advisor'), t(`${s.advisor.name}, routes up to ${TIER_NAMES[s.advisor.cap]}`, { weight: 'semibold' })) : null,
          spread(
            t('Session row on the band'),
            el.Button({ key: 'band-detail', label: s.detail ? 'On' : 'Off', variant: s.detail ? 'primary' : 'secondary', onPress: a.toggleDetail }),
          ),
          caption("Priority and the decision model are changed in the plugin's settings."),
        ),
      );
      return out;
    }

    function logCards(): El[] {
      const records = s.journal.slice(-15).reverse();
      if (!records.length) return [card('Recent decisions', null, caption('No decisions yet.'))];
      return [
        card(
          'Recent decisions',
          caption('newest first'),
          ...records.map((r) => {
            const when = new Date(r.at).toTimeString().slice(0, 5);
            const detail = r.error
              ? t(`Error: ${r.error}`, { size: 'caption', color: COLOR.warn })
              : caption(
                  [
                    r.activity ? ACTIVITY_VERB[r.activity as Activity] ?? r.activity : null,
                    r.difficulty !== null ? `difficulty ${r.difficulty}` : null,
                    r.confidence !== null ? `confidence ${r.confidence}` : null,
                    r.lean && r.lean !== r.tier ? `leaned ${TIER_NAMES[r.lean]}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                );
            const ran = r.answered && tierOfModel(r.answered) !== r.tier;
            return column(
              'xs',
              row(
                caption(when, { tabular: true }),
                tag(r.tier),
                t(LONG_REASON[r.reason] ? `${LONG_REASON[r.reason].charAt(0).toUpperCase()}${LONG_REASON[r.reason].slice(1)}` : r.reason),
              ),
              detail,
              ran ? t(`Ran ${modelName(r.answered)}`, { size: 'caption', ...(r.mode === 'route' ? { color: COLOR.warn } : { dimColor: true }) }) : null,
              r.outcome === 'ok' ? null : t(OUTCOME[r.outcome], { size: 'caption', color: COLOR.warn }),
            );
          }),
        ),
      ];
    }

    function tuneCards(): El[] {
      const u = tune(s.journal);
      const share = (x: Tier, value: number) =>
        column('xs', spread(row(dot(TIER_COLOR[x]), t(TIER_NAMES[x])), t(pct(value, 100), { tabular: true })), Svg({ source: barSvg(value, TIER_COLOR[x], width), alt: `${TIER_NAMES[x]} ${pct(value, 100)}`, width, height: 6 }));
      return [
        card(
          'Corrections',
          caption(`${u.decisions} decision${u.decisions === 1 ? '' : 's'}`),
          el.Box({
            flexDirection: 'row',
            gap: 'lg',
            children: [stat(pct(u.upRate, 100), 'corrected up'), stat(pct(u.downRate, 100), 'corrected down'), stat(pct(u.errorRate, 100), 'errors')],
          }),
          caption(`${s.label} answers in ${u.latencyMedianMs ?? '–'} ms, the median.`),
          t(tuneAdvice(u.suggestion, u.decisions)),
        ),
        card('Models picked', null, ...TIERS.filter((x) => (u.tierShare[x] ?? 0) > 0).map((x) => share(x, u.tierShare[x] ?? 0))),
        u.leaned
          ? card(
              'Where the decision model leaned',
              caption(`${u.leaned} decisions`),
              caption('Before the confidence filter, the hold and the plan caps.'),
              ...TIERS.filter((x) => (u.leanShare[x] ?? 0) > 0).map((x) => share(x, u.leanShare[x] ?? 0)),
            )
          : null,
      ].filter(Boolean) as El[];
    }
  }
}

const OUTCOME: Record<string, string> = {
  'override-up': 'You moved it to a stronger model',
  'override-down': 'You moved it to a lighter model',
  escalated: 'Moved up after tool errors',
};

const MODE_LABEL: Record<Mode, string> = { route: 'Switch models', watch: 'Watch only', off: 'Off' };

// A rounded track with the filled part over it, in SVG for the graphical surfaces. The track is a translucent gray
// that reads on a light or a dark background.
function barSvg(fraction: number | null, color: string, width: number): string {
  const fill = fraction === null ? 0 : Math.max(0, Math.min(1, fraction)) * width;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="#8b93a7" fill-opacity="0.25"/>` +
    (fill > 0 ? `<rect width="${Math.max(6, fill).toFixed(1)}" height="6" rx="3" fill="${color}"/>` : '') +
    '</svg>'
  );
}

// A horizontal line: a tab's underline, or the divider under the tabs. No color draws nothing, keeping the space.
function ruleSvg(width: number, color: string | null, height: number, opacity = 1): string {
  const line = color ? `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${color}" fill-opacity="${opacity}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${line}</svg>`;
}

// One slim block per routed turn in its tier's color, oldest first.
function stripSvg(strip: Tier[], width: number): string {
  const step = width / Math.max(strip.length, 12);
  const cells = strip
    .map((tier, i) => `<rect x="${(i * step).toFixed(1)}" width="${Math.max(1, step - 2).toFixed(1)}" height="10" rx="2" fill="${TIER_COLOR[tier]}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">${cells}</svg>`;
}

export function tuneAdvice(suggestion: 'raise' | 'lower' | 'keep', decisions: number): string {
  if (decisions < 20) return 'Not enough decisions yet to suggest a change (20 needed).';
  if (suggestion === 'raise') return 'You correct it upward more often: set Priority to Best answers.';
  if (suggestion === 'lower') return 'You correct it downward more often: set Priority to Save usage.';
  return 'Corrections are balanced: keep the current settings.';
}

// --- The quick menu ---

/** One step of the quick menu: a question and its 2-4 options, each with what choosing it does. */
export type MenuStep = { question: string; options: { label: string; then: MenuChoice }[] };
export type MenuChoice =
  | { kind: 'mode'; mode: Mode }
  | { kind: 'resume' }
  | { kind: 'pin-menu' }
  | { kind: 'pin'; tier: Tier | null }
  | { kind: 'details' };

/** The first step, by state: what can change from here. */
export function mainMenu(s: Snapshot): MenuStep {
  if (s.mode === 'off' || s.paused)
    return {
      question: `Routing is ${s.paused ? 'paused' : 'off'}. Turn it on?`,
      options: [
        { label: 'Route: switch models', then: { kind: 'mode', mode: 'route' } },
        { label: 'Watch: show picks only', then: { kind: 'mode', mode: 'watch' } },
        { label: 'Status and settings', then: { kind: 'details' } },
      ],
    };
  return {
    question: `Routing is ${s.mode === 'route' ? 'on' : 'watching'}. What would you like to change?`,
    options: [
      s.mode === 'route'
        ? { label: 'Watch: show picks only', then: { kind: 'mode', mode: 'watch' } }
        : { label: 'Route: switch models', then: { kind: 'mode', mode: 'route' } },
      { label: s.pin ? `Pin next turn (now ${s.pin})` : 'Pin next turn', then: { kind: 'pin-menu' } },
      { label: 'Turn off', then: { kind: 'mode', mode: 'off' } },
      { label: 'Status and settings', then: { kind: 'details' } },
    ],
  };
}

/** The pin step: the tiers, and a way to cancel a pin already set. At most four options. */
export function pinMenu(s: Snapshot): MenuStep {
  const tiers = TIERS.filter((t) => t !== 'fable' || s.fable).filter((t) => t !== s.pin);
  const options: MenuStep['options'] = [
    ...(s.pin ? [{ label: `Cancel the ${s.pin} pin`, then: { kind: 'pin', tier: null } as MenuChoice }] : []),
    ...tiers.map((t) => ({ label: t, then: { kind: 'pin', tier: t } as MenuChoice })),
  ].slice(0, 4);
  return { question: 'Which model should the next turn run on?', options };
}

/** What an answer means: an option's label, or text typed under "Other" that names one. */
export function choiceOf(step: MenuStep, answer: string): MenuChoice | null {
  const typed = answer.trim().toLowerCase();
  const hit = step.options.find((o) => o.label === answer) ?? step.options.find((o) => o.label.toLowerCase().startsWith(typed) && typed.length > 1);
  return hit ? hit.then : null;
}
