import type { RxNormMatch } from '@/lib/engines/rxnorm';

/**
 * Persistable side-effect list for an extracted medication: the RxNorm seed's
 * canonical effects first (they drive the DIZZY check-in matching), then any
 * additional label warnings from extraction — union, order-preserving,
 * case-insensitive dedupe. Unmatched names keep the label's own list.
 */
export function mergeSideEffects(
  extractionEffects: string[],
  rxnorm: RxNormMatch | null,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const effect of [...(rxnorm?.highRiskSideEffects ?? []), ...extractionEffects]) {
    const key = effect.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(effect.trim());
  }
  return merged;
}
