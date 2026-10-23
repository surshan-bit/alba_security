---
name: "alba-dashboard-release"
description: "Use when changing, testing or publishing the Alba Securities - Stock Analyzer dashboard artifact (src modules, styles, partials): restore the project, run the checks, then publish."
---

# Alba dashboard: change, check, publish

The dashboard is the claude.ai artifact https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh. Its source is ES modules in `src/` built into `app.js` and hashed `chunks/`. **The source of truth is the GitHub repo `surshan-bit/alba_security` (private), branch `main`.** The artifact is what gets published from it. `README.md` in the repo describes the layout, conventions and what the tests cover. Read it first.

There are three places, and they must not drift apart:
- **Code:** GitHub `surshan-bit/alba_security` (`main`), published to the artifact.
- **Data:** the artifact database, backed up as JSON in the separate private repo `surshan-bit/alba_security_data` (section 6).
- **Skills:** live in the user's Claude account; the code repo keeps a backup copy in `skills/<name>/SKILL.md` (section 7).

**Only one session should change this at a time.** Every artifact publish sends whole files, so a session working from an older copy silently deletes newer work (this happened once: a notification bell published by another session would have been wiped; and the artifact once lacked a test fix that the repo had). Steps 1 and 4d guard against it.

## 1. Restore the project (a fresh session has nothing local)
1. `mcp__claude-code-remote__add_repo` with owner `surshan-bit`, repo `alba_security`, `access: "push"`. Then ONE `git clone --depth 1 https://github.com/surshan-bit/alba_security /home/claude/alba_security` with a long timeout (about 10 minutes), then `register_repo_root`. If the repo is not visible, the user must add it under GitHub > Settings > Applications > Claude > Repository access.
2. `Artifact` action `list`, scope `files`, with the artifact url. **Write down the live version id** the listing shows (for example `1791954686-982c`); this is the base version your publish starts from.
3. Compare what GitHub `main` says it last released (the newest `v1.xxx` heading in `partials/knowledgebase.html` and the badge in `index.html`) with the artifact (`read` its `index.html` and `partials/knowledgebase.html`). **If the artifact is newer or differs, STOP:** something was published without going through the repo. Read the artifact files that differ, merge them into the repo on a branch, and tell the user, before doing anything else.
4. In the repo: `npm ci --silent` (needs the network; versions are pinned in package.json / package-lock.json).

## 2. Change
Work on a branch (`git checkout -b v1.xxx-short-name`), never directly on `main`. Edit the module in `src/` that owns the behaviour (never `app.js`), plus `styles/*.css` (never `styles.css`), `partials/*.html`, `js/loader.js` as needed. Rules (lint enforces them): explicit imports; a module cannot assign another module's variable (shared state lives in the owner behind a getter and a setter or named action, as `core/store.js` does; exporting a `let`/`var` or a function named `set_<name>` is a lint error, see the README); start-up code goes in the module's `init_*` function, called from `src/main.js`; no unused code.

## 3. Check before every publish
`npm run check` in the repo builds app.js, syntax-checks, lints (strict), type-checks against the baseline, runs the engine tests and the regression harness against `tests/golden.json`, and runs the Chromium suites. It must print OK. GitHub CI (`.github/workflows/ci.yml`) runs the same check plus `npm run platform` on every push and pull request; **do not publish while CI is red.**
- If snapshots differ and the change is intended (new wording, layout, behaviour, scores), review the differing names and lines, then `npm run update-golden`. If a difference is NOT intended, fix the code. A snapshot that changes between two runs of unchanged code is a timing flake in the test (make the test wait longer before it, as `tests/run.js` already does); do not just regenerate it.
- To see exactly what changed, run `node tests/run.js <previous project dir> <folder>` on the previous version and diff the folders.
- When adding behaviour, extend `tests/engines.js` (scoring and import logic), `tests/run.js` and `tests/browser.js` so the new path is covered, then update the golden. A scoring fix needs a test that fails on the old code.
- Limits: the harness is jsdom with a stand-in database, TradingView and Claude. It does not run the real runtime or `js/boot.js` data loading. For layout or boot changes also load the page in Chromium (Playwright is installed in this environment at /opt/npm-tools; serve the folder with a static server, stub `window.claude` with a database stand-in, add `[hidden]{display:none!important}` because the claude.ai page skeleton provides it) and look at screenshots.

## 4. Release (do all of these, in order)

### 4a. Bump the version
The sidebar badge tracks product milestones. For any user-visible change:
1. In `index.html` change both the badge text and its title, e.g. `title="Version 1.108 &mdash; tagged 2026-10-12">v1.108` (the next number, today's date).
2. In `partials/knowledgebase.html`, section 9 Version history, add a new `<h3>v1.108 &middot; date</h3>` block with a `<ul>` of plain-language bullets above the previous newest entry (what the user sees, not file names).
3. Update Help (`partials/help.html`) and the Knowledge Base text if a screen, button or label was renamed.
4. Run `npm run check` again (the Knowledge Base text is part of the snapshots; regenerate the golden if only that text changed).

### 4b. Merge to GitHub `main` first
Commit on the branch, push it, and open a pull request with the GitHub REST API (`gh pr create` fails because GraphQL is blocked; use `gh api repos/surshan-bit/alba_security/pulls -f title=... -f head=... -f base=main -f body=...`). Wait for CI to pass. **Merge only when the user has said to merge** (`gh api -X PUT repos/surshan-bit/alba_security/pulls/N/merge -f merge_method=merge`); if they have not, push the branch, open the PR, and stop and ask. Commit messages and PR bodies end with the attribution lines the session asks for. Then `git checkout main && git pull` so the files you publish are exactly what is on `main`.

### 4c. Regenerate the page file AFTER the last build
**Shortcut:** on `main` after the merge and `npm run build`, `npm run release` (`node tools/release-prep.js`, default `--since HEAD^1`) writes `publish/index.html`, `publish/publish.json` (the `file_path`, `root` and `files` map for 4e, including `null` for old chunks) and `publish/release.json` (the record for 4f). Check the live version id and file list as in 4d, then publish with those values. The manual steps below say what it does.

`npm run check` and `npm run build` re-stamp `index.html` with a new build id and chunk names every time, so make `publish/index.html` fresh after the final build on `main`; never reuse an old one. Take the text of `index.html` from the first `<!DOCTYPE html>` up to and including the last `</body></html>` and save it as `publish/index.html` (`publish/` is not committed). Confirm it names the current `chunks/*` files and that the `?v=` build id on `styles.css` and `app.js` matches the latest build. If the build changed tracked files (`app.js`, `chunks/`, `index.html`), commit them to `main` through a small follow-up pull request so GitHub matches what is published.

### 4d. Check the artifact has not moved (required)
Right before publishing, `Artifact` action `list` (scope `files`) and compare the live version id with the one you wrote down in step 1. Then `Artifact` action `read` of the url **without a path** (the tool will not accept a publish otherwise).
- **Same id:** nobody else published; go on.
- **Different id:** another session or a save from the page published since you started. Do NOT publish your copy. Compare file sizes in the listing with your local files, read the ones that differ, diff them against the repo, and merge: bring the other change into the repo (new branch, check, pull request), rebuild, then redo 4a to 4c and compare ids again. Tell the user about the merge.
- The publish tool also refuses a publish that would overwrite files changed since you last read them; treat that refusal as this same situation, never force it.

### 4e. Publish
One `Artifact` publish with `url`, `file_path` = `publish/index.html`, `root` = the repo folder and `files` = {published path: relative path} for:
- `app.js`, `styles.css`, `js/loader.js` and ALL `chunks/*` (the names change every build);
- every `src/`, `styles/`, `partials/` and `tests/` file you changed (plus `README.md`, `package.json`, `package-lock.json` and `tools/` files if they changed);
- `null` for every old chunk that no longer exists locally (compare the artifact's file listing with `chunks/`).
**Repo-only files are not published to the artifact:** `platform/`, `supabase/`, `.github/`, `wrangler.jsonc`, `skills/`, `tools/dist.js`, `tools/export-pack.js`, `tools/export-settings.js`, `tests/platform.mjs`, `.gitignore`. Publishing never removes a file you leave out, so do not null anything except old chunks. Do not pass `capabilities` (the stored declaration carries forward). Never publish `tests/out`, `node_modules` or `publish/`.

### 4f. Write the release record (required, easy to forget)
Open pages compare their own build id with the document `appMeta/release`. If it still names an older build, every open tab reloads once and then shows "A new version is available" on every screen. Right after the publish, run `node tools/release-record.js publish/index.html` (it fails if the published page's build differs from the repo build) and write the printed `build` and `version`, plus `at` (the current time with +05:30), with `ArtifactData` `set` on collection `appMeta`, doc `release` (pin it with the `version` you just read). v1.171 and v1.172 skipped this step and left v1.170's record in place.

After publishing, tell the user what changed in one or two sentences, and ask them to open the live page once and click through Analysis, Explorer, a stock detail page, Data Refresh, Strategies and Trade Log, since the real runtime cannot be tested here. Note the new live version id as the base for any further change in the same session.

## 5. Roll back
GitHub: revert the merge commit through a pull request. Artifact: republish the previous file contents (read them from the previous version or from git). Artifact versions are kept.

## 6. Database backup (separate private repo)
The database holds real holdings, research and strategies, so it lives in its own private repo, **`surshan-bit/alba_security_data`** (attach it with `add_repo`, `access: "push"`). Take a fresh snapshot after any large data change (a Fundamental or Technical import, a research batch) and before any risky change. Never put this data in the code repo.
1. Export every collection with the `ArtifactData` tool: action `list`, `query.limit` 1000 and `out_dir` set to a scratch folder, following `next_cursor` until it ends. Collections: `stockData` (chunks `c001` onward; the count is in `stockMeta/main`, field `chunks`), `stockMeta`, `stockResearch`, `stockUpdates`, `priceHistory`, `scoreHistory` (64 docs `h00`..`h63`, the Score trend data), `importJobs`, `appMeta`, `diagnostics`, `backupLog`, `fundamentalCsvUploadLog`, `technicalCsvUploadLog`, `watchlistSyncLog`, `researchTriggers`, `refreshRequests`, `users`, and per user `data/users/<uid>` plus the nested `data/users/<uid>/portfolio/trades` and `data/users/<uid>/strategyTracking/runs`. Check the code (`grep -rn "db.doc(\|db.collection(" src`) for any collection added since.
2. Put the files under `db/<collection>/<doc>.json` in the data repo, rewrite `MANIFEST.json` (artifact version id, app release, export time, documents per collection), commit and push to `main`. Compare the document total with the previous manifest and tell the user if it dropped.
3. To restore, write each document back with the same collection and id (`ArtifactData` `set`), `stockMeta/main` and the `stockData` chunks first. A restore replaces newer data, so take a fresh snapshot first.

## 7. Keeping the skills backed up
The skills are used from the user's Claude account; the code repo only holds a copy under `skills/<name>/SKILL.md`. Whenever a skill is changed in a session, commit the same text to `skills/` in the code repo (branch and pull request as in 4b).

## Notes
- The fixtures in `tests/fixtures/stocks.json` are anonymised on purpose; do not add real company data. Real data goes only in the data repo.
- Claude usage in the Live Data Refresh: Moat/Governance (the Buffett-style factor cards) and Global & Macro run on the `default` tier; metrics lookup, Traditional factor cards and Strengths & Watch-outs on `quick`; a stock whose research is under 30 days old with no missing metric and no newer news is skipped. The user chose this split deliberately; do not downgrade the default-tier calls without asking.
- Scoring changes (the fundamental and technical engines) always come with a new test in `tests/engines.js` that fails on the old code, and a Knowledge Base line saying scores move only after the next import.
- A second, test-only deployment exists (Cloudflare Workers with Supabase, see the README). It is built from the same repo by `npm run build`; it is not part of the artifact publish, and its data is not covered by the backup in section 6.
