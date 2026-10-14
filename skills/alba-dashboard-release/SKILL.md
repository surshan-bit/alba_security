---
name: "alba-dashboard-release"
description: "Use when changing, testing or publishing the Alba Securities - Stock Analyzer dashboard artifact (src modules, styles, partials): restore the project, run the checks, then publish."
---

# Alba dashboard: change, check, publish

The dashboard is the claude.ai artifact https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh. Its source is ES modules in `src/` built into `app.js` and hashed `chunks/`; `README.md` in the artifact describes the layout, conventions and what the tests cover. Read it first.

**Only one session should change this artifact at a time.** Every publish sends whole files, so a second session working from an older copy silently deletes the first session's work (this happened: a notification bell published by another session would have been wiped). Steps 1 and 4c guard against it.

## 1. Restore the project (a fresh session has nothing local)
1. `Artifact` action `list`, scope `files`, with the url, to see the published files. **Write down the live version id** the listing shows (for example `1791780725-89db`); this is the base version your work starts from.
2. `Artifact` action `read` with `paths` (up to 256 per call) to save every file into the scratchpad. Keep the same relative paths; call the folder `proj/`.
3. In `proj/`: `npm install --silent` (needs the network; versions are pinned in package.json / package-lock.json).
4. Make the clean page file as in step 4b and use `publish/index.html` as `file_path`.

## 2. Change
Edit the module in `src/` that owns the behaviour (never `app.js`), plus `styles/*.css` (never `styles.css`), `partials/*.html`, `js/loader.js` as needed. Rules (lint enforces them): explicit imports; a module cannot assign another module's variable (use or add a `set_<name>` setter in the owner); start-up code goes in the module's `init_*` function, called from `src/main.js`; no unused code.

## 3. Check before every publish
`npm run check` in `proj/` builds app.js, syntax-checks, lints (strict), runs the regression harness against `tests/golden.json`, and runs the Chromium suites. It must print OK.
- If snapshots differ and the change is intended (new wording, layout, behaviour), review the differing names, then `npm run update-golden`. If a difference is NOT intended, fix the code. A snapshot that changes between two runs of unchanged code is a timing flake in the test (make the test wait longer before it); do not just regenerate it.
- To see exactly what changed, run `node tests/run.js <previous project dir> <folder>` on the previous version and diff the folders.
- When adding behaviour, extend `tests/run.js` and `tests/browser.js` so the new path is covered, then update the golden.
- Limits: the harness is jsdom with a stand-in database, TradingView and Claude. It does not run the real runtime or `js/boot.js` data loading. For layout or boot changes also load the page in Chromium (Playwright is installed in this environment at /opt/npm-tools; serve the folder with a static server, stub `window.claude` with a database stand-in, add `[hidden]{display:none!important}` because the claude.ai page skeleton provides it) and look at screenshots.

## 4. Release (do all of these, in order)

### 4a. Bump the version
The sidebar badge tracks product milestones. For any user-visible change:
1. In `index.html` change both the badge text and its title, e.g. `title="Version 1.108 &mdash; tagged 2026-10-12">v1.108` (the next number, today's date).
2. In `partials/knowledgebase.html`, section 9 Version history, add a new `<h3>v1.108 &middot; date</h3>` block with a `<ul>` of plain-language bullets above the previous newest entry (what the user sees, not file names).
3. Update Help (`partials/help.html`) and the Knowledge Base text if a screen, button or label was renamed.
4. Run `npm run check` again (the Knowledge Base text is part of the snapshots; regenerate the golden if only that text changed).

### 4b. Regenerate the page file AFTER the last build
`npm run check` and `npm run build` re-stamp `index.html` with a new build id and chunk names every time, so make `publish/index.html` fresh after the final build; never reuse an old one. Take the text of `index.html` from the first `<!DOCTYPE html>` up to and including the last `</body></html>` and save it as `publish/index.html`. Confirm it names the current `chunks/*` files and that the `?v=` build id on `styles.css` and `app.js` matches the latest build.

### 4c. Check the live version has not moved (required)
Right before publishing, `Artifact` action `list` (scope `files`) or `read` the url and compare the live version id with the one you wrote down in step 1.
- **Same id:** nobody else published; go on.
- **Different id:** another session published since you started. Do NOT publish your copy. Compare the file sizes in the listing with your local files, read the ones that differ (`read` with `paths`), diff them against `proj/`, and merge: take the other session's new or changed files (new modules, `styles/main.css`, `src/main.js`, `index.html` additions) and keep your own changes on top. Rebuild, run `npm run check` (update the golden for the merged behaviour), redo 4a and 4b, then compare ids again. Tell the user about the merge.
- The publish tool also refuses a publish that would overwrite files changed since you last read them; treat that refusal as this same situation, never force it.

### 4d. Publish
One `Artifact` publish with `url`, `file_path` = `publish/index.html`, `root` = the `proj` folder and `files` = {published path: relative path} for:
- `app.js`, `styles.css`, `js/loader.js` and ALL `chunks/*` (the names change every build);
- every `src/`, `styles/`, `partials/` and `tests/` file you changed (plus `README.md` if it changed);
- `null` for every old chunk that no longer exists locally.
Do not pass `capabilities` (the stored declaration carries forward). Never publish tests/out or node_modules.

After publishing, tell the user what changed in one or two sentences, and ask them to open the live page once and click through Analysis, Explorer, a stock detail page, Data Refresh, Strategies and Trade Log, since the real runtime cannot be tested here. Note the new live version id as the base for any further change in the same session.

## 5. Roll back
Republish the previous file contents (read them from the previous version or from the scratchpad copy). Artifact versions are kept.

## Notes
- The fixtures in `tests/fixtures/stocks.json` are anonymised on purpose; do not add real company data.
- Claude usage in the Live Data Refresh: Moat/Governance (the Buffett-style factor cards) and Global & Macro run on the `default` tier; metrics lookup, Traditional factor cards and Strengths & Watch-outs on `quick`; a stock whose research is under 30 days old with no missing metric and no newer news is skipped. The user chose this split deliberately; do not downgrade the default-tier calls without asking.