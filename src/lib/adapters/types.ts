/**
 * Adapter contracts (build spec art_GJnhfsve, "System shape" — the interface
 * sample is authoritative and is reproduced here with concrete generics).
 *
 * Engines and UI depend only on these contracts. The factory in ./index
 * selects between real service adapters and deterministic fixtures based on
 * environment credentials alone: CI never has credentials, so CI can never
 * reach Twilio or ConcentrateAI.
 */

/**
 * Structured result of reading a medication label from a photo (PRD §3).
 * Only medication-label content ever reaches the model — no patient
 * identifiers (build spec, ConcentrateAI note).
 */
export interface LabelExtractionResult {
  brandName: string;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  /** Gates the low-confidence workflow — modal below 0.70 (PRD §3). */
  confidence: number;
  /** e.g. ["dizziness", "orthostasis"] — drives the DIZZY YES/NO check-in. */
  highRiskSideEffects: string[];
  /** RxNorm id when the label itself carries one; normalization owns real resolution. */
  rxcui: string | null;
}

/**
 * PRD §3 constant — a fixture/constant, NOT a clinically validated threshold.
 * Ship named so it is trivially tunable later (build spec, "Risks").
 */
export const OCR_CONFIDENCE_GATE = 0.7;

/** OCR over pill-bottle photos. Real impl: ConcentrateAI vision model call. */
export interface VisionOcrAdapter {
  extractLabel(imageUrl: string): Promise<LabelExtractionResult>;
}

export interface SmsSendResult {
  messageId: string;
}

/** Outbound SMS. Real impl: Twilio REST API. Fixture: appends to sms_outbox. */
export interface SmsGatewayAdapter {
  send(to: string, body: string, mediaUrl?: string): Promise<SmsSendResult>;
}

/** Payload for a +45-minute caregiver escalation (PRD §5). */
export interface EscalationJob {
  dailyScheduleId: string;
  profileId: string;
}

/**
 * Durable delay queue. No QStash this iteration (locked decision): rows in
 * escalation_jobs, dispatched by a scheduled sweep tick with clock injection;
 * a production job runner swaps in behind this interface later.
 */
export interface DelayQueueAdapter {
  enqueue(payload: EscalationJob, deliverAt: Date): Promise<{ id: string }>;
}

/** The complete integration surface the app consumes. */
export interface Adapters {
  visionOcr: VisionOcrAdapter;
  smsGateway: SmsGatewayAdapter;
  delayQueue: DelayQueueAdapter;
}

/** Environment variables the factory reads (subset of NodeJS.ProcessEnv). */
export type Env = NodeJS.ProcessEnv;
