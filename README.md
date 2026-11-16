<img src="plugin/docs/icon.png" alt="Decision Router icon" width="128">

# Decision Router

A Claude Code plugin that picks the Claude model for each turn, and for the subagents Claude starts if you turn that on, so your subscription goes further without you choosing models by hand.

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

Run `/router setup`. It asks which decision model to use, finds your server (or asks for its address), sends one test request and saves the settings. It never asks for an API key in the dialog: keys go in the plugin's settings (`/plugin` > decision-router > Configure options, or Customize > Plugins in the desktop app), which keep them in your system's secure credential store.

| You have | Choose | You need |
|---|---|---|
| llama.cpp | llama.cpp | `llama-server` running a decision model (below) |
| Unsloth | Unsloth | Settings > API > Decision API > Serve requests turned on |
| A Cloudflare account | Cloudflare Clef | Your account ID, and a Workers AI token in the plugin's settings |
| A TypeSafe account | TypeSafe Jev | An API key in the plugin's settings |

**llama.cpp, in one command.** Download the Q8_0 build of Clef Flash (about 9.5 GB, fits a 16 GB GPU), then:

```
llama-server -m Clef-Flash-Q8_0.gguf --port 9931 -ngl all -c 4096 -b 4096 -ub 4096 -np 1
```

`/router test` tries the configured decision model again at any time and says what is wrong if it does not answer.

## How it works

Every time you send a prompt, the router picks a model before Claude answers:

1. **A small decision model reads your prompt.** It describes the task: what kind of work it is, how hard, and whether it touches security. It never picks a model itself.
2. **The router picks the model.** It turns that description into Haiku, Sonnet, Opus or Fable. Easy tasks get a cheaper model, and hard ones get a stronger model.
3. **Claude answers on that model.** A toast tells you when the model changes and why.

The router is careful about switching. It won't flip on one answer, and it holds back when the switch would throw away a long cached conversation. It also uses cheaper models as your 5-hour and weekly limits fill up. If the decision model can't be reached or isn't sure, your current model stays.

**The advisor.** If you use Claude Code's `/advisor`, the router never picks a model stronger than your advisor, since that model would run without it. A turn where Claude already consulted the advisor doesn't also move up a tier after repeated tool errors.

**Subagents.** When Claude hands work to a subagent, that subagent doesn't follow the pick above. It runs on the model you started the session with. Turn on `/router subagents on` and the router picks for subagents too: file searches run on Haiku, general tasks go through the same decision model, and everything else is left alone. A subagent never gets a stronger model than it would have had anyway, so this only moves work to cheaper models.

You stay in control: `/model` pauses the router, and `/router pin opus` sets the next turn's model.

**The desktop app.** The plugin works in the Code tab of the Claude desktop app just as it does in the terminal. Install it from Customize > Plugins (Add marketplace `frankievalentine/claude-decision-router`, then Add plugin) and change its settings there. The band sits above the prompt and appears after the first message of a session. The desktop app doesn't run `/router` commands: use **Router** at the end of the band for the quick menu and **Status and settings**, and the plugin's settings to choose the decision model. The model picker keeps showing your session's model; the band's check mark confirms the model that actually answered.

**Privacy:** your prompt goes to the decision model, and with subagents on, so does each general subagent's task. With llama.cpp or Unsloth it stays on your server, and with Cloudflare or TypeSafe it goes to them. The router's own log never keeps prompt text. The [privacy notice](PRIVACY.md) has the details.

## Use

The router starts in **Watch only** mode: the band under the prompt shows what it would pick and why, and nothing changes. After a few days, when the picks look right:

```
/router route
```

| Command | What it does |
|---|---|
| `/router` | Quick menu: switch route and watch, pin the next turn, turn off, details |
| `/router setup` | Choose and test a decision model |
| `/router test` | Try the configured decision model once |
| `/router pane` | Status and settings: the current pick, plan usage, the decision log and tuning |
| `/router route`, `watch`, `off` | Change the mode |
| `/router pin opus` | Run the next turn on that model |
| `/router subagents on` | Let the router set subagent models too (off by default) |
| `/router subagents` | See what the router did for each subagent |

## Screenshots

### Claude Code (terminal)

The band under the prompt, with the model the router picked and why:

![The band in the terminal, under the permission mode](plugin/docs/band.png)

**Status and settings** (`/router pane`): the current pick, plan usage, the decision log and tuning:

![Status and settings in the terminal](plugin/docs/pane.png)

### Claude desktop app

The band above the prompt in the Code tab, after the first message of a session:

![The band above the prompt in the desktop app](plugin/docs/desktop-band.png)

The quick menu, opened with **Router** at the end of the band:

![The quick menu in the desktop app, opened from the band's Router button](plugin/docs/desktop-menu.png)

## Updating

Run `claude plugin marketplace update decision-router-local`, then `claude plugin update decision-router@decision-router-local`, then restart Claude Code.

## More

[plugin/README.md](plugin/README.md) is the short introduction shown in plugin listings. [The reference](plugin/docs/REFERENCE.md) covers how a turn runs, the switching policy, every backend in detail (including SGLang), every setting, and the source layout.

To work on the plugin: clone the repository and run `claude --plugin-dir ./plugin`, which hot-reloads your edits. In `plugin/`, `claude plugin test` runs the tests, `claude plugin validate .` checks the plugin, and `scripts/render-docs.sh` regenerates the terminal screenshots above (the desktop ones are captures) and checks that nothing in the band or pane draws past its edge. Bump the version in `plugin/.claude-plugin/plugin.json` with each change you push, because `claude plugin update` compares versions.

## License and credits

MIT, see [plugin/LICENSE](plugin/LICENSE). The switching policy ports ideas from [claude-router](https://github.com/alexei-led/claude-router) by Alexei Ledenev (MIT), and the band and pane follow its design.
