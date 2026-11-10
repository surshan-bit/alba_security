# Engineering Standards (system prompt for Claude)

These rules apply to every change in this repository. They are requirements, not preferences. If a request conflicts with a rule, say so and ask before breaking it.

## 0. Working agreement
- Read the surrounding code and match its conventions before writing anything.
- State assumptions; if the request is ambiguous in a way that changes the design, ask. Otherwise pick the conventional option and say which.
- Make the smallest change that fully solves the problem. No drive-by refactors, no speculative features, no unrequested abstractions.
- Define "done" up front: the exact checks that must pass. Do not report done until they have run green. Report failures and skipped steps plainly.
- Never skip, delete, weaken or quarantine a test to get green. Never use `--no-verify`.

## 1. Modular code, minimal change and impact
- One module = one responsibility, one reason to change. Files live in the existing `src/<feature>/` layout; add to the right feature folder rather than growing a neighbour.
- Pure logic (calculation, parsing, formatting, models) is separate from rendering and from I/O. Pure modules take inputs and return outputs; no DOM, no network, no globals.
- Depend through explicit `import`/`export` only. No shared mutable state: expose accessors or named actions, never exported `let`/`var` or `set_x` (lint enforces this).
- Small public surface: export only what other modules need. Dead exports and unused code are removed in the same change.
- New behaviour goes in a new module or a new function behind a narrow interface, not as an extra branch inside a large one. Prefer adding over editing; if you must edit shared code, list every caller first and keep its contract backward compatible.
- Functions do one thing, stay short (aim <= 40 lines), take few parameters (<= 4, else an options object), and avoid deep nesting (<= 3 levels; use early returns).
- No duplicated logic: before writing a helper, search for an existing one. Third copy of anything is extracted.
- Config and constants are named and centralised; no magic numbers or strings inline.
- One logical change per commit/PR, small enough to review and revert alone. Existing code is standardised incrementally: leave every file you touch compliant with this document (boy-scout rule), one module per PR, golden snapshots green throughout. Do not mass-reformat.

## 2. Global CSS only
- All styling lives in the single global design system: `styles/` bundled through `styles/main.css` into `styles.css`. Design tokens (colours, spacing, `--t-*` type sizes, radii, z-index) are defined once in `styles/tokens.css`; use tokens, never literal values.
- Forbidden in new/changed code: `style=` attributes, `<style>` blocks, JS assignments to `el.style.<prop>` (use `classList` toggles or `style.setProperty('--token', v)` for genuinely dynamic values), scoped or per-component CSS, `#id` selectors, `!important`, `:root:root:root` specificity hacks, hard-coded colours and font sizes.
- Reuse existing shared classes/parts first; add a new generic class to the global sheet only when none fits, named by role (BEM-style, e.g. `.card__title`), not by screen.
- Responsive and theme behaviour come from tokens and the existing layers (`@layer` order is fixed by lint); never add a one-off override to fix one screen.
- `styles/css-ratchet.json` and `tools/quality-ratchet.json` may only go down. When you reduce a count, lock it in with `node tools/lint.js --ratchet`.

## 3. Security (OWASP Top 10 / ASVS mindset)
- **Injection / XSS (A03):** never build HTML from data with `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or string concatenation. Use `textContent`, `createElement`, `setAttribute` on allow-listed attributes, or the project's escape helper. `eval` and `new Function` are banned. Validate and encode at every trust boundary; never trust CSV/JSON imports, URL params, `localStorage`, or API responses.
- **Broken access control (A01):** enforce authorisation server-side (Supabase RLS policies, edge functions), never only in the UI. Deny by default; least privilege for every policy and key.
- **Cryptographic failures / secrets (A02):** no secrets, tokens or keys in code, tests, logs, fixtures or commit history. Use environment/secret storage. Only anon/public keys may reach the browser. Never roll your own crypto.
- **Insecure design (A04):** think through abuse cases for any new input or endpoint; validate size, type, range and format with allow-lists; apply rate limits on server functions.
- **Security misconfiguration (A05):** keep the security headers in `platform/_headers` and never loosen them to make a change work. A strict `Content-Security-Policy` (no `unsafe-inline`/`unsafe-eval`) is set there and every browser suite runs under it: a change must keep it that way. Pin third-party scripts with SRI.
- **Vulnerable components (A06):** add dependencies only when essential, pinned to exact versions; `npm audit --omit=dev --audit-level=high` must pass. Prefer platform APIs over packages.
- **Identification / auth failures (A07), integrity (A08):** use the platform's auth, never custom session handling; verify the integrity of imported data and build outputs; GitHub Actions stay pinned by commit SHA with minimal `permissions`.
- **Logging (A09):** log security-relevant events without personal data or secrets; errors shown to users are generic, details go to the error log.
- **SSRF (A10):** server-side fetches use allow-listed hosts only.
- Parameterised queries only; no string-built SQL. Treat every new SQL migration, RLS policy and edge function as security-sensitive and call that out in the PR.
- `evalLike`, `innerHTMLAssignments` and related counters in `tools/quality-ratchet.json` may only go down. Run the `security-review` skill before finishing any change that touches input handling, auth, storage, SQL, headers or dependencies.

## 4. Code quality
- Readable over clever: descriptive names, one idiom per concern, comments explain *why*, never what. Remove commented-out code and unused names.
- Types: keep `npm run types` clean; add JSDoc types to every new exported function; do not widen to `any` to silence errors.
- Errors: no empty `catch` (lint enforces a reason comment); handle failures at the boundary, surface a user-safe message, never swallow silently. Validate inputs at module boundaries and fail fast.
- Accessibility: semantic HTML, labels, keyboard support, visible focus, sufficient contrast, ARIA only when native semantics are not enough.
- Performance: no work in hot paths that can be hoisted; lazy-load heavy modules via literal `import()`; no layout thrash.
- Deterministic code: inject time, randomness and I/O so they are testable; the app runs on India time (`Asia/Kolkata`) in tests.
- Docs: update README/Help/Knowledge Base text and golden text snapshots when behaviour they describe changes.

## 5. Tests and coverage
- Every new or modified module ships with unit tests in the same change, targeting 100% line and branch coverage of the lines you add or change. Untested code is unfinished code.
- Test behaviour through the public interface: happy path, boundaries, empty/null/malformed input, error paths, and a security case (hostile string such as `<img onerror=...>`) for anything that renders or parses external data.
- Bug fix = a failing regression test first, then the fix.
- Tests are deterministic, isolated and fast: no real network, clocks or randomness; use `tests/fixtures` and `tests/lib` helpers.
- Golden snapshots (`tests/golden*.json*`) change only when behaviour is meant to change; review the diff and say why before `npm run update-golden`.
- Measure it with `npm run coverage` (c8 over `tests/engines.js`, mapped back to `src/`). The global floor lives in `tools/coverage-ratchet.json`: it ratchets up and never drops (`node tools/coverage.js --update` locks in a gain). `npm run coverage -- --changed` fails if any line you added or changed in `src/` has no unit test; CI runs it on every pull request.
- Only `tests/engines.js` counts toward coverage. Test DOM-heavy modules with `loadWithStubs()` from `tests/lib/load.js` (it swaps page-level imports such as `core/store.js` for small stand-ins). The jsdom and Chromium suites protect behaviour but are not measured yet.
- If a line truly cannot be unit tested, say so explicitly in the PR with the reason, and give the PR the `coverage-waiver` label: it skips only the changed-lines step (the floor still applies). Use it for mechanical changes to UI code whose behaviour the snapshot and Chromium suites already protect; the owner decides, never the author of the change alone.

## 6. Definition of done (run all, report results)
1. `npm run lint` (no errors; lower ratchets if counts dropped)
2. `npm run types`
3. `npm run check` (build + golden + regression harness) and `npm run platform`; `npm run rls` when `supabase/` changed
4. `npm run browser` / `npm run state` where UI or state changed
5. `npm audit --omit=dev --audit-level=high`
6. Tests added for every changed module; `npm run coverage` and `npm run coverage -- --changed` pass (changed code at 100%)
7. Security self-review against section 3 written in the PR description
8. Diff reviewed: nothing unrelated, no secrets, no debug output

Commit messages: imperative subject <= 72 chars, body explains why. Never commit to `main` directly; do not open a PR unless asked.
