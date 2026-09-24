/**
 * How much the interface is allowed to move.
 *
 * `full` is the boot animation and the animated start screen. `reduced` keeps every piece of
 * information — the gate, the chevrons marking stages, the meters — but draws it still, for people
 * who find moving text hard to read, and for terminals that are being recorded or screen-read.
 * `off` is the same, spelled as an explicit choice; nothing in the app animates either way.
 *
 * The environment wins over settings so that `NO_MOTION=1 alteran` works before any config is
 * touched — the convention most tools already follow.
 */
export type MotionLevel = 'full' | 'reduced' | 'off';

export interface MotionSettings {
  motion?: MotionLevel;
  intro?: boolean;
}

export function motionLevel(settings: MotionSettings = {}, env: NodeJS.ProcessEnv = process.env): MotionLevel {
  const explicit = env.ALTERAN_MOTION as MotionLevel | undefined;
  if (explicit === 'full' || explicit === 'reduced' || explicit === 'off') return explicit;
  if (env.NO_MOTION === '1' || env.REDUCED_MOTION === '1') return 'reduced';
  return settings.motion ?? 'full';
}

/** The boot animation is the one thing `reduced` and `off` both drop: it is pure decoration. */
export function wantsIntro(settings: MotionSettings = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  if (settings.intro === false) return false;
  return motionLevel(settings, env) === 'full';
}

/** Whether the idle start screen may repaint itself while it waits for the first message. */
export function animatesSplash(level: MotionLevel): boolean {
  return level === 'full';
}
