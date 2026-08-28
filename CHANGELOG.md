# Changelog

## Unreleased

- **The install-time `url.parse()` deprecation warning is traced to its source.** It is
  VS Code's own: after a VSIX installs, its CLI queries the Marketplace for the
  extension's metadata over an HTTP client that still calls `url.parse()`. The README now
  carries the captured stack, the control (a VSIX containing nothing but a `package.json`
  prints the same warning), the fact that it is unfixed in 1.136.0-insider, and two ways
  to not see it. Nothing in this repository is on that stack, and nothing here can
  suppress it.
- **Releasing from the Actions tab no longer leaves `package.json` behind.** The manual
  path stamped the release version onto the build with `npm version --no-git-tag-version`,
  which by design does not commit, so every release published from that button left the
  committed version where it was — `0.2.0` for six releases, then `0.3.3` while 0.4.0
  shipped. **Run workflow** now takes `patch`/`minor`/`major` instead of a tag to type:
  CI bumps `package.json`, commits it, tags that commit, and pushes both before packaging.
- A release whose tag disagrees with `package.json` now fails the build instead of
  publishing a VSIX named after something that was never committed.
- `package.json` bumped to `0.4.0`, catching it up with the released tag.

## 0.4.0

- **`package.json` is back in sync with what has shipped.** It read `0.2.0` across six
  releases; release builds stamp the tag over it, so published VSIXs were named
  correctly and the drift went unnoticed. Brought back in line, and the release docs now
  state the tag rule (`v` + the exact `package.json` version) and why the manual
  workflow path is what let the two drift apart.
- Release tags without the conventional `v` prefix now trigger the release job instead
  of silently building nothing.
- Documentation only: the `url.parse()` deprecation warning `code --install-extension`
  prints is VS Code's own, with upstream issues cited and a way to silence it, and the
  install snippets no longer name a version that goes stale.

## 0.3.2

- Release builds take their version from the release tag instead of `package.json`, so
  a published VSIX is no longer named after whatever version happened to be committed.
  No change to the extension itself.

## 0.3.0 / 0.3.1

Identical builds — 0.3.1 re-ran the release on the same commit.

- **The rate-limit meters back off instead of hammering a throttled endpoint.** A 429
  from `api/oauth/usage` used to get retried on the same fixed cadence forever, which
  kept the endpoint saturated instead of letting it recover — worse the more windows or
  workspaces you had open against the same account. A run of failures now backs off
  exponentially (capped at 30 minutes) and honours the server's `Retry-After` when it
  sends one.

## 0.2.1 / 0.2.2

Identical builds — 0.2.2 re-ran the release on the same commit. Documentation only: the
manual release path, and a first note about the `url.parse()` deprecation warning.

## 0.2.0

- **The 5-hour and 7-day meters now work.** They were reading `rate_limits` from Claude
  Code's status line payload, which no released version has ever sent, so both meters
  were permanently empty. They now come from `api/oauth/usage` — the same source as
  Claude Code's own `/usage` view — read with the login already stored on this machine.
  `claudeMonitor.rateLimits.source` chooses the source or turns the lookup off, and
  `claudeMonitor.rateLimits.refreshSeconds` sets the cadence.
- **The context meter no longer assumes a 200K window.** Transcripts record the model
  name with the 1M marker stripped, so a 1M session read as 200K and the percentage came
  out roughly five times too high. The size now comes from the model: the `[1m]` marker
  first, then the window Claude Code gives that family (Opus and Fable 1M; Sonnet and
  Haiku 200K, since Claude Code runs Sonnet at 200K unless its 1M variant is picked),
  then a session already past 200K tokens. `claudeMonitor.contextWindowSize` overrides
  all of it, and the tooltip names whichever rule fired.
- Context token counts now match Claude Code's own reading: output tokens are excluded,
  and a bridge snapshot reports the tokens currently in the window rather than every
  input token the session has ever sent.
- The meters no longer go stale, or fall back to the setup prompt, just because the
  bridge is absent — the usage endpoint and the transcript keep them live on their own.
- New **Claude Monitor: Show Diagnostics** command reporting each source's state, and
  tooltips that say why a blank meter is blank.

## 0.1.0

- Status bar meters for the 5-hour session limit, 7-day weekly limit and context window.
- The context meter prints its live token count alongside the percentage, configurable
  via `claudeMonitor.contextDisplay`.
- Status line bridge that snapshots Claude Code's own usage JSON, chaining through to any
  previously configured status line command.
- Warning and critical thresholds with per-meter colouring, optional background
  highlighting, and one-shot notifications on threshold crossings.
- Transcript-based context estimation until the bridge reports for the first time.
- Details quick pick, rich tooltip, and connect/disconnect commands.
