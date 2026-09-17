/**
 * The physician advocacy PDF (PRD §7) — a @react-pdf/renderer document.
 *
 * Styles are the PRD §7 contract exactly: 16pt body, red left-border symptom
 * flags, and — closed by the clinical notice — three sections: dose timeline,
 * side effects with reconciliation prompts, and detected chemical/absorption
 * conflicts with buffer minutes. Accent colors are the PRD §6 Voyager hex
 * values; the page itself is print-white.
 *
 * This is presentational only: it renders `ReconciliationPdfData` and makes
 * no clinical decisions. Every report is an administrative tracking and
 * advocacy summary — nothing here recommends, alters, or validates a
 * prescription (build-spec scope invariant).
 */

import React from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { SideEffectTimelineEntry } from '@/lib/engines/red-flag-timeline';
import {
  adherenceStatusLabel,
  bufferTypeLabel,
  formatDateLabel,
  formatTimeLabel,
  type ReconciliationPdfData,
} from './data';

/** PRD §7: 16pt body text — a named constant so the test pins the contract. */
export const PDF_BODY_FONT_SIZE = 16;

/** PRD §6 Voyager accents used by the report. */
export const PDF_COLORS = {
  lavender: '#9999cc',
  redAlert: '#ff3300',
  softTan: '#ffcc99',
  deepSpaceBlack: '#000000',
} as const;

export const SECTION_TITLE_TIMELINE = 'Dose Timeline';
export const SECTION_TITLE_SIDE_EFFECTS = 'Side Effects';
export const SECTION_TITLE_CONFLICTS = 'Detected Timing Conflicts';
export const SECTION_TITLE_NOTICE = 'Clinical Notice';

/** The scope-invariant notice that closes every report (PRD §7, §8). */
export const CLINICAL_NOTICE =
  'This report is an administrative tracking and advocacy summary compiled from ' +
  'patient-entered and SMS-reported data. It does not diagnose conditions and it ' +
  'does not recommend, alter, or validate any prescription or dosage. Only a ' +
  'licensed physician or pharmacist can make medication decisions — review this ' +
  'report with them during medication reconciliation.';

export const PDF_STYLES = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: PDF_BODY_FONT_SIZE,
    fontFamily: 'Helvetica',
    color: PDF_COLORS.deepSpaceBlack,
  },
  title: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 2,
  },
  rule: {
    height: 4,
    backgroundColor: PDF_COLORS.lavender,
    marginBottom: 10,
  },
  meta: {
    fontSize: 12,
    marginBottom: 2,
  },
  header: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    marginTop: 14,
    marginBottom: 8,
    borderTopWidth: 2,
    borderTopColor: PDF_COLORS.lavender,
    paddingTop: 6,
  },
  timelineRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  timelineTime: {
    width: 64,
  },
  timelineStatus: {
    marginLeft: 'auto',
    paddingLeft: 12,
  },
  flagBox: {
    // PRD §7: symptom flags carry a red left border.
    borderLeftWidth: 3,
    borderLeftColor: PDF_COLORS.redAlert,
    paddingLeft: 10,
    marginBottom: 8,
  },
  flagLine: {
    fontFamily: 'Helvetica-Bold',
  },
  prompt: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  conflictRow: {
    marginBottom: 6,
  },
  noticeBox: {
    marginTop: 16,
    borderWidth: 2,
    borderColor: PDF_COLORS.softTan,
    padding: 12,
    fontSize: 14,
  },
  noticeTitle: {
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  emptyRow: {
    fontStyle: 'italic',
  },
});

/** Dosage lookup by generic name, for timeline rows. */
function dosageFor(data: ReconciliationPdfData, medicationName: string): string {
  const match = data.medications.find((med) => med.genericName === medicationName);
  return match ? match.dosage : '';
}

function TimelineEntry({ entry, data }: { entry: SideEffectTimelineEntry; data: ReconciliationPdfData }) {
  const dosage = dosageFor(data, entry.medicationName);
  const checkIn =
    entry.checkInState === null
      ? ''
      : entry.checkInState === 'outstanding'
        ? ' · check-in outstanding'
        : entry.checkInState === 'clean'
          ? ' · check-in clean'
          : ' · red flag';
  return (
    <View style={PDF_STYLES.timelineRow}>
      <Text style={PDF_STYLES.timelineTime}>{formatTimeLabel(entry.scheduledFor)}</Text>
      <Text>
        {entry.medicationName}
        {dosage ? ` — ${dosage}` : ''} · {adherenceStatusLabel(entry.adherenceStatus)}
        {checkIn}
      </Text>
    </View>
  );
}

/** One logged symptom: red left-border box for flags, plain line otherwise. */
function SymptomEntry({
  log,
  medicationName,
}: {
  log: SideEffectTimelineEntry['logs'][number];
  medicationName: string;
}) {
  if (!log.isRedFlag) {
    return (
      <Text style={PDF_STYLES.meta}>
        {medicationName}: {log.symptom} — severity {log.severity}/5 (reported {formatDateLabel(log.reportedAt)})
      </Text>
    );
  }
  return (
    <View style={PDF_STYLES.flagBox} wrap={false}>
      <Text style={PDF_STYLES.flagLine}>
        {medicationName}: {log.symptom} — severity {log.severity}/5 (reported {formatDateLabel(log.reportedAt)})
      </Text>
      <Text style={PDF_STYLES.prompt}>{log.reconciliationPrompt}</Text>
    </View>
  );
}

export function ReconciliationReportDocument({ data }: { data: ReconciliationPdfData }) {
  return (
    <Document title="Medication Reconciliation Report" subject="Physician advocacy report">
      <Page size="LETTER" style={PDF_STYLES.page}>
        <View style={PDF_STYLES.header}>
          <Text style={PDF_STYLES.title}>Medication Reconciliation Report</Text>
          <View style={PDF_STYLES.rule} />
          <Text style={PDF_STYLES.meta}>Patient: {data.patientName}</Text>
          <Text style={PDF_STYLES.meta}>Generated: {formatDateLabel(data.generatedAt)} (UTC)</Text>
        </View>

        <Text style={PDF_STYLES.sectionTitle}>{SECTION_TITLE_TIMELINE}</Text>
        {data.timeline.entries.map((entry) => (
          <TimelineEntry key={entry.scheduleId} entry={entry} data={data} />
        ))}

        <Text style={PDF_STYLES.sectionTitle}>{SECTION_TITLE_SIDE_EFFECTS}</Text>
        {data.timeline.entries.flatMap((entry) =>
          entry.logs.map((log) => (
            <SymptomEntry key={log.id} log={log} medicationName={entry.medicationName} />
          )),
        )}
        {data.timeline.entries.every((entry) => entry.logs.length === 0) && (
          <Text style={PDF_STYLES.emptyRow}>No side effects reported.</Text>
        )}

        <Text style={PDF_STYLES.sectionTitle}>{SECTION_TITLE_CONFLICTS}</Text>
        {data.conflicts.map((conflict) => (
          <View key={`${conflict.medicationA}-${conflict.medicationB}`} style={PDF_STYLES.conflictRow} wrap={false}>
            <Text>
              {conflict.medicationA} + {conflict.medicationB} — {bufferTypeLabel(conflict.bufferType)} buffer:{' '}
              {conflict.minBufferMinutes} minutes apart
            </Text>
          </View>
        ))}
        {data.conflicts.length === 0 && (
          <Text style={PDF_STYLES.emptyRow}>No seeded interaction conflicts among current medications.</Text>
        )}

        <Text style={PDF_STYLES.sectionTitle}>{SECTION_TITLE_NOTICE}</Text>
        <View style={PDF_STYLES.noticeBox} wrap={false}>
          <Text style={PDF_STYLES.noticeTitle}>CLINICAL NOTICE</Text>
          <Text>{CLINICAL_NOTICE}</Text>
        </View>
      </Page>
    </Document>
  );
}
