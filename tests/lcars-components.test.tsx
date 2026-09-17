// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataValue } from '@/components/lcars/DataValue';
import { DisclaimerModal } from '@/components/lcars/DisclaimerModal';
import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { LcarsPanel } from '@/components/lcars/LcarsPanel';
import { StatusPill, statusPillClass } from '@/components/lcars/StatusPill';

const SESSION_KEY = 'sickbay.disclaimer.acknowledged.v1';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('LCARS primitives — presentational contract', () => {
  it('LcarsFrame renders labels, children, and the elbow class', () => {
    render(
      <LcarsFrame topLabel="Sickbay" bottomLabel="End transmission" elbow="right">
        <p>frame body</p>
      </LcarsFrame>,
    );
    expect(screen.getByText('Sickbay')).toBeTruthy();
    expect(screen.getByText('End transmission')).toBeTruthy();
    expect(screen.getByText('frame body')).toBeTruthy();
    const frame = screen.getByText('frame body').closest('.lcars-frame');
    expect(frame?.className).toContain('lcars-frame--elbow-right');
  });

  it('LcarsPanel renders its label and tone class', () => {
    render(
      <LcarsPanel label="Buffer watch" tone="gold">
        <p>panel body</p>
      </LcarsPanel>,
    );
    expect(screen.getByText('Buffer watch')).toBeTruthy();
    expect(screen.getByText('panel body').closest('.lcars-panel')?.className).toContain(
      'lcars-panel--gold',
    );
  });

  it('StatusPill maps statuses to the gold/red token classes', () => {
    expect(statusPillClass('pending')).toBe('lcars-status-pill--pending');
    expect(statusPillClass('alert')).toBe('lcars-status-pill--alert');
    expect(statusPillClass('confirmed')).toBe('lcars-status-pill--confirmed');
    expect(statusPillClass('info')).toBe('lcars-status-pill--info');
  });

  it('StatusPill renders gold pending and red alert variants (PRD §6 pairing)', () => {
    render(
      <>
        <StatusPill status="pending" />
        <StatusPill status="alert">buffer conflict</StatusPill>
      </>,
    );
    const pending = screen.getByText('pending');
    expect(pending.className).toContain('lcars-status-pill--pending');
    const alert = screen.getByText('buffer conflict');
    expect(alert.className).toContain('lcars-status-pill--alert');
  });

  it('DataValue renders label, value, and optional unit', () => {
    render(<DataValue label="Calcium gap" value="2.0" unit="hours" />);
    expect(screen.getByText('Calcium gap')).toBeTruthy();
    expect(screen.getByText('2.0')).toBeTruthy();
    expect(screen.getByText('hours')).toBeTruthy();
  });
});

describe('DisclaimerModal — gate, audit, once per session', () => {
  it('fails closed: the dialog gates the shell and children do not mount until acknowledged', () => {
    render(
      <DisclaimerModal>
        <div>shell content</div>
      </DisclaimerModal>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Hard gate: the shell is not rendered at all below an unacknowledged modal.
    expect(screen.queryByText('shell content')).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('records the audit event, sets the session flag, then releases the shell', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <DisclaimerModal>
        <div>shell content</div>
      </DisclaimerModal>,
    );
    fireEvent.click(screen.getByRole('button', { name: /enter sickbay/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/audit/disclaimer-ack', {
      method: 'POST',
    });
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('1');
    expect(screen.getByText('shell content')).toBeTruthy();
  });

  it('stays open with an alert when the audit write fails — the flag is only set once audited', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('audit write failed (HTTP 500)'));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <DisclaimerModal>
        <div>shell content</div>
      </DisclaimerModal>,
    );
    fireEvent.click(screen.getByRole('button', { name: /enter sickbay/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('audit write failed');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('does not re-gate a session that already acknowledged', () => {
    window.sessionStorage.setItem(SESSION_KEY, '1');
    render(
      <DisclaimerModal>
        <div>shell content</div>
      </DisclaimerModal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('shell content')).toBeTruthy();
  });
});
