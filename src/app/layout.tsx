import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sickbay — Medication Companion',
  description:
    'Buffer-aware daily medication scheduling with SMS adherence and physician reconciliation reporting. Administrative tracking tool only — not a medical device.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
