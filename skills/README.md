# Alba skills (backup copy)

Plain-text copies of the Claude skills used with this project, taken 2026-10-14 from the owner's Claude account.
Claude only *uses* a skill when it is installed in the account (or a project / plugin); these files are the
backup and the source of truth you can re-upload from. Nothing here is read by the dashboard itself.

| Folder | What it covers |
|---|---|
| `alba-dashboard-release/` | Restore, change, check and publish the dashboard artifact (v1.171 workflow) |
| `fundamental-research-style/` | Plain-language, bullet-first style for Fundamental Score research text |
| `fundamental-score-csv-refresh-v3/` | Explains / troubleshoots the in-dashboard Fundamental Score import |
| `weekly-growth-list-refresh/` | Older weekly Growth List merge (legacy dashboard file) |
| `tradingview-watchlist-symbol-mapping/` | Syncing the four Alba TradingView watchlists safely |
| `trade-log-tracking/` | Logging real buys / sells with a model snapshot |

To restore: zip a folder (so `SKILL.md` sits inside it) and add it in Claude under Settings > Skills.
If a skill is edited in Claude, copy the new `SKILL.md` back here and commit it, or the two will drift.
