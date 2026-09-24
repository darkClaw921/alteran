/**
 * Altera Terminal palette (design/altera-terminal.html), tuned for readability on dark terminals.
 * The design's decorative greys sit at ~1.4:1 against the background, which is unreadable in a real
 * terminal, so `dim`/`rule` are lifted to ~3:1 and a high-contrast variant is available.
 */
export const C = {
  bg: '#05080A',
  panel: '#0A1014',
  text: '#CFE3E6',
  muted: '#6E8F96',
  gold: '#E8C77A',
  bronze: '#B8873C',
  rule: '#8A6A38',
  cyan: '#2BD9E8',
  green: '#5BD98A',
  amber: '#F0A73C',
  red: '#E2564A',
  dim: '#486F7C',
  /** Column separators between the panels and the console. */
  divider: '#436873',
};

export type Color = string;

export type ThemeName = 'dark' | 'contrast' | 'design';

const THEMES: Record<ThemeName, Partial<typeof C>> = {
  // Readable default: decorative colors lifted to ≥3:1 contrast.
  dark: {},
  // For low-contrast displays / bright rooms.
  contrast: {
    panel: '#0D161B',
    text: '#E6F2F4',
    muted: '#8FB2B9',
    rule: '#B08A4A',
    dim: '#6B93A0',
    divider: '#4E7280',
    bronze: '#D3A254',
  },
  // Exactly the mockup's values — pretty in a screenshot, dim in a terminal.
  design: {
    muted: '#5C7A80',
    rule: '#5E4623',
    dim: '#162A32',
    divider: '#162A32',
  },
};

export function applyTheme(name: ThemeName | undefined) {
  const theme = THEMES[name ?? 'dark'] ?? {};
  Object.assign(C, THEMES.dark, theme);
}

/** Colour per context section, shared by the VIRES meter and the /context report. */
export const CONTEXT_COLORS: Record<string, string> = {
  system: C.gold,
  instructions: C.bronze,
  catalog: C.cyan,
  tools: C.green,
  mcp: C.amber,
  messages: C.text,
  free: C.dim,
};

export const LEFT_WIDTH = 46;
export const RIGHT_WIDTH = 50;
/** Terminal widths below which side panels collapse. */
export const SHOW_LEFT_MIN = 158;
export const SHOW_RIGHT_MIN = 108;

export const SPINNER_VERBS = [
  'Dialing',
  'Locking chevron',
  'Engaging',
  'Calibrating',
  'Aligning glyphs',
  'Transmitting',
  'Stabilizing wormhole',
  'Consulting the Ancients',
];
