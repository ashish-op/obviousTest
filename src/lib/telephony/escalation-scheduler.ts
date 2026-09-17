/**
 * Escalation scheduling (PRD §5: unconfirmed dose → caregiver at +45 min).
 *
 * The +45-minute math lives in the pure escalation engine; this service
 * wrapper persists the plan through the DelayQueueAdapter as a durable
 * escalation_jobs row. Future dose-creation routes (OCR ingestion, schedule
 * regeneration) call this per dose; the sweep's ensure pass backfills any
 * dose that slips through without one.
 */

import type { DelayQueueAdapter } from '@/lib/adapters/types';
import { planEscalation } from '@/lib/engines/escalation';

export interface EscalationEnqueueResult {
  jobId: string;
  deliverAt: string;
}

export async function enqueueDoseEscalation(
  delayQueue: DelayQueueAdapter,
  dose: { id: string; scheduledFor: string },
  profileId: string,
): Promise<EscalationEnqueueResult> {
  const plan = planEscalation({ id: dose.id }, dose.scheduledFor);
  const { id } = await delayQueue.enqueue(
    { dailyScheduleId: dose.id, profileId },
    new Date(plan.deliverAt),
  );
  return { jobId: id, deliverAt: plan.deliverAt };
}
