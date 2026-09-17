/**
 * Dose-time derivation from label instructions (PRD §4 timing anchors).
 *
 * Demo-grade deterministic parser: maps the phrasing common on geriatric
 * labels ("on an empty stomach before breakfast", "twice daily", "every 6
 * hours", "at bedtime") onto the day's wall-clock anchors. It exists so
 * schedule generation is computable from `instructions_raw` alone.
 * Unrecognized text falls back to the wake-anchored morning dose rather than
 * guessing exotic timings; frequency phrases win over meal phrases.
 *
 * Pure: string in → clock times out. No clock, no I/O.
 */

/** Wall-clock anchors (HH:MM) the day's doses are placed against. */
export interface DayAnchors {
  /** On-waking / empty-stomach anchor — the PRD worked case's levothyroxine slot. */
  wake: string;
  breakfast: string;
  midday: string;
  dinner: string;
  evening: string;
  /** Last daily slot, deliberately before the bedtime boundary. */
  bedtimeDose: string;
}

/** Demo defaults — PRD §4 worked case anchors (wake 07:00, bedtime 22:00). */
export const DEFAULT_DAY_ANCHORS: DayAnchors = {
  wake: '07:00',
  breakfast: '08:00',
  midday: '13:00',
  dinner: '18:00',
  evening: '20:00',
  bedtimeDose: '21:00',
};

/**
 * Derive the day's dose times (HH:MM, ascending, deduplicated) for one
 * medication from its instruction text.
 */
export function deriveDoseTimes(
  instructionsRaw: string,
  anchors: DayAnchors = DEFAULT_DAY_ANCHORS,
): string[] {
  const text = instructionsRaw.toLowerCase();

  // Interval dosing: "every N hours" from wake until the last slot that
  // still lands at or before the bedtime dose.
  const interval = text.match(/every\s+(\d{1,2})\s*hours?/);
  if (interval) {
    const step = Number.parseInt(interval[1], 10);
    if (step > 0) return intervalTimes(anchors.wake, step, anchors.bedtimeDose);
  }

  // Daily-frequency phrases.
  if (/(three|3)\s+times/.test(text)) {
    return [anchors.wake, anchors.midday, anchors.evening];
  }
  if (/(four|4)\s+times/.test(text)) {
    return [anchors.wake, anchors.midday, anchors.dinner, anchors.bedtimeDose];
  }
  if (/(twice|two\s+times|2\s+times|2\s*x)/.test(text)) {
    // "Twice daily with food" meals both ends; plain twice-daily is morning + evening.
    return /with\s+(food|meals?)/.test(text)
      ? [anchors.breakfast, anchors.dinner]
      : [anchors.wake, anchors.evening];
  }

  // Explicit single-dose anchors, most specific phrase first. "Empty
  // stomach"/"before breakfast" means on-waking (the levothyroxine rule).
  if (/at\s+bedtime|before\s+bed\b|at\s+night|nighttime/.test(text)) {
    return [anchors.bedtimeDose];
  }
  if (
    /empty\s+stomach|before\s+(breakfast|food|eating)|on\s+waking|upon\s+waking|in\s+the\s+morning|\bmorning\b/.test(
      text,
    )
  ) {
    return [anchors.wake];
  }
  if (/breakfast|with\s+(food|meals?)/.test(text)) {
    return [anchors.breakfast];
  }
  if (/\blunch\b|midday|noon/.test(text)) {
    return [anchors.midday];
  }
  if (/dinner|supper/.test(text)) {
    return [anchors.dinner];
  }
  if (/evening|afternoon|\bpm\b/.test(text)) {
    return [anchors.evening];
  }

  // Unrecognized text: one wake-anchored dose — never guess exotic timings.
  return [anchors.wake];
}

/** Times from `start` stepping `stepHours`, up to and including `lastAnchor`. */
function intervalTimes(start: string, stepHours: number, lastAnchor: string): string[] {
  const times: string[] = [];
  let minutes = clockToMinutes(start);
  const limit = clockToMinutes(lastAnchor);
  for (let slot = 0; slot < 24 && minutes <= limit; slot += 1) {
    times.push(minutesToClock(minutes));
    minutes += stepHours * 60;
  }
  return times.length > 0 ? times : [start];
}

function clockToMinutes(clock: string): number {
  // No `parseInt.bind` inside map: map's second argument (the index) would
  // become the radix and silently NaN odd positions.
  const [hours, minutes] = clock.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
