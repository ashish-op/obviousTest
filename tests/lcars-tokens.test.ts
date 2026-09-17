import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the LCARS token file to the PRD §6 Voyager palette table
 * (build spec art_GJnhfsve). The palette is a PRD constant, not a design
 * judgment — change hexes only together with the token file.
 */

const TOKENS_CSS = readFileSync(
  path.resolve(__dirname, '../src/styles/lcars-tokens.css'),
  'utf8',
);

const PRD_PALETTE: Record<string, string> = {
  '--lcars-lavender': '#9999cc',
  '--lcars-mauve': '#cc99cc',
  '--lcars-warp-gold': '#ff9900',
  '--lcars-red-alert': '#ff3300',
  '--lcars-deep-space-black': '#000000',
  '--lcars-soft-tan': '#ffcc99',
  '--lcars-ice-blue': '#99ccff',
};

const DARK_SEMANTIC_TOKENS = [
  '--lcars-surface',
  '--lcars-surface-raised',
  '--lcars-ink',
  '--lcars-ink-muted',
  '--lcars-ink-on-accent',
  '--lcars-ink-on-alert',
  '--lcars-frame-accent',
  '--lcars-panel-accent',
  '--lcars-status-pending',
  '--lcars-status-alert',
  '--lcars-status-confirmed',
  '--lcars-status-info',
  '--lcars-data-value',
];

const LIGHT_OVERRIDES = [
  '--lcars-surface',
  '--lcars-surface-raised',
  '--lcars-ink',
  '--lcars-ink-muted',
  '--lcars-data-value',
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove block comments so prose mentioning a selector can't match. */
function stripCssComments(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Body of the `{ ... }` block whose selector appears at line start. */
function cssBlock(selector: string, cssText: string): string {
  const escaped = escapeRegex(selector);
  const match = stripCssComments(cssText).match(
    new RegExp(`^\\s*${escaped}[^{]*{([^}]*)}`, 'm'),
  );
  if (!match) throw new Error(`CSS block not found for selector: ${selector}`);
  return match[1];
}

function tokenValue(block: string, name: string): string | null {
  const match = block.match(new RegExp(`${escapeRegex(name)}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

describe('LCARS tokens — PRD §6 palette contract', () => {
  it('defines every palette token at the exact PRD hex', () => {
    const rootBlock = cssBlock(':root', TOKENS_CSS);
    for (const [name, hex] of Object.entries(PRD_PALETTE)) {
      expect(tokenValue(rootBlock, name), `${name} must be ${hex}`).toBe(hex);
    }
  });

  it('defines each of the seven PRD palette tokens exactly once', () => {
    for (const name of Object.keys(PRD_PALETTE)) {
      const definitions = TOKENS_CSS.match(
        new RegExp(`${escapeRegex(name)}\\s*:`, 'g'),
      );
      expect(
        definitions?.length ?? 0,
        `${name} must have exactly one definition`,
      ).toBe(1);
    }
  });

  it('anchors the dark default surface to Deep Space Black', () => {
    const rootBlock = cssBlock(':root', TOKENS_CSS);
    expect(tokenValue(rootBlock, '--lcars-surface')).toBe(
      'var(--lcars-deep-space-black)',
    );
  });

  it('defines the full semantic token set for the dark default theme', () => {
    const rootBlock = cssBlock(':root', TOKENS_CSS);
    for (const name of DARK_SEMANTIC_TOKENS) {
      expect(tokenValue(rootBlock, name), `${name} missing in :root`).not.toBeNull();
    }
  });

  it('provides light-theme overrides so primitives render legibly on light surfaces', () => {
    const lightBlock = cssBlock("[data-theme='light']", TOKENS_CSS);
    for (const name of LIGHT_OVERRIDES) {
      expect(
        tokenValue(lightBlock, name),
        `${name} missing in [data-theme='light']`,
      ).not.toBeNull();
    }
  });

  it('keeps the PRD palette hexes out of the light-theme override block', () => {
    const lightBlock = cssBlock("[data-theme='light']", TOKENS_CSS);
    for (const name of Object.keys(PRD_PALETTE)) {
      // The palette must never be redefined per theme — it is the brand.
      expect(
        tokenValue(lightBlock, name),
        `${name} must not be overridden per theme`,
      ).toBeNull();
    }
  });
});
