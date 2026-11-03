// Checks made before the Claude function spends money (CLAUDE.md section 3, A04). Pure (no network, no Deno), so the node tests can run it.
export const DEFAULT_MAX_CALLS = 1000;
export const DEFAULT_WINDOW_MINUTES = 60;
const MAX_SETTING = 100_000;   // a larger secret is a typo, not a policy

export const allowedMethod = (method: string): boolean => method === 'POST';

// Whole numbers from 1 up; anything else (empty, text, zero, negative, fractions, huge) means "use the default".
function wholeNumber(value: string | undefined, fallback: number): number {
  if (!value || !/^[0-9]+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= MAX_SETTING ? n : fallback;
}

// The owner's quota from the secrets SAMPLE_MAX_CALLS and SAMPLE_WINDOW_MINUTES.
export const quotaConfig = (maxCalls?: string, windowMinutes?: string) =>
  ({ maxCalls: wholeNumber(maxCalls, DEFAULT_MAX_CALLS), windowMinutes: wholeNumber(windowMinutes, DEFAULT_WINDOW_MINUTES) });

// What the database said about taking one slot: true = counted and inside the limit, false = over the limit.
// Any other answer, or an error, is "unavailable": the call is refused rather than allowed unmetered.
export function quotaDecision(result: { data: unknown; error: unknown }): 'allowed' | 'limited' | 'unavailable' {
  if (result.error) return 'unavailable';
  if (result.data === true) return 'allowed';
  return result.data === false ? 'limited' : 'unavailable';
}
