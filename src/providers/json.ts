export const INVALID_JSON_KEY = '__invalid_json';

/**
 * Parse streamed tool arguments. Truncated or malformed JSON is surfaced to the
 * agent loop (which answers with an error tool_result) instead of being dropped.
 */
export function parseToolJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { [INVALID_JSON_KEY]: raw };
  } catch {
    return { [INVALID_JSON_KEY]: raw };
  }
}
