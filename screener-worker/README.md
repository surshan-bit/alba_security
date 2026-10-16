# alba-screener

A small remote MCP server that runs on Cloudflare Workers (free plan) and returns the inputs of the Alba fundamental score for a list of
stocks, read from the **peer-comparison table** of your signed-in Screener.in account. It is not part of the dashboard build or the claude.ai
artifact. Nothing here is published to the artifact; it is deployed to Cloudflare on its own.

## Why the peer table
For PASUPTAC every field the CSV import uses (about 38 of them: debt, returns, growth, valuation, intrinsic value, Piotroski, shareholding
changes, cash flows) came out of one row of that table, and the values matched the saved CSV. The table's columns are the ones saved in the
Screener account, so the Worker must sign in as the same account.

## Tools
- `fundamentals_batch { symbols: [...] }` returns one record per symbol. On the free plan a call handles at most 20 symbols (about two requests
  to Screener each, and the plan allows 50 outgoing requests per call), and returns `remaining` for the rest, so the caller asks again until it is empty.
  `unmatched_headings` lists table columns the Worker does not know, so a column Screener renames shows up at once.
- `diagnose { symbol }` returns the company's row and the table headings, to check what the account returns.

## Set up (about 15 minutes)
1. Cloudflare dashboard, Workers & Pages, **Create**, **Import a repository**, pick `alba_security`. Name it `alba-screener`, set the
   **root directory** to `screener-worker`, keep the default deploy command (`npx wrangler deploy`).
2. Open the new Worker, **Settings, Variables and Secrets**, add these as **Secret**:
   - `MCP_TOKEN`: a long random text (at least 16 characters; 40 is better). It is part of the connector address, so treat it like a password.
   - `SCREENER_SESSIONID`: the `sessionid` cookie of a browser session signed in to screener.in. In Chrome open screener.in, press F12,
     **Application, Cookies, https://www.screener.in**, copy the value of `sessionid`. When it expires (a login error comes back), copy the new one.
     Or use `SCREENER_USERNAME` and `SCREENER_PASSWORD` instead; the Worker then signs in itself.
3. Open `https://alba-screener.<your-subdomain>.workers.dev/`. It should say "alba-screener is running".
4. In Claude: **Settings, Connectors, Add custom connector**, address `https://alba-screener.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>`.
5. Ask Claude to run `diagnose` for PASUPTAC and compare it with the values already checked.

## Tests
`npm run screener` in the repo root (uses a pretend Screener, no network).
