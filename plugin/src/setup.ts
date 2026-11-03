// The pure parts of /router setup: the backends it offers, where local servers listen by default, and reading what
// someone types as an address or an account ID. The conversation itself lives in hooks/router.ts, where $ is.

import type { Backend } from './types.ts';

export type SetupOption = { label: string; backend: Backend };

/** What the first question offers, in order. Local servers first: they need no key. */
export const SETUP_OPTIONS: readonly SetupOption[] = [
  { label: 'llama.cpp (a server on your machine)', backend: 'llamacpp' },
  { label: 'Unsloth (a server on your machine)', backend: 'local' },
  { label: 'Cloudflare Clef (hosted)', backend: 'clef-workers' },
  { label: 'TypeSafe Jev (hosted)', backend: 'jev-api' },
];

/** The backend an answer to the first question names, or null for text that matches none of the options. */
export function backendOfAnswer(answer: string): Backend | null {
  return SETUP_OPTIONS.find((o) => o.label === answer)?.backend ?? null;
}

/** Where each local server listens unless told otherwise. */
export const DEFAULT_LOCAL_URL = {
  llamacpp: 'http://127.0.0.1:9931',
  local: 'http://127.0.0.1:8888/v1/systemone',
} as const;

/** An address from whatever was typed: "10.0.0.9:9931", "localhost:9931" or a full URL. Null when it is not one. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  return /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/\S*)?$/i.test(url) ? url : null;
}

/** A Cloudflare account ID: 32 hex characters. Null when the text is not one. */
export function accountIdOf(input: string): string | null {
  const text = input.trim();
  return /^[0-9a-f]{32}$/i.test(text) ? text.toLowerCase() : null;
}

/** The request the setup test and /router test send: a realistic prompt, so every question is exercised. */
export const SAMPLE_PROMPT = 'refactor the auth module to use async/await and add tests';

/** Where to put a key the setup never asks for: typed into a dialog it would stay in the scrollback. */
export function keyHelp(backend: Backend): string {
  const [variable, name] =
    backend === 'clef-workers'
      ? ['CLOUDFLARE_API_TOKEN', 'Cloudflare API token']
      : backend === 'jev-api'
        ? ['TYPESAFE_API_KEY', 'TypeSafe API key']
        : ['ROUTER_LOCAL_API_KEY', 'Local server API key'];
  return `No ${name} found. Set ${variable} in your shell, or add it under /plugin > decision-router > Configure options, then run /router test.`;
}
