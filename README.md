# claude-decision-router

A Claude Code plugin that picks the Claude model for each turn, so your subscription goes further without you choosing models by hand.

A small decision model reads each prompt and describes it: how hard, how much code, whether it touches security. A policy that knows your plan's 5-hour and weekly limits turns that into Haiku, Sonnet, Opus or Fable. Run the decision model on your own machine with llama.cpp or Unsloth, or use a hosted one.

![The band under the permission mode](plugin/docs/band.png)

## Install

In Claude Code:

```
/plugin marketplace add frankievalentine/claude-decision-router
/plugin install decision-router@decision-router-local
```

Requires Claude Code 2.1.299 or later.

## Set up

Run `/router setup`. It asks which decision model to use, finds your server (or asks for its address), sends one test request and saves the settings. It never asks for an API key.

| You have | Choose | You need |
|---|---|---|
| llama.cpp | llama.cpp | `llama-server` running a decision model (below) |
| Unsloth | Unsloth | Settings > API > Decision API > Serve requests turned on |
| A Cloudflare account | Cloudflare Clef | Your account ID, and `CLOUDFLARE_API_TOKEN` in your shell |
| A TypeSafe account | TypeSafe Jev | `TYPESAFE_API_KEY` in your shell |

**llama.cpp, in one command.** Download the Q8_0 build of Clef Flash (about 9.5 GB, fits a 16 GB GPU), then:

```
llama-server -m Clef-Flash-Q8_0.gguf --port 9931 -ngl all -c 4096 -b 4096 -ub 4096 -np 1
```

Run `/router setup`, choose **llama.cpp**, and it finds the server on port 9931. For a server on another machine, type its address when asked, for example `10.0.0.9:9931`. What each flag does is in [plugin/README.md](plugin/README.md#clef-or-laya-with-llamacpp).

`/router test` tries the configured decision model again at any time and says what is wrong if it does not answer.

## Use

The router starts in **watch** mode: the band under the prompt shows what it would pick and why, and nothing changes. After a few days, when the picks look right:

```
/router route
```

| Command | What it does |
|---|---|
| `/router` | Quick menu: switch route and watch, pin the next turn, turn off, details |
| `/router setup` | Choose and test a decision model |
| `/router test` | Try the configured decision model once |
| `/router pane` | Details: the current pick, plan usage, the decision log and tuning |
| `/router route`, `watch`, `off` | Change the mode |
| `/router pin opus` | Run the next turn on that model |

![The details pane](plugin/docs/pane.png)

## Updating

Run `claude plugin marketplace update decision-router-local`, then `claude plugin update decision-router@decision-router-local`, then restart Claude Code.

## More

[plugin/README.md](plugin/README.md) covers how a turn runs, the switching policy, every backend in detail (including SGLang), settings and keys, and the source layout.

To work on the plugin: clone the repository and run `claude --plugin-dir ./plugin`, which hot-reloads your edits. In `plugin/`, `claude plugin test` runs the tests, `claude plugin validate .` checks the plugin, and `scripts/render-docs.sh` regenerates the screenshots above and checks that nothing in the band or pane draws past its edge. Bump the version in `plugin/.claude-plugin/plugin.json` with each change you push, because `claude plugin update` compares versions.

## License and credits

MIT, see [plugin/LICENSE](plugin/LICENSE). The switching policy ports ideas from [claude-router](https://github.com/alexei-led/claude-router) by Alexei Ledenev (MIT), and the band and pane follow its design.
