// Which pages may call the private functions from a browser. The list is the secret ALLOWED_ORIGINS (comma separated);
// without it only the test site is allowed. A page that is not listed gets no Access-Control-Allow-Origin, so the browser blocks the call.
const DEFAULT_ORIGINS = 'https://alba-test.surshan.workers.dev';

export function corsHeaders(origin: string | null, allowed: string = DEFAULT_ORIGINS): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
  if (origin && allowed.split(',').map(s => s.trim()).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
