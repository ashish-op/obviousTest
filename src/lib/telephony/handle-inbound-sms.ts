/**
 * Two-way SMS loop — the inbound state machine (PRD §5, build spec "Two-way
 * SMS loop").
 *
 * Orchestration layer: every DECISION here is delegated to the pure engines
 * (parseInboundCommand, resolveEarliestPendingDose, nextDoseStatus,
 * buildSideEffectCheckIns, assessSideEffectReport); this module owns
 * persistence, message dispatch through the SmsGatewayAdapter, and clock
 * injection. The webhook route is a thin wrapper over this function.
 *
 * Unknown senders and unrecognized commands are outcomes, never errors — a
 * forged or confused inbound text must not 500 or mutate state.
 */

import crypto from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { encryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import { hasTwilioCredentials } from '@/lib/adapters';
import type { Adapters, Env } from '@/lib/adapters/types';
import { parseInboundCommand, resolveEarliestPendingDose } from '@/lib/engines/dose-resolution';
import { nextDoseStatus } from '@/lib/engines/escalation';
import {
  assessSideEffectReport,
  buildSideEffectCheckIns,
  parseHighRiskSideEffects,
} from '@/lib/engines/risk-matrix';
import { recordAuditEvent } from '@/lib/audit';
import {
  appendSideEffectCheckIns,
  caregiverSymptomMessage,
  confirmationReply,
  noPendingDoseReply,
  skipReply,
  SMS_SYMPTOM_REPORT_SEVERITY,
  symptomReportAckReply,
  unattributableSymptomReply,
  unknownCommandReply,
  unknownSenderReply,
} from './messages';
import {
  findProfileIdByPhone,
  linkOutboxRowToSchedule,
  loadProfileSmsContext,
  recordInboundSms,
  type SmsDeliveryMode,
} from './outbox';

export interface InboundSmsDeps {
  db: SqliteDb;
  env: Env;
  adapters: Pick<Adapters, 'smsGateway'>;
  /** AES-256-GCM key — profile lookup and sender-envelope encryption. */
  key: Buffer;
  /** Injected clock — never Date.now() inside this module. */
  now: () => Date;
}

export interface InboundSmsInput {
  /** Sender phone (E.164) — Twilio's `From` param. Replies return here. */
  from: string;
  /** Message text — Twilio's `Body` param. */
  body: string;
  /** Twilio's `MessageSid` when present. */
  providerMessageId?: string | null;
}

export type InboundSmsOutcome =
  | { status: 'confirmed'; scheduleId: string }
  | { status: 'skipped'; scheduleId: string }
  | { status: 'symptom_report'; canonicalSymptom: string; affirmed: boolean; scheduleId: string | null }
  | { status: 'no_pending_dose' }
  | { status: 'unknown_command' }
  | { status: 'unknown_sender' };

interface ConfirmableDoseRow {
  id: string;
  scheduled_for: string;
  adherence_status: 'PENDING' | 'ESCALATED';
  generic_name: string;
  dosage: string;
  high_risk_side_effects: string;
}

interface ConfirmedDoseRow {
  id: string;
  medication_id: string;
  generic_name: string;
  high_risk_side_effects: string;
}

export async function handleInboundSms(deps: InboundSmsDeps, input: InboundSmsInput): Promise<InboundSmsOutcome> {
  const { db, adapters, key } = deps;
  const now = deps.now();
  const deliveryMode: SmsDeliveryMode = hasTwilioCredentials(deps.env) ? 'real' : 'fixture';

  const profileId = findProfileIdByPhone(db, input.from, key);
  if (!profileId) {
    // Unknown sender: acknowledge politely, change nothing, leave an audit row.
    recordInboundSms(db, {
      profileId: null,
      senderEnvelope: encryptPhoneNumber(input.from, key),
      body: input.body,
      providerMessageId: input.providerMessageId ?? null,
      deliveryMode,
      now,
    });
    await sendReply(deps, input.from, unknownSenderReply());
    recordAuditEvent(db, {
      action: 'sms_unknown_sender',
      userId: null,
      details: JSON.stringify({ deliveryMode, bodyLength: input.body.length }),
    });
    return { status: 'unknown_sender' };
  }

  // The inbound message itself is part of the loop the console renders.
  recordInboundSms(db, {
    profileId,
    senderEnvelope: encryptPhoneNumber(input.from, key),
    body: input.body,
    providerMessageId: input.providerMessageId ?? null,
    deliveryMode,
    now,
  });

  const command = parseInboundCommand(input.body);

  switch (command.kind) {
    case 'confirm':
    case 'skip':
      return applyDoseCommand(deps, input.from, profileId, command.kind, now);

    case 'symptom_report':
      return applySymptomReport(deps, input.from, profileId, command, now);

    case 'unknown':
      await sendReply(deps, input.from, unknownCommandReply());
      return { status: 'unknown_command' };
  }
}

/** One outbound path for the whole module — every patient/caregiver send + outbox linkage. */
async function sendReply(
  deps: InboundSmsDeps,
  to: string,
  body: string,
  scheduleId?: string,
): Promise<void> {
  const { messageId } = await deps.adapters.smsGateway.send(to, body);
  if (scheduleId) linkOutboxRowToSchedule(deps.db, messageId, scheduleId);
}

/**
 * Confirm/skip the resolved earliest-pending dose. Concurrent doses resolve to
 * the earliest-scheduled pending row (engine rule, deterministic tie-break).
 */
async function applyDoseCommand(
  deps: InboundSmsDeps,
  from: string,
  profileId: string,
  command: 'confirm' | 'skip',
  now: Date,
): Promise<InboundSmsOutcome> {
  const { db, key } = deps;

  const rows = db
    .prepare(
      `SELECT s.id, s.scheduled_for, s.adherence_status, m.generic_name, m.dosage, m.high_risk_side_effects
       FROM daily_schedules s
       JOIN medications m ON m.id = s.medication_id
       WHERE s.profile_id = ? AND s.adherence_status IN ('PENDING', 'ESCALATED')`,
    )
    .all(profileId) as ConfirmableDoseRow[];

  const dose = resolveEarliestPendingDose(
    rows.map((row) => ({
      id: row.id,
      scheduledFor: row.scheduled_for,
      adherenceStatus: row.adherence_status,
    })),
  );

  if (!dose) {
    await sendReply(deps, from, noPendingDoseReply());
    return { status: 'no_pending_dose' };
  }

  const next = nextDoseStatus(dose.adherenceStatus, command);
  if (next === null) {
    // Unreachable through the confirmable filter above (PENDING/ESCALATED only),
    // but the engine contract returns null and a null must never be dropped.
    await sendReply(deps, from, noPendingDoseReply());
    return { status: 'no_pending_dose' };
  }

  const transitionAt = now.toISOString();
  db.prepare(
    `UPDATE daily_schedules
     SET adherence_status = ?, confirmed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(next, command === 'confirm' ? transitionAt : null, transitionAt, dose.id);

  // A resolved dose must not escalate later — cancel its pending job.
  cancelPendingEscalations(db, dose.id);

  const row = rows.find((candidate) => candidate.id === dose.id);
  if (!row) {
    // The resolved id came from these rows; a miss would be a logic error.
    throw new Error(`Resolved dose ${dose.id} missing from confirmable rows`);
  }

  let reply: string;
  if (command === 'confirm') {
    const base = confirmationReply(row.generic_name, row.dosage, row.scheduled_for);
    const checkIns = buildSideEffectCheckIns({
      id: row.id,
      highRiskSideEffects: parseHighRiskSideEffects(row.high_risk_side_effects),
    });
    reply = appendSideEffectCheckIns(base, checkIns);
  } else {
    reply = skipReply(row.generic_name);
  }

  await sendReply(deps, from, reply, dose.id);

  return { status: command === 'confirm' ? 'confirmed' : 'skipped', scheduleId: dose.id };
}

/**
 * Attribute a DIZZY YES/NO report (PRD §5 protocol) to a dose: the most
 * recently confirmed dose whose medication lists the symptom wins; otherwise
 * the most recently confirmed dose of any medication; otherwise unattributed.
 */
async function applySymptomReport(
  deps: InboundSmsDeps,
  from: string,
  profileId: string,
  command: { kind: 'symptom_report'; canonicalSymptom: string; affirmed: boolean },
  now: Date,
): Promise<InboundSmsOutcome> {
  const { db, key } = deps;
  const { canonicalSymptom, affirmed } = command;

  const profile = loadProfileSmsContext(db, profileId, key);
  if (!profile) {
    // Profile vanished between lookup and use — an integrity failure, surfaced.
    throw new Error(`Profile ${profileId} disappeared during symptom handling`);
  }

  // A negative answer is a clean check-in, not a symptom report — acknowledge
  // only. No log row: side_effect_logs carries symptoms, not their absence.
  if (!affirmed) {
    await sendReply(deps, from, symptomReportAckReply(canonicalSymptom, false));
    return { status: 'symptom_report', canonicalSymptom, affirmed, scheduleId: null };
  }

  const confirmed = db
    .prepare(
      `SELECT s.id, s.medication_id, m.generic_name, m.high_risk_side_effects
       FROM daily_schedules s
       JOIN medications m ON m.id = s.medication_id
       WHERE s.profile_id = ? AND s.adherence_status = 'CONFIRMED'
       ORDER BY s.confirmed_at DESC, s.id DESC`,
    )
    .all(profileId) as ConfirmedDoseRow[];

  const matching = confirmed.find((row) =>
    parseHighRiskSideEffects(row.high_risk_side_effects).includes(canonicalSymptom),
  );
  const attributed = matching ?? confirmed[0] ?? null;

  if (attributed) {
    const assessment = assessSideEffectReport({
      symptom: canonicalSymptom,
      severity: SMS_SYMPTOM_REPORT_SEVERITY,
      medication: {
        id: attributed.medication_id,
        highRiskSideEffects: parseHighRiskSideEffects(attributed.high_risk_side_effects),
      },
    });
    db.prepare(
      `INSERT INTO side_effect_logs
         (id, profile_id, medication_id, daily_schedule_id, symptom, severity, reported_via, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sms', ?)`,
    ).run(
      crypto.randomUUID(),
      profileId,
      attributed.medication_id,
      attributed.id,
      assessment.symptom,
      assessment.severity,
      now.toISOString(),
    );
  }

  // Fail-safe routing: an affirmed report always notifies the caregiver —
  // attributed (with dose context) or not (flagged as unlinked).
  if (profile.caregiverPhone) {
    await sendReply(
      deps,
      profile.caregiverPhone,
      caregiverSymptomMessage({
        patientName: profile.fullName,
        canonicalSymptom,
        medicationName: attributed?.generic_name ?? null,
        scheduledFor: attributed?.id ? (attributedDoseScheduledFor(deps.db, attributed.id) ?? null) : null,
      }),
    );
  }

  await sendReply(
    deps,
    from,
    attributed ? symptomReportAckReply(canonicalSymptom, true) : unattributableSymptomReply(canonicalSymptom),
  );

  return { status: 'symptom_report', canonicalSymptom, affirmed, scheduleId: attributed?.id ?? null };
}

/** The scheduled time of an attributed dose, for the caregiver message. */
function attributedDoseScheduledFor(db: SqliteDb, scheduleId: string): string | null {
  const row = db
    .prepare('SELECT scheduled_for FROM daily_schedules WHERE id = ?')
    .get(scheduleId) as { scheduled_for: string } | undefined;
  return row?.scheduled_for ?? null;
}

function cancelPendingEscalations(db: SqliteDb, dailyScheduleId: string): void {
  db.prepare(
    `UPDATE escalation_jobs SET status = 'cancelled'
     WHERE daily_schedule_id = ? AND status = 'pending'`,
  ).run(dailyScheduleId);
}
