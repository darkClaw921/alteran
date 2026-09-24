/**
 * Terminal notifications.
 *
 * Nothing here is on by default: a terminal that beeps or bounces its dock icon without being asked
 * is worse than one that stays quiet, and the user is usually sitting right in front of it. Two
 * signals are used, because neither is universal — OSC 9 is desktop notifications (iTerm2, WezTerm,
 * kitty, Windows Terminal), and BEL is the one every terminal has.
 */
export interface NotifyConfig {
  /** `bell` rings the terminal, `osc9` asks the terminal for a desktop notification, `off` is silent. */
  mode?: 'off' | 'bell' | 'osc9';
  /** A turn shorter than this is not worth announcing — the user never looked away. */
  minMs?: number;
}

const DEFAULTS = { mode: 'off' as const, minMs: 15_000 };

export function notifyConfig(cfg: NotifyConfig | undefined): { mode: 'off' | 'bell' | 'osc9'; minMs: number } {
  return { mode: cfg?.mode ?? DEFAULTS.mode, minMs: cfg?.minMs ?? DEFAULTS.minMs };
}

/**
 * The sequence for one notification, or undefined when it should stay quiet. Kept as a pure
 * function of (config, elapsed, what happened) so the decision is testable — the alternative is
 * asserting on escape codes written to a stream, which tests the wrong thing.
 */
export function notification(
  cfg: NotifyConfig | undefined,
  event: { kind: 'turn' | 'agent'; elapsedMs: number; title: string; body: string },
): string | undefined {
  const { mode, minMs } = notifyConfig(cfg);
  if (mode === 'off') return undefined;
  if (event.elapsedMs < minMs) return undefined;
  if (mode === 'bell') return '\u0007';
  // OSC 9: ESC ] 9 ; message BEL. Terminals that do not know it ignore the whole sequence, so a
  // notification never corrupts the screen — it simply does nothing.
  const text = event.body ? `${event.title}: ${event.body}` : event.title;
  return `\u001b]9;${text.replace(/[\u0007\u001b]/g, '')}\u0007`;
}
