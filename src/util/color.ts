/**
 * Minimal ANSI colouring for CLI output, using the Altera palette.
 * Disabled automatically when piping, when NO_COLOR is set, or with --no-color.
 */
const PALETTE = {
  text: [207, 227, 230],
  muted: [92, 122, 128],
  gold: [232, 199, 122],
  bronze: [184, 135, 60],
  cyan: [43, 217, 232],
  green: [91, 217, 138],
  amber: [240, 167, 60],
  red: [226, 86, 74],
  dim: [70, 90, 96],
} as const;

export type ColorName = keyof typeof PALETTE;

function detect(): boolean {
  if (process.env.NO_COLOR || process.env.ALTERAN_NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

let enabled = detect();
/** Explicit override (CLI --no-color, tests). */
export const setColorEnabled = (v: boolean) => (enabled = v);
export const colorEnabled = () => enabled;

function wrap(name: ColorName, text: string, bold = false): string {
  if (!enabled || !text) return text;
  const [r, g, b] = PALETTE[name];
  return `\u001b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\u001b[0m`;
}

export const paint = {
  text: (s: string) => wrap('text', s),
  muted: (s: string) => wrap('muted', s),
  gold: (s: string) => wrap('gold', s),
  bronze: (s: string) => wrap('bronze', s),
  cyan: (s: string) => wrap('cyan', s),
  green: (s: string) => wrap('green', s),
  amber: (s: string) => wrap('amber', s),
  red: (s: string) => wrap('red', s),
  dim: (s: string) => wrap('dim', s),
  bold: (s: string) => wrap('text', s, true),
  title: (s: string) => wrap('gold', s, true),
  head: (s: string) => wrap('bronze', s, true),
};

/** Section header: "-- TITLE ------------------". */
export function section(title: string, width = 60): string {
  const left = `-- ${title} `;
  return paint.head(left) + paint.dim('-'.repeat(Math.max(0, width - left.length)));
}

export const mark = {
  on: () => paint.green('[#]'),
  partial: () => paint.amber('[/]'),
  off: () => paint.dim('[ ]'),
  bad: () => paint.red('[!]'),
};
