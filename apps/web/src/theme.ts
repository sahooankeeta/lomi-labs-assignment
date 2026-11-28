import {
  Badge,
  Blockquote,
  Button,
  Card,
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  Modal,
  Tabs,
} from '@mantine/core';

/**
 * The pastel dashboard palette (cream page, black ink, pink/blue/yellow/green pastels).
 * Pastels are only ever backgrounds under `palette.ink` text, which keeps contrast far above
 * 4.5:1; they are never used as text colours themselves.
 */
export const palette = {
  /** Page background. */
  cream: '#F6F1E7',
  /** The large rounded panel the app sits in. */
  panel: '#FBF8F2',
  /** Card surface: warm light grey. */
  surface: '#ECE7DE',
  /** Hairline borders on the cream/surface tones. */
  line: '#DDD5C7',
  /** Near-black for text (and text only: dark backgrounds use `charcoal`). */
  ink: '#111111',
  /**
   * Warm charcoal for every dark background: the sidebar, the table header bar, primary pill
   * buttons and active tabs. Softer than `ink` against the cream page (the owner found pure
   * black too harsh); cream text on it is 12.5:1.
   */
  charcoal: '#2E2B27',
  /** Muted text on cream and pastels (still ≥ 4.5:1 on all of them). */
  muted: '#55514A',
  blush: '#F4B8D8',
  sky: '#B9CCEC',
  butter: '#F6DC7A',
  sage: '#9DC07A',
  /** Failure pill: a pastel red, still under ink text. */
  rose: '#F2B4AA',
} as const;

/**
 * Review-status pill colours (see `components/ReviewStatusPill.tsx`). Text/background contrast
 * (WCAG, computed): queued 13.03, extracting 13.88 (butter), failed 7.39 (dark red text),
 * in review 11.41 (blush), approved 9.22 (sage); all well above the 4.5:1 minimum.
 */
export const reviewColors = {
  queued: { bg: '#DAD6CE', fg: palette.ink },
  extracting: { bg: palette.butter, fg: palette.ink },
  failed: { bg: '#F7C9C4', fg: '#7A1010' },
  in_review: { bg: palette.blush, fg: palette.ink },
  approved: { bg: palette.sage, fg: palette.ink },
} as const;

/**
 * Document-type pill colours: cooler, lighter tints than the status pastels, with dark text in
 * the same hue. Contrast: invoice 9.23, lease 8.09, market report 8.53 (all >= 4.5:1).
 */
export const typeColors = {
  invoice: { bg: '#D3E6F7', fg: '#0F3A5C' },
  lease: { bg: '#CFECE7', fg: '#0B4A44' },
  market_report: { bg: '#E0D8F4', fg: '#3E2A75' },
} as const;

// Index 6 is what `filled` buttons (and active pill tabs) use, so it is the charcoal: Mantine's
// primary button becomes the dark pill without overriding every Button. 7+ are the hover shades.
const ink: MantineColorsTuple = [
  '#F4F2EE',
  '#E6E2DA',
  '#CFC9BE',
  '#A8A196',
  '#7A746A',
  '#4A4640',
  '#2E2B27',
  '#24211E',
  '#1C1A17',
  '#141210',
];

/** Mantine theme for the review UI: ink primary colour, pill buttons, soft rounded cards. */
export const theme = createTheme({
  primaryColor: 'ink',
  colors: { ink },
  black: palette.ink,
  // System stack (Inter first if the machine has it): no font dependency is added.
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  headings: {
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '2.5rem', lineHeight: '1.1' },
      h2: { fontSize: '1.75rem', lineHeight: '1.2' },
    },
  },
  defaultRadius: 'md',
  radius: { md: '12px', lg: '16px', xl: '24px' },
  // Keep Mantine's keyboard focus ring (shown on :focus-visible); the restyle must not hide it.
  focusRing: 'auto',
  components: {
    Button: Button.extend({ defaultProps: { radius: 'xl' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'xl', tt: 'none' } }),
    Card: Card.extend({
      defaultProps: { radius: 'lg', bg: palette.surface, shadow: 'none' },
    }),
    Tabs: Tabs.extend({ defaultProps: { variant: 'pills', radius: 'xl' } }),
    Blockquote: Blockquote.extend({ defaultProps: { color: 'ink', radius: 'md' } }),
    Modal: Modal.extend({ defaultProps: { radius: 'lg' } }),
  },
});

/** Sets the page (body) colour to cream; the app has no dark mode, so only light is set. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--sidebar-bg': palette.charcoal,
    '--mantine-color-body': palette.cream,
    '--mantine-color-text': palette.ink,
    '--mantine-color-dimmed': palette.muted,
    // Mantine's grey disabled fill vanishes on the warm surface; a warmer, darker pair keeps
    // disabled buttons (e.g. "Upload" before a file is chosen) visible.
    '--mantine-color-disabled': '#DCD5C8',
    '--mantine-color-disabled-color': '#6B655B',
  },
  dark: {},
});
