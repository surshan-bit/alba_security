# alba-tv-gateway (spike)

Proves one thing: a Cloudflare Worker can sign in to the TradingView MCP server (`https://mcp.tradingview.com/mcp`, OAuth 2.1, streamable HTTP)
and call a tool for the owner. It is deployed on its own and is not part of the dashboard build.

## Routes (all but `/` and `/tv/callback` need `?key=<SPIKE_KEY>`)
- `/tv/connect`  discovers the OAuth endpoints, registers a client (dynamic registration), sends you to TradingView to sign in (PKCE).
- `/tv/callback` TradingView returns here; the Worker stores the tokens in KV. Only a sign-in started by `/tv/connect` can finish.
- `/tv/tools`    lists the tools the server offers to this sign-in.
- `/tv/search?q=titan`  calls `mcp-tv-search-symbols`.
Access tokens are refreshed automatically with the refresh token.

## Run the spike (no coding, about 15 minutes, all in the Cloudflare dashboard)
1. Cloudflare dashboard, Workers & Pages, **Create**, **Import a repository**, pick `alba_security`. Name it `alba-tv-gateway`, set the
   **root directory** to `tv-gateway`, keep the default deploy command (`npx wrangler deploy`). Deploy. The storage (`TV_KV`) is created on the first deploy.
2. Open the new Worker, **Settings, Variables and Secrets**, add a **Secret** named `SPIKE_KEY` (a long random text, 16+ characters). Save and deploy.
3. Open `https://alba-tv-gateway.<your-subdomain>.workers.dev/tv/connect?key=<SPIKE_KEY>`, sign in to TradingView, allow.
4. Open `/tv/tools?key=...` then `/tv/search?q=titan&key=...`.

## What the spike answers
- Does TradingView accept a client registered by a Worker (dynamic registration, redirect to workers.dev)?
- Does it return a refresh token, and for how long does it last (check that `/tv/search` still works a day later)?
- Which tools does the sign-in expose (the scoped beta lists fewer)?
If registration is refused, the error shows the server's answer; TradingView would have to issue a client id.

Tests (a pretend TradingView, no network): `npm run tvgateway` in the repo root.
