/** Narrow JSON payloads without `any` — the shared `unknown` unwrapper. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
