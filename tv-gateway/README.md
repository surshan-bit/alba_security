# alba-tv-gateway (spike)

Proves one thing: a Cloudflare Worker can sign in to the TradingView MCP server (`https://mcp.tradingview.com/mcp`, OAuth 2.1, streamable HTTP)
and call a tool for the owner. It is deployed on its own and is not part of the dashboard build.

## Routes (all but `/` and `/tv/callback` need `?key=<SPIKE_KEY>`)
- `/tv/connect`  discovers the OAuth endpoints, registers a client (dynamic registration), sends you to TradingView to sign in (PKCE).
- `/tv/callback` TradingView returns here; the Worker stores the tokens in KV. Only a sign-in started by `/tv/connect` can finish.
- `/tv/tools`    lists the tools the server offers to this sign-in.
- `/tv/search?q=titan`  calls `mcp-tv-search-symbols`.
Access tokens are refreshed automatically with the refresh token.

## Run the spike (about 10 minutes)
1. `cd tv-gateway && npx wrangler kv namespace create TV_KV`, paste the id into `wrangler.jsonc`.
2. `npx wrangler secret put SPIKE_KEY` (a long random text, 16+ characters). `npx wrangler deploy`.
3. Open `https://alba-tv-gateway.<subdomain>.workers.dev/tv/connect?key=<SPIKE_KEY>`, sign in to TradingView, allow.
4. Open `/tv/tools?key=...` then `/tv/search?q=titan&key=...`.

## What the spike answers
- Does TradingView accept a client registered by a Worker (dynamic registration, redirect to workers.dev)?
- Does it return a refresh token, and for how long does it last (check that `/tv/search` still works a day later)?
- Which tools does the sign-in expose (the scoped beta lists fewer)?
If registration is refused, the error shows the server's answer; TradingView would have to issue a client id.

Tests (a pretend TradingView, no network): `npm run tvgateway` in the repo root.
