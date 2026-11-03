// Per-caller request limit (CLAUDE.md section 3, A04), using Cloudflare's Rate Limiting binding (wrangler.jsonc, "ratelimits"). Counted per
// client address and checked before the token, so guessing the token is limited too. Without the binding (tests, local runs) nothing is limited.
const CLIENT_ADDRESS_HEADER = 'CF-Connecting-IP';
const SHARED_KEY = 'unknown';   // callers that send no address share one count
export const RETRY_AFTER_SECONDS = 60;   // the period of the limiter in wrangler.jsonc

/** @param {Request} request @param {{ RATE_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }} env
 * @returns {Promise<'allowed' | 'limited' | 'unavailable'>} 'unavailable' when the limiter itself fails: the call is refused, not let through */
export async function checkRate(request, env){
  const limiter = env.RATE_LIMITER;
  if(!limiter) return 'allowed';
  try {
    const { success } = await limiter.limit({ key: request.headers.get(CLIENT_ADDRESS_HEADER) || SHARED_KEY });
    return success ? 'allowed' : 'limited';
  } catch(e){ return 'unavailable'; }   // the binding failed; refuse rather than run unmetered
}
