/**
 * RxNorm normalization seed (PRD §4) — a seeded map of common geriatric
 * medications with interaction pairs and `minBufferMinutes`.
 *
 * Unknown names never guess: `normalizeMedicationName` returns null and the
 * caller flags the medication for manual RXCUI entry (PRD §4).
 *
 * NOTE on the seed values: RXCUIs are demo seed data pinned from common usage;
 * verify them against the current RxNorm release (RxNorm API) before any
 * production/Supabase phase. The unit tests pin name/alias behavior and the
 * interaction-pair buffers, not RXCUI identity. Interaction timing (e.g. the
 * levothyroxine–calcium gap) follows the approved PRD §4, which pins 2 hours.
 */

import type { BufferType, MedicationBufferRequirement } from './types';

export interface RxNormEntry {
  rxcui: string;
  genericName: string;
  /** Brand names and common aliases that normalize to this entry. */
  aliases: string[];
  /** High-risk side effects monitored after each dose (canonical symptom names). */
  highRiskSideEffects: string[];
}

export interface InteractionPair {
  /** First RXCUI of the pair (order is insignificant — pairs are undirected). */
  aRxcui: string;
  /** Second RXCUI of the pair. */
  bRxcui: string;
  minBufferMinutes: number;
  bufferType: BufferType;
}

/**
 * The seed map: geriatric polypharmacy staples. One entry per generic drug;
 * lookup covers generic name, brand aliases, and dose-suffixed label text.
 */
export const RXNORM_SEED: readonly RxNormEntry[] = [
  { rxcui: '11289', genericName: 'levothyroxine', aliases: ['synthroid', 'levothroid', 'levo'], highRiskSideEffects: [] },
  { rxcui: '21925', genericName: 'calcium carbonate', aliases: ['tums', 'calcium', 'caco3'], highRiskSideEffects: [] },
  { rxcui: '29046', genericName: 'lisinopril', aliases: ['zestril', 'prinivil'], highRiskSideEffects: ['dizziness'] },
  { rxcui: '68009', genericName: 'metformin', aliases: ['glucophage'], highRiskSideEffects: ['nausea'] },
  { rxcui: '17767', genericName: 'amlodipine', aliases: ['norvasc'], highRiskSideEffects: ['dizziness'] },
  { rxcui: '83369', genericName: 'atorvastatin', aliases: ['lipitor'], highRiskSideEffects: [] },
  { rxcui: '7646', genericName: 'omeprazole', aliases: ['prilosec'], highRiskSideEffects: [] },
  { rxcui: '69180', genericName: 'metoprolol', aliases: ['lopressor', 'toprol xl'], highRiskSideEffects: ['dizziness'] },
  { rxcui: '52175', genericName: 'losartan', aliases: ['cozaar'], highRiskSideEffects: ['dizziness'] },
  { rxcui: '6467', genericName: 'gabapentin', aliases: ['neurontin'], highRiskSideEffects: ['dizziness'] },
  { rxcui: '82116', genericName: 'sertraline', aliases: ['zoloft'], highRiskSideEffects: [] },
  { rxcui: '11295', genericName: 'warfarin', aliases: ['coumadin'], highRiskSideEffects: ['bleeding'] },
] as const;

/**
 * Seeded interaction pairs with the minimum timing buffer the schedule must
 * respect. Only absorption-type timing constraints belong here (a bleeding-risk
 * DDI like warfarin + aspirin has no meaningful minute buffer — such pairs are
 * a later reporting concern, not a scheduling one).
 */
export const INTERACTION_PAIRS: readonly InteractionPair[] = [
  // PRD §4 canonical: levothyroxine needs a 2-hour gap from calcium carbonate.
  { aRxcui: '11289', bRxcui: '21925', minBufferMinutes: 120, bufferType: 'absorption' },
  // PPIs reduce levothyroxine absorption — same separation rule.
  { aRxcui: '11289', bRxcui: '7646', minBufferMinutes: 120, bufferType: 'absorption' },
] as const;

export interface RxNormMatch {
  rxcui: string;
  genericName: string;
  highRiskSideEffects: string[];
}

/**
 * Normalize a medication name (or alias) from a label or user entry to its
 * RxNorm seed entry. Tolerates dose-suffixed label text ("calcium carbonate
 * 500 mg"), case, and punctuation. Returns null for unknown names — callers
 * flag for manual RXCUI entry rather than guess (PRD §4).
 */
export function normalizeMedicationName(rawName: string): RxNormMatch | null {
  const normalized = normalizeForLookup(rawName);
  if (normalized.length === 0) return null;

  for (const entry of RXNORM_SEED) {
    if (
      normalizeForLookup(entry.genericName) === normalized ||
      entry.aliases.some((alias) => normalizeForLookup(alias) === normalized)
    ) {
      return { rxcui: entry.rxcui, genericName: entry.genericName, highRiskSideEffects: entry.highRiskSideEffects };
    }
  }
  return null;
}

/**
 * Build the solver's per-med buffer requirements for today's medication list:
 * every seeded interaction pair whose two medications are both present.
 * Same-RXCUI duplicates (two doses of one drug) produce no self-pair.
 */
export function buildBufferRequirements(
  medicationsToday: readonly { id: string; rxcui: string | null }[],
): MedicationBufferRequirement[] {
  const idByRxcui = new Map<string, string>();
  for (const med of medicationsToday) {
    if (med.rxcui) idByRxcui.set(med.rxcui, med.id);
  }

  const requirements: MedicationBufferRequirement[] = [];
  for (const pair of INTERACTION_PAIRS) {
    const aId = idByRxcui.get(pair.aRxcui);
    const bId = idByRxcui.get(pair.bRxcui);
    if (!aId || !bId || aId === bId) continue;
    requirements.push({
      medicationId: aId,
      pairedWithMedicationId: bId,
      minBufferMinutes: pair.minBufferMinutes,
      bufferType: pair.bufferType,
    });
  }
  return requirements;
}

/** Lowercase, trim, strip punctuation, and drop a trailing dose/strength tail. */
function normalizeForLookup(raw: string): string {
  let normalized = raw.trim().toLowerCase().replace(/[.']/g, '');
  const firstDigit = normalized.search(/[0-9]/);
  if (firstDigit > 0) {
    normalized = normalized.slice(0, firstDigit).trim();
  }
  return normalized;
}
