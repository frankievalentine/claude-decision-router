// Renders the band and the pane to HTML pages, from the same functions the plugin draws with, so the screenshots in
// the README show what the plugin produces rather than a mock-up. Each page holds one `#frame` sized in terminal
// columns (CSS `ch` units), and a script on it counts what draws past the frame's edge.
//
//   bun scripts/render-docs.ts <out dir>        writes <out dir>/*.html and <out dir>/manifest.json
//
// scripts/render-docs.sh takes the screenshots and checks the overflow report.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeFor } from '../src/tiers.ts';
import type { JournalRecord } from '../src/journal.ts';
import type { Actions, PaneTab, Snapshot } from '../src/view.ts';
import { renderBand, renderPane } from '../src/view.ts';
import type { Features, Tier } from '../src/types.ts';

// --- Element functions that return HTML ---

const esc = (x: unknown) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NAMED: Record<string, string> = { cyan: '#4fc1c8', green: '#7bc47f', yellow: '#e5c07b', red: '#e06c75', magenta: '#c678dd', blue: '#61afef' };
const colorOf = (c: unknown) => (typeof c === 'string' ? NAMED[c] ?? c : undefined);
const kids = (c: unknown): string => (Array.isArray(c) ? c.flat(Infinity).map(kids).join('') : c == null || c === false ? '' : String(c));

const el = {
  Box(p: any) {
    if (p.display === 'none') return '';
    const style = [
      'display:flex',
      `flex-direction:${p.flexDirection ?? 'row'}`,
      p.flexWrap ? `flex-wrap:${p.flexWrap}` : '',
      'min-width:0',
    ];
    return `<div style="${style.filter(Boolean).join(';')}">${kids(p.children)}</div>`;
  },
  Text(p: any) {
    const style = [
      'white-space:pre-wrap',
      'min-width:0',
      p.color ? `color:${colorOf(p.color)}` : '',
      p.backgroundColor ? `background:${colorOf(p.backgroundColor)}` : '',
      p.dimColor ? 'opacity:.55' : '',
      p.weight === 'bold' ? 'font-weight:700' : '',
      p.italic ? 'font-style:italic' : '',
      p.underline ? 'text-decoration:underline' : '',
    ];
    return `<span style="${style.filter(Boolean).join(';')}">${esc(kids(p.children))}</span>`;
  },
  Button(p: any) {
    if (p.plain) return `<span style="text-decoration:underline;white-space:pre">${esc(p.label)}</span>`;
    const primary = p.variant === 'primary';
    const style = `white-space:pre;background:${primary ? '#7c9cff' : '#2a3040'};color:${primary ? '#0d1016' : '#cfd6e6'};${primary ? 'font-weight:700' : ''}`;
    return `<span style="${style}">${esc(`[ ${p.label} ]`)}</span>`;
  },
};

// --- A realistic session ---

const ids = { opus: 'claude-opus-5-5' };
const features: Features = {
  difficulty: [0, 0, 0.05, 0.1, 0.85],
  confidence: 0.85,
  reasoning: 2.4,
  scope: { many_files: 1 },
  activity: { code: 0.84, debug: 0.1 },
  security: 0,
  continuation: 0,
};
const route = routeFor('opus', features) ?? { model: ids.opus, effort: 'xhigh' as const };
const decision = {
  tier: 'opus' as Tier,
  reason: 'jump' as const,
  distribution: { haiku: 0, sonnet: 0, opus: 1 },
  bar: 0.82,
  mass: 0.91,
  state: { tier: 'opus' as Tier, votes: ['opus', 'opus'] as Tier[], hold: 0 },
};

const NOW = Date.parse('2026-11-03T19:41:00');
const tiers: Tier[] = ['sonnet', 'haiku', 'sonnet', 'sonnet', 'opus', 'haiku', 'sonnet', 'haiku', 'sonnet', 'opus', 'opus'];
const journal: JournalRecord[] = tiers.map((tier, i) => ({
  at: NOW + i * 60_000,
  mode: 'route',
  tier,
  reason: i === 0 ? 'first' : tier === tiers[i - 1] ? 'stay' : tier === 'opus' ? 'jump' : 'downgrade',
  difficulty: tier === 'opus' ? 3.6 : tier === 'sonnet' ? 2.1 : 0.8,
  confidence: 0.8,
  activity: tier === 'opus' ? 'code' : 'explore',
  usedPercent: 34,
  latencyMs: 300 + i * 12,
  error: null,
  outcome: 'ok',
}));

const base: Snapshot = {
  mode: 'route',
  paused: false,
  choosing: false,
  pin: null,
  current: { decision, route, features },
  windows: { fiveHour: 34, sevenDay: 61 },
  contextPercent: 40,
  cacheHit: 1,
  journal,
  sessionStart: NOW,
  label: 'Laya',
  timeoutMs: 8000,
  error: null,
  latencyMs: 347,
  nativeModel: ids.opus,
  preference: 'balanced',
  fable: false,
  detail: false,
};

const noop = () => {};
const actions: Actions = { setMode: noop, resume: noop, pin: noop, open: noop, close: noop, tab: noop, toggleDetail: noop, menu: noop };

// --- Pages ---

const CSS = `
  html, body { margin: 0; background: #131316; }
  body { padding: 24px; font: 15px/1.45 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: #e6e6ea; display: inline-block; }
  #frame { box-sizing: content-box; }
  .box { background: #1c1c20; padding: 14px 18px; border-radius: 6px; }
  .pane { border: 1px solid #3a4560; border-radius: 6px; padding: 10px 14px; background: #1b1c21; }
  .prompt { border: 1px solid #6b6f7a; border-radius: 4px; padding: 2px 10px; margin-bottom: 6px; }
  .mode { color: #b48ead; }
  .mode i { color: #7a6a85; font-style: normal; }
`;
// What the check counts. Text breaks at spaces only and a Button never breaks, so a row of buttons that does not wrap,
// or a word longer than the frame, draws past the edge and is counted. In the band, which is one line by design, any
// element that wraps is counted too.
const CHECK = `
  const frame = document.getElementById('frame');
  const limit = frame.getBoundingClientRect().right + 0.5;
  const all = [...frame.querySelectorAll('*')];
  const past = all.filter((n) => n.getBoundingClientRect().right > limit).length;
  const line = parseFloat(getComputedStyle(frame).lineHeight);
  const wrapped = document.body.dataset.strict === 'true'
    ? all.filter((n) => n.tagName === 'SPAN' && n.getBoundingClientRect().height > line * 1.6).length
    : 0;
  document.body.dataset.problems = String(past + wrapped);
`;

const page = (inner: string, cols: number, cls: string, strict = false) =>
  `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body data-strict="${strict}"><div id="frame" class="${cls}" style="width:${cols}ch">${inner}</div><script>${CHECK}</script></body>`;

const bandPage = (s: Snapshot, cols: number) =>
  page(
    `<div class="prompt">&gt;</div><div class="mode">⏵⏵ auto mode on <i>(shift+tab to cycle)</i></div>${renderBand(el, s, actions, cols)}`,
    cols,
    'box',
    true,
  );
const panePage = (s: Snapshot, tab: PaneTab, cols: number) => page(renderPane(el, s, tab, actions, cols), cols, 'pane');

const out = process.argv[2];
if (!out) throw new Error('usage: bun scripts/render-docs.ts <out dir>');
mkdirSync(out, { recursive: true });

const manifest: { file: string; columns: number; kind: string; docs?: string }[] = [];
const write = (file: string, html: string, columns: number, kind: string, docs?: string) => {
  writeFileSync(join(out, file), html);
  manifest.push({ file, columns, kind, ...(docs ? { docs } : {}) });
};

// The two images the README shows.
write('band.html', bandPage(base, 118), 118, 'band', 'band.png');
write('pane.html', panePage(base, 'now', 66), 66, 'pane', 'pane.png');

// Overflow checks: the band and every pane tab at widths from a cramped dock to a wide one, in the states that draw
// the most (a long fault, a pin, the session row).
const faulted: Snapshot = {
  ...base,
  error: 'timed out after 8 s at 10.0.0.9:8888',
  pin: 'opus',
  detail: true,
  latencyMs: null,
};
for (const cols of [36, 44, 56, 66, 90, 110]) {
  for (const tab of ['now', 'log', 'tune'] as const) {
    write(`pane-${tab}-${cols}.html`, panePage(base, tab, cols), cols, 'check');
    write(`pane-${tab}-${cols}-fault.html`, panePage(faulted, tab, cols), cols, 'check');
  }
}
for (const cols of [60, 80, 100, 120, 160]) {
  write(`band-${cols}.html`, bandPage(base, cols), cols, 'check');
  write(`band-${cols}-fault.html`, bandPage(faulted, cols), cols, 'check');
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote ${manifest.length} pages to ${out}`);
