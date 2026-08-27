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

Each meter turns amber at its warning threshold and red at its critical threshold.

## Install

Not on the Marketplace yet, so it installs from a `.vsix`.

**Download one:** grab the latest `.vsix` from
[Releases](https://github.com/MorelCorp/vscode-claude-monitor/releases), then:

```sh
code --install-extension claude-usage-monitor-0.1.0.vsix
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
code --install-extension claude-usage-monitor-0.1.0.vsix
```

Then reload VS Code. On first start the extension offers to **connect to Claude Code**;
accept it, or run **Claude Monitor: Connect to Claude Code** from the Command Palette.
Restart any Claude Code sessions that were already open — they keep using the old status
line until they do.

If you prefer clicking: **Extensions** view → `...` menu → **Install from VSIX...**.
For Cursor, Windsurf, or VS Code Insiders substitute the matching CLI
(`cursor --install-extension ...`), or use the same VSIX menu.

To try it without installing, open the repo in VS Code and press <kbd>F5</kbd> for an
Extension Development Host.

## Where the numbers come from

Claude Code pipes a JSON blob into whatever command is configured as its
[`statusLine`](https://code.claude.com/docs/en/statusline). That blob already contains
everything this extension shows:

```json
{
  "context_window": { "total_input_tokens": 150711, "context_window_size": 200000, "used_percentage": 75.4 },
  "rate_limits": {
    "five_hour": { "used_percentage": 42.5, "resets_at": 1787845141 },
    "seven_day": { "used_percentage": 93.1, "resets_at": 1788110881 }
  }
}
```

These are the real percentages Claude Code itself reports — the same ones `/usage` shows —
not an estimate derived from token counting against a guessed plan limit.

So the extension installs a **bridge**: a small `sh` script that snapshots that JSON to
disk and then hands stdin to whatever status line command you already had, so your
terminal status line keeps working unchanged. Run **Claude Monitor: Connect to Claude
Code** (or accept the prompt on first start) to install it.

Connecting writes two things:

- `~/.claude/claude-monitor/bridge.sh` — the script, plus a `state/` directory of snapshots
- the `statusLine` entry of `~/.claude/settings.json`, pointed at that script

`~/.claude/settings.json` is backed up before it is touched, your previous `statusLine`
command is saved to `~/.claude/claude-monitor/chain` and still runs on every repaint, and
**Claude Monitor: Disconnect from Claude Code** puts everything back. Nothing is sent
anywhere; the extension only reads local files.

`CLAUDE_CONFIG_DIR` is honoured if you have set it.

### Caveats

- `rate_limits` is only present for **Claude.ai subscription accounts**, and only after a
  session's first API response. On API-key billing the `Se` and `Wk` meters stay empty and
  the tooltip says so.
- Claude Code sessions that were already running when you connected keep using the old
  status line. Restart them to start reporting.
- Until the bridge reports for the first time, the context meter falls back to reading
  the newest transcript in `~/.claude/projects` and estimating against a 200k window.
  Rate limits are not in the transcript and cannot be estimated. Turn this off with
  `claudeMonitor.transcriptFallback`.
- The 5-hour and 7-day limits are account-wide, so they come from whichever session
  reported most recently. The context window is per-conversation, so it follows a session
  running in *this* workspace (`claudeMonitor.contextSource` relaxes that to any session).

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
| `claudeMonitor.pollIntervalSeconds` | `5` | Re-read interval, on top of file watches |
| `claudeMonitor.promptToConnect` | `true` | Offer to connect on first start |

Meter colours are theme colours (`claudeMonitor.normalForeground`,
`warningForeground`, `criticalForeground`, `contextForeground`, `staleForeground`) and can
be overridden in `workbench.colorCustomizations`.

## Commands

- **Claude Monitor: Show Usage Details** — the full breakdown (also on click)
- **Claude Monitor: Connect to Claude Code** / **Disconnect from Claude Code**
- **Claude Monitor: Refresh Now**
- **Claude Monitor: Open Settings**

## Development

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
