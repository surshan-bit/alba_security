// Asks Claude on the owner's behalf (the Fundamental refresh and news labelling). The Anthropic key lives only in this function's
// secrets (ANTHROPIC_API_KEY), never in the browser. Replies { text } like the claude.ai runtime did.
import { cors, reply, requireOwner } from '../_shared/owner.ts';

const MODELS: Record<string, string> = {
  quick: Deno.env.get('MODEL_QUICK') ?? 'claude-haiku-5-5',
  default: Deno.env.get('MODEL_DEFAULT') ?? 'claude-sonnet-5-5'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const denied = await requireOwner(req);
  if (denied) return denied;
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return reply({ code: 'sampling_disabled', message: 'The Anthropic key is not set up yet.' }, 503);

  let body: any;
  try { body = await req.json(); } catch { return reply({ code: 'invalid_request', message: 'Bad request.' }, 400); }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return reply({ code: 'invalid_request', message: 'No prompt.' }, 400);
  if (prompt.length > 400_000) return reply({ code: 'prompt_too_large', message: 'Too large.' }, 413);
  const model = MODELS[body.modelTier === 'quick' ? 'quick' : 'default'];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 ? 'rate_limited' : r.status === 401 ? 'sampling_disabled' : 'sample_error';
    return reply({ code, message: String(data?.error?.message ?? 'Claude did not answer.').slice(0, 300) }, r.status === 429 ? 429 : 502);
  }
  const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  return reply({ text, usage: data.usage ?? null });
});
