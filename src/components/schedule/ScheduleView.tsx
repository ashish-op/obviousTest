'use client';

import { useMemo, useState } from 'react';
import { DataValue } from '@/components/lcars/DataValue';
import { LcarsPanel } from '@/components/lcars/LcarsPanel';
import { StatusPill, type LcarsStatus } from '@/components/lcars/StatusPill';
import type { AdherenceStatus } from '@/lib/engines/types';
import type { ScheduleDoseRecord } from '@/lib/schedules/repository';
import type { ScheduleSettings } from '@/lib/schedules/settings';
import { instantClock } from '@/lib/schedules/clock';
import './schedule.css';

/**
 * Daily schedule view (PRD §4 UI): dose rows with status pills, the
 * "Woke up late" one-tap routine shift, deferred markers where buffers
 * displaced doses, and the gold past-bedtime warning. Server-rendered
 * initial data; every mutation POSTs to the schedule API and renders the
 * authoritative response, so the view always mirrors persisted state.
 */

/** Adherence status → LCARS pill status (PRD §6 pairing). Pure, exported for tests. */
export function statusToPillStatus(status: AdherenceStatus): LcarsStatus {
  switch (status) {
    case 'PENDING':
      return 'pending';
    case 'CONFIRMED':
      return 'confirmed';
    case 'ESCALATED':
      return 'alert';
    case 'SKIPPED':
      return 'info';
  }
}

/** A dose is actionable while unresolved (PRD §2 lifecycle). */
function isTransitionable(status: AdherenceStatus): boolean {
  return status === 'PENDING' || status === 'ESCALATED';
}

/** Deferred marker copy — why a dose sits later than its anchor. */
export function deferredMarkerText(reason: ScheduleDoseRecord['deferredReason']): string | null {
  switch (reason) {
    case 'buffer_push':
      return 'deferred — buffer separation';
    case 'wake_shift':
      return 'moved by wake shift';
    default:
      return null;
  }
}

interface ScheduleViewProps {
  initialDoses: readonly ScheduleDoseRecord[];
  initialSettings: ScheduleSettings;
}

interface MutationResponse {
  ok: boolean;
  doses?: ScheduleDoseRecord[];
  settings?: ScheduleSettings;
}

export function ScheduleView({ initialDoses, initialSettings }: ScheduleViewProps) {
  const [doses, setDoses] = useState<ScheduleDoseRecord[]>([...initialDoses]);
  const [settings, setSettings] = useState<ScheduleSettings>(initialSettings);
  const [wakeInput, setWakeInput] = useState<string>(initialSettings.wakeTime);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedDoses = useMemo(
    () =>
      [...doses].sort(
        (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.id.localeCompare(b.id),
      ),
    [doses],
  );

  const actionableCount = doses.filter((dose) => isTransitionable(dose.adherenceStatus)).length;
  const bedtimeWarnings = doses.filter((dose) => dose.isPastBedtimeWarning).length;

  async function postJson(url: string, body: unknown, operation: string): Promise<MutationResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `${operation} failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload as MutationResponse;
  }

  async function runMutation(operation: string, action: () => Promise<MutationResponse>): Promise<void> {
    setBusy(operation);
    setError(null);
    try {
      const payload = await action();
      if (payload.doses) setDoses(payload.doses);
      if (payload.settings) setSettings(payload.settings);
    } catch (cause) {
      // Surface the failure; never swallow it — the patient must see errors.
      setError(cause instanceof Error ? cause.message : `${operation} failed`);
    } finally {
      setBusy(null);
    }
  }

  function shiftSchedule() {
    if (!wakeInput) {
      setError('Enter the new wake time first.');
      return;
    }
    void runMutation('shift', () =>
      postJson('/api/schedule/shift', { wakeTime: wakeInput }, 'Schedule shift'),
    );
  }

  function regenerate() {
    void runMutation('regenerate', () =>
      postJson('/api/schedule/regenerate', {}, 'Schedule rebuild'),
    );
  }

  function transition(scheduleId: string, action: 'confirm' | 'skip') {
    void runMutation(`${action}:${scheduleId}`, () =>
      postJson(`/api/schedule/doses/${scheduleId}`, { action }, 'Dose update'),
    );
  }

  if (doses.length === 0) {
    return (
      <div className="lcars-schedule" data-testid="schedule-empty">
        <p className="lcars-schedule__empty">
          No doses scheduled yet. Add medications on the scanner page — the
          day plan is derived from each prescription&apos;s instructions.
        </p>
        <nav className="lcars-page__nav" aria-label="Related surfaces">
          <a href="/scanner">Open scanner →</a>
        </nav>
      </div>
    );
  }

  return (
    <div className="lcars-schedule">
      <LcarsPanel label="Day anchors" tone="ice">
        <div className="lcars-schedule__anchors">
          <DataValue label="Wake" value={settings.wakeTime} />
          <DataValue label="Bedtime" value={settings.bedtime} />
          <DataValue label="Unresolved doses" value={actionableCount} unit={`of ${doses.length}`} />
        </div>
      </LcarsPanel>

      <div className="lcars-schedule__controls">
        <label className="lcars-schedule__wake-label" htmlFor="wake-input">
          Woke up at
        </label>
        <input
          id="wake-input"
          type="time"
          value={wakeInput}
          onChange={(event) => setWakeInput(event.target.value)}
          data-testid="wake-input"
        />
        <button
          type="button"
          onClick={shiftSchedule}
          disabled={busy !== null}
          data-testid="shift-button"
          className="lcars-button lcars-button--gold lcars-schedule__shift-button"
        >
          {busy === 'shift' ? 'Shifting…' : 'Woke up late — shift schedule'}
        </button>
        <button
          type="button"
          onClick={regenerate}
          disabled={busy !== null}
          data-testid="regenerate-button"
          className="lcars-button lcars-schedule__regen-button"
        >
          {busy === 'regenerate' ? 'Rebuilding…' : 'Rebuild from medication list'}
        </button>
      </div>

      {error ? (
        <p className="lcars-schedule__error" role="alert" data-testid="schedule-error">
          {error}
        </p>
      ) : null}
      {bedtimeWarnings > 0 ? (
        <p className="lcars-schedule__bedtime-banner" data-testid="bedtime-banner">
          {bedtimeWarnings} dose{bedtimeWarnings === 1 ? '' : 's'} land past bedtime — review below.
        </p>
      ) : null}

      <ol className="lcars-schedule__list" data-testid="dose-list">
        {sortedDoses.map((dose) => (
          <li
            key={dose.id}
            className={`lcars-schedule__row${dose.isPastBedtimeWarning ? ' lcars-schedule__row--late' : ''}`}
            data-testid="dose-row"
            data-status={dose.adherenceStatus}
          >
            <span className="lcars-schedule__time">{instantClock(dose.scheduledFor)}</span>
            <div className="lcars-schedule__med">
              <span className="lcars-schedule__name">
                {dose.medicationName}
                {dose.brandName ? ` (${dose.brandName})` : ''}
              </span>
              <span className="lcars-schedule__dosage">{dose.dosage}</span>
              {dose.deferredReason ? (
                <span className="lcars-schedule__deferred" data-testid="deferred-marker">
                  {deferredMarkerText(dose.deferredReason)}
                </span>
              ) : null}
              {dose.isPastBedtimeWarning ? (
                <span className="lcars-schedule__bedtime" data-testid="bedtime-warning">
                  past bedtime
                </span>
              ) : null}
            </div>
            <div className="lcars-schedule__status">
              <StatusPill status={statusToPillStatus(dose.adherenceStatus)}>
                {dose.adherenceStatus.toLowerCase()}
              </StatusPill>
              {isTransitionable(dose.adherenceStatus) ? (
                <div className="lcars-schedule__actions">
                  <button
                    type="button"
                    className="lcars-button lcars-schedule__confirm-button"
                    onClick={() => transition(dose.id, 'confirm')}
                    disabled={busy !== null}
                    data-testid={`confirm-${dose.id}`}
                  >
                    {busy === `confirm:${dose.id}` ? '…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="lcars-button lcars-button--alert lcars-schedule__skip-button"
                    onClick={() => transition(dose.id, 'skip')}
                    disabled={busy !== null}
                    data-testid={`skip-${dose.id}`}
                  >
                    {busy === `skip:${dose.id}` ? '…' : 'Skip'}
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
