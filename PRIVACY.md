# Privacy notice

Decision Router is a plugin for Claude Code. It runs on your computer, inside Claude Code, and has no servers of its own. This notice explains what it sends, where, and what it keeps.

## What is sent, and where

To choose a model, the plugin asks a decision model to rate each message you send. You choose where that decision model runs, in the plugin's settings.

| Decision model | Where your text goes |
|---|---|
| llama.cpp server | The llama.cpp server at the address you set, usually your own computer or network |
| Unsloth or SGLang server | The server at the address you set, usually your own computer or network |
| Cloudflare Workers AI | Cloudflare, under your own Cloudflare account and its terms |
| TypeSafe | TypeSafe, under your own TypeSafe account and its terms |

Each request contains:

- the message you typed, cut to its first 6,000 characters;
- the last two messages of the conversation, each cut to its first 500 characters, so the decision model can tell a follow-up from a new task;
- the questions the router asks about the task (how hard it is, how much code it touches, and similar).

**Subagents.** If you turn on subagent routing with `/router subagents on` or `/router subagents watch` (both off by default), the task Claude gives each general-purpose subagent is sent too, cut to its first 6,000 characters, without the rest of the conversation. Task text often includes code and project details.

**Fixed requests.** With a server on your own computer or network, the plugin sends a short warm-up request ("warm up") when a session starts, so the server is ready for your first message. `/router setup` and `/router test` send one fixed sample task. Neither contains anything you typed.

Nothing is sent when the router is off, for a message you send without typing text, or for a message where you pinned the model with `/router pin`.

## What the plugin keeps

- **Settings**, in Claude Code's settings. API keys are kept in your system's secure credential store, never in plain text, and are only ever read from the plugin's settings, never from your environment.
- **A decision log** on your computer, in Claude Code's plugin storage: for each message, the model chosen, the reason, the decision model's ratings as numbers, your plan usage and any error. It never contains the text of your messages or tasks.

The plugin has no analytics or telemetry of its own, and sends nothing to its author.

## Third parties

When you choose Cloudflare or TypeSafe, your text is handled under that service's own privacy policy and terms. Claude Code itself, and the Claude models that answer you, are covered by Anthropic's policies.

## Contact

Questions or concerns: open an issue at [github.com/frankievalentine/claude-decision-router/issues](https://github.com/frankievalentine/claude-decision-router/issues).
