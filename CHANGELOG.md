# Changelog

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
