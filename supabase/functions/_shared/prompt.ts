// Reads the prompt out of a request body for the Claude function. Pure (no network, no Deno), so the node tests can run it.
export const MAX_PROMPT_CHARS = 400_000;

export type PromptResult = { prompt: string } | { code: string; message: string; status: number };

// Anything that is not an object with a non-empty text prompt is refused with a user-safe message, never an exception.
export function readPrompt(body: unknown): PromptResult {
  const prompt = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { prompt?: unknown }).prompt : undefined;
  if (typeof prompt !== 'string' || !prompt) return { code: 'invalid_request', message: 'Bad request.', status: 400 };
  if (prompt.length > MAX_PROMPT_CHARS) return { code: 'prompt_too_large', message: 'Too large.', status: 413 };
  return { prompt };
}
