# Claude Usage Monitor

Status bar meters for [Claude Code](https://claude.com/claude-code) usage, for Claude.ai
subscription accounts.

```
Claude   Se ●●○○○ ⏱ 20m   Wk ●●●●○ ⏱ 3d 2h   Tk ●●●○○ 151k 75%
```

| Meter | Shows |
|---|---|
| `Se` | 5-hour session limit — % used, and time left in the window |
| `Wk` | 7-day weekly limit — % used, and time left in the window |
| `Tk` | Context window of the Claude Code conversation in this workspace — tokens used and % of the window |

`Tk` prints the live token count next to its bar (`151k 75%`). `claudeMonitor.contextDisplay`
switches it to `151k/200k 75%`, tokens only, percent only, or bar only.

`Se` and `Wk` are read from your account; `Tk` is read from the conversation. Neither
needs the other, so the limits work before the bridge is connected and the context meter
works on an API key.

Each meter turns amber at its warning threshold and red at its critical threshold.

## Install

Not on the Marketplace yet, so it installs from a `.vsix`.

**Download one:** grab the latest `.vsix` from
[Releases](https://github.com/MorelCorp/vscode-claude-monitor/releases), then:

```sh
code --install-extension claude-usage-monitor-0.2.0.vsix
```

Untagged builds are also available: open any run under
[Actions](https://github.com/MorelCorp/vscode-claude-monitor/actions) and download the
`claude-usage-monitor-vsix` artifact (kept ~90 days).

**Or build it:**

```sh
git clone https://github.com/MorelCorp/vscode-claude-monitor.git
cd vscode-claude-monitor
npm install
npm run package        # writes claude-usage-monitor-<version>.vsix
code --install-extension claude-usage-monitor-0.2.0.vsix
```

Then reload VS Code. On first start the extension offers to **connect to Claude Code**;
accept it, or run **Claude Monitor: Connect to Claude Code** from the Command Palette.
Restart any Claude Code sessions that were already open — they keep using the old status
line until they do.

If you prefer clicking: **Extensions** view → `...` menu → **Install from VSIX...**.
For Cursor, Windsurf, or VS Code Insiders substitute the matching CLI
(`cursor --install-extension ...`), or use the same VSIX menu.

> `code --install-extension` may print a `(node:...) [DEP0169] DeprecationWarning:
> url.parse() ...` line after installing. That comes from the `code` CLI's own
> Node runtime, not from this extension — this repo doesn't call `url.parse()`
> anywhere. It's safe to ignore.

To try it without installing, open the repo in VS Code and press <kbd>F5</kbd> for an
Extension Development Host.

## Where the numbers come from

The two kinds of meter have two different sources, because Claude Code exposes them in
two different places.

### 5-hour and 7-day limits

These come from `https://api.anthropic.com/api/oauth/usage`, read with the login Claude
Code already stored on this machine. It is the same request Claude Code's own `/usage`
view makes, and it returns the same numbers:

```json
{
  "five_hour":  { "utilization": 58, "resets_at": "2026-08-27T14:00:00Z" },
  "seven_day":  { "utilization": 14, "resets_at": "2026-08-31T09:00:00Z" }
}
```

The token is read from the macOS Keychain (`Claude Code-credentials`) or
`~/.claude/.credentials.json`, exactly where the CLI keeps it. Nothing is written, no
token is refreshed, and the only host contacted is Anthropic's own API — but it is a
network request, so `claudeMonitor.rateLimits.source: "off"` stops it and the meters go
blank instead.

The status line payload is checked first in case a future Claude Code starts including
`rate_limits`. No released version does, which is why these meters cannot be fed by the
bridge alone.

### Context window

Claude Code pipes a JSON blob into whatever command is configured as its
[`statusLine`](https://code.claude.com/docs/en/statusline), and that blob carries the
exact window:

```json
{
  "context_window": {
    "context_window_size": 1000000,
    "used_percentage": 13,
    "current_usage": { "input_tokens": 12, "cache_read_input_tokens": 129400 }
  }
}
```

So the extension installs a **bridge**: a small `sh` script that snapshots that JSON to
disk and then hands stdin to whatever status line command you already had, so your
terminal status line keeps working unchanged. Run **Claude Monitor: Connect to Claude
Code** (or accept the prompt on first start) to install it.

Connecting writes two things:

- `~/.claude/claude-monitor/bridge.sh` — the script, plus a `state/` directory of snapshots
- the `statusLine` entry of `~/.claude/settings.json`, pointed at that script

`~/.claude/settings.json` is backed up before it is touched, your previous `statusLine`
command is saved to `~/.claude/claude-monitor/chain` and still runs on every repaint, and
**Claude Monitor: Disconnect from Claude Code** puts everything back.

Without the bridge — including in the VS Code Claude extension's own chat panel, which
has no shell status line to run — the context meter reads the newest transcript in
`~/.claude/projects` instead and counts what the next request will carry:
`input + cache_read + cache_creation`, excluding output tokens, matching Claude Code's
own reading.

`CLAUDE_CONFIG_DIR` is honoured throughout.

### Caveats

- **The transcript does not record the window size**, only the model name, and with the
  1M marker stripped — `claude-opus-5`, never `claude-opus-5[1m]`. Without the bridge
  the size comes from the model instead, in this order: the `[1m]` marker on the model
  you configured; the window Claude Code gives that family (Opus and Fable 1M, Sonnet
  and Haiku 200K — Sonnet is a 1M model that Claude Code runs at 200K unless you pick
  its 1M variant, which carries the marker); a session already past 200K tokens, which
  has answered the question itself; otherwise 200K. `claudeMonitor.contextWindowSize`
  overrides the lot, and the tooltip names whichever rule fired.
- The 5-hour and 7-day meters need a **Claude.ai subscription**. On API-key billing there
  are no such limits and the meters stay empty, with the tooltip saying so.
- Claude Code sessions that were already running when you connected the bridge keep using
  the old status line. Restart them to start reporting.
- The limits are account-wide, so they are the same everywhere. The context window is
  per-conversation, so it follows a session running in *this* workspace
  (`claudeMonitor.contextSource` relaxes that to any session).
- **Claude Monitor: Show Diagnostics** prints every source's state — bridge, snapshots,
  window size and why, login location, last endpoint reply — when a meter is blank and
  you want to know which link in the chain is missing.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeMonitor.enabled` | `true` | Show the meters |
| `claudeMonitor.segments` | `["session","week","context"]` | Which meters, in order |
| `claudeMonitor.style` | `dots` | `dots` `blocks` `ascii` `percent` |
| `claudeMonitor.barLength` | `5` | Cells per bar |
| `claudeMonitor.showPercentage` | `false` | Print the number next to the `Se`/`Wk` bars |
| `claudeMonitor.showResetCountdown` | `true` | Show time until each window resets |
| `claudeMonitor.contextDisplay` | `tokens+percent` | `tokens+percent` `tokens-of-limit` `tokens` `percent` `none` |
| `claudeMonitor.showLabel` | `true` | Show the leading `Claude` item |
| `claudeMonitor.warningThreshold` | `70` | Amber at or above this % |
| `claudeMonitor.criticalThreshold` | `90` | Red at or above this % |
| `claudeMonitor.contextWarningThreshold` | `75` | Amber for the context meter |
| `claudeMonitor.contextCriticalThreshold` | `90` | Red for the context meter |
| `claudeMonitor.highlightBackground` | `false` | Also paint the item background when critical |
| `claudeMonitor.notifications` | `critical` | `off` `critical` `warning` — fires once per crossing |
| `claudeMonitor.alignment` | `right` | Which side of the status bar |
| `claudeMonitor.priority` | `100` | Higher sits further left |
| `claudeMonitor.contextSource` | `workspace` | `workspace` or `any` |
| `claudeMonitor.staleAfterMinutes` | `30` | Dim the meters after this much silence |
| `claudeMonitor.hideWhenNoData` | `false` | Hide rather than dim |
| `claudeMonitor.transcriptFallback` | `true` | Estimate context from the transcript |
| `claudeMonitor.contextWindowSize` | `0` | Window size in tokens; `0` works it out |
| `claudeMonitor.rateLimits.source` | `auto` | `auto` `api` `statusLine` `off` |
| `claudeMonitor.rateLimits.refreshSeconds` | `60` | How often to re-read the limits |
| `claudeMonitor.pollIntervalSeconds` | `5` | Re-read interval, on top of file watches |
| `claudeMonitor.promptToConnect` | `true` | Offer to connect on first start |

Meter colours are theme colours (`claudeMonitor.normalForeground`,
`warningForeground`, `criticalForeground`, `contextForeground`, `staleForeground`) and can
be overridden in `workbench.colorCustomizations`.

## Commands

- **Claude Monitor: Show Usage Details** — the full breakdown (also on click)
- **Claude Monitor: Connect to Claude Code** / **Disconnect from Claude Code**
- **Claude Monitor: Refresh Now**
- **Claude Monitor: Show Diagnostics** — why a meter is blank
- **Claude Monitor: Open Settings**

## Development

Built and tested on Node 24, the version CI uses.

```sh
npm install
npm run compile
npm test           # node:test unit tests
npm run package    # build a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Releasing

CI builds and tests every push and attaches the `.vsix` to the run. Pushing a `v*` tag
publishes that same `.vsix` as a release asset:

```sh
npm version patch      # or minor / major — updates package.json and tags
git push --follow-tags
```

## License

MIT
