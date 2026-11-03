// Asks Claude on the owner's behalf (the Fundamental refresh and news labelling). The Anthropic key lives only in this function's
// secrets (ANTHROPIC_API_KEY), never in the browser. Replies { text } like the claude.ai runtime did.
import { callerClient, cors, reply, requireOwner } from '../_shared/owner.ts';
import { allowedMethod, quotaConfig, quotaDecision } from '../_shared/guard.ts';
import { readPrompt } from '../_shared/prompt.ts';

const MODELS: Record<string, string> = {
  quick: Deno.env.get('MODEL_QUICK') ?? 'claude-haiku-5-5',
  default: Deno.env.get('MODEL_DEFAULT') ?? 'claude-sonnet-5-5'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (!allowedMethod(req.method)) return reply(req, { code: 'invalid_request', message: 'Use POST.' }, 405);
  const denied = await requireOwner(req);
  if (denied) return denied;
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return reply(req, { code: 'sampling_disabled', message: 'The Anthropic key is not set up yet.' }, 503);

  let body: any;
  try { body = await req.json(); } catch { return reply(req, { code: 'invalid_request', message: 'Bad request.' }, 400); }
  const read = readPrompt(body);
  if ('status' in read) return reply(req, { code: read.code, message: read.message }, read.status);
  const prompt = read.prompt;
  // Counted only now, so a malformed request never uses up the quota. The Authorization header is there: requireOwner passed.
  const { maxCalls, windowMinutes } = quotaConfig(Deno.env.get('SAMPLE_MAX_CALLS'), Deno.env.get('SAMPLE_WINDOW_MINUTES'));
  const slot = quotaDecision(await callerClient(req.headers.get('Authorization')!).rpc('take_sample_slot', { p_limit: maxCalls, p_window: `${windowMinutes} minutes` }));
  if (slot === 'limited') return reply(req, { code: 'rate_limited', message: 'Too many requests. Try again later.' }, 429);
  if (slot === 'unavailable') return reply(req, { code: 'sample_error', message: 'Claude is not available right now.' }, 503);
  const model = MODELS[body.modelTier === 'quick' ? 'quick' : 'default'];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 ? 'rate_limited' : r.status === 401 ? 'sampling_disabled' : 'sample_error';
    return reply(req, { code, message: String(data?.error?.message ?? 'Claude did not answer.').slice(0, 300) }, r.status === 429 ? 429 : 502);
  }
  const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  return reply(req, { text, usage: data.usage ?? null });
});
