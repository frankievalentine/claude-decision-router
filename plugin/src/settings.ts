// The settings' pickers as people see them and as the code reads them. A picker saves the label it shows, so the code
// turns each label into its internal value at the boundary. Versions before 0.12 saved the internal value, which the
// pickers no longer list: `upgradeSettings` shows each as its label to whoever reads the settings, so the saved choice
// still stands. Pure: every input is an argument.

import type { Backend, Mode, Preference } from './types.ts';

export const LABELS = {
  mode: { watch: 'Watch only', route: 'Switch models', off: 'Off' } as Record<Mode, string>,
  preference: { cost: 'Save usage', balanced: 'Balanced', quality: 'Best answers' } as Record<Preference, string>,
  backend: {
    'clef-workers': 'Cloudflare Workers AI',
    'jev-api': 'TypeSafe',
    local: 'Unsloth or SGLang server',
    llamacpp: 'llama.cpp server',
  } as Record<Backend, string>,
};

export type PickerField = keyof typeof LABELS;
const FIELDS = Object.keys(LABELS) as PickerField[];

// Backend names saved by versions before 0.6.
const OLDER_BACKENDS: Record<string, Backend> = { 'clef-local': 'local', 'jev-local': 'local' };

/** The internal value a saved setting names, whether it is a label or an earlier version's value; else undefined. */
export function valueOf(field: PickerField, saved: unknown): string | undefined {
  if (typeof saved !== 'string') return undefined;
  const labels: Record<string, string> = LABELS[field];
  const byLabel = Object.keys(labels).find((value) => labels[value] === saved);
  if (byLabel) return byLabel;
  if (saved in labels) return saved;
  return field === 'backend' ? OLDER_BACKENDS[saved] : undefined;
}

/** The label a picker shows and saves for an internal value. */
export function settingLabel(field: PickerField, value: string): string {
  return (LABELS[field] as Record<string, string>)[value] ?? value;
}

/** The options with each picker's label turned into its internal value, which is what the rest of the plugin reads. */
export function resolveOptions<T extends Record<string, unknown>>(options: T): T {
  const out: Record<string, unknown> = { ...options };
  for (const field of FIELDS) {
    const value = valueOf(field, options[field]);
    if (value === undefined) delete out[field];
    else out[field] = value;
  }
  return out as T;
}

/** Each picker's saved choice, as its internal value: a label or an earlier version's value both count. */
export function savedChoices(saved: Record<string, unknown> | undefined): Partial<Record<PickerField, string>> {
  const out: Partial<Record<PickerField, string>> = {};
  for (const field of FIELDS) {
    const value = valueOf(field, saved?.[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** This plugin's entry in settings.json's `pluginConfigs`, under whichever marketplace installed it. */
export function ownConfig(settings: unknown): Record<string, unknown> | undefined {
  const configs = (settings as { pluginConfigs?: Record<string, { options?: Record<string, unknown> }> })?.pluginConfigs;
  if (!configs || typeof configs !== 'object') return undefined;
  return Object.entries(configs).find(([id]) => id.split('@')[0] === 'decision-router')?.[1]?.options;
}

/**
 * The settings with this plugin's pickers saved by an earlier version shown as their labels; the same object when
 * there is nothing to change, so a reader that compares sees no change.
 */
export function upgradeSettings<T>(settings: T): T {
  const configs = (settings as { pluginConfigs?: Record<string, { options?: Record<string, unknown> }> })?.pluginConfigs;
  if (!configs || typeof configs !== 'object') return settings;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(configs)) {
    const saved = entry?.options;
    if (id.split('@')[0] !== 'decision-router' || !saved) {
      next[id] = entry;
      continue;
    }
    const options = { ...saved };
    for (const field of FIELDS) {
      const value = valueOf(field, saved[field]);
      if (value !== undefined && saved[field] !== settingLabel(field, value)) {
        options[field] = settingLabel(field, value);
        changed = true;
      }
    }
    next[id] = { ...entry, options };
  }
  return changed ? ({ ...settings, pluginConfigs: next } as T) : settings;
}
