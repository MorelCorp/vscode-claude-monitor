# Changelog

## 0.1.0

- Status bar meters for the 5-hour session limit, 7-day weekly limit and context window.
- Status line bridge that snapshots Claude Code's own usage JSON, chaining through to any
  previously configured status line command.
- Warning and critical thresholds with per-meter colouring, optional background
  highlighting, and one-shot notifications on threshold crossings.
- Transcript-based context estimation until the bridge reports for the first time.
- Details quick pick, rich tooltip, and connect/disconnect commands.
