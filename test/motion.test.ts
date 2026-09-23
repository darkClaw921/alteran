import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launch, sleep } from './harness.js';
import { animatesSplash, motionLevel, wantsIntro } from '../src/tui/motion.js';

describe('motion levels', () => {
  it('is full unless something says otherwise', () => {
    expect(motionLevel({}, {})).toBe('full');
    expect(wantsIntro({}, {})).toBe(true);
  });

  it('honours the settings value', () => {
    expect(motionLevel({ motion: 'reduced' }, {})).toBe('reduced');
    expect(motionLevel({ motion: 'off' }, {})).toBe('off');
    expect(wantsIntro({ motion: 'reduced' }, {})).toBe(false);
    expect(wantsIntro({ intro: false }, {})).toBe(false);
  });

  it('lets the environment override settings, the way other tools do', () => {
    expect(motionLevel({ motion: 'full' }, { NO_MOTION: '1' })).toBe('reduced');
    expect(motionLevel({ motion: 'full' }, { REDUCED_MOTION: '1' })).toBe('reduced');
    expect(motionLevel({ motion: 'off' }, { ALTERAN_MOTION: 'full' })).toBe('full');
    // An unrecognised value is not a level; fall back to the setting rather than guess.
    expect(motionLevel({ motion: 'reduced' }, { ALTERAN_MOTION: 'sideways' })).toBe('reduced');
  });

  it('animates the start screen only at full motion', () => {
    expect(animatesSplash('full')).toBe(true);
    expect(animatesSplash('reduced')).toBe(false);
    expect(animatesSplash('off')).toBe(false);
  });

  it('drops the boot animation in reduced motion but keeps the intro with intro:true', () => {
    expect(wantsIntro({ motion: 'reduced', intro: true }, {})).toBe(false);
    expect(wantsIntro({ motion: 'full', intro: true }, {})).toBe(true);
  });
});

describe('reduced motion in the TUI', () => {
  async function open(settings: Record<string, unknown>) {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'alteran-motion-'));
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'alteran-motion-dir-'));
    // startTui reads the home from the environment, so the usual harness setup has to be redone here.
    process.env.ALTERAN_HOME = home;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 120, 30);
    await sleep(700);
    return {
      io,
      close: async () => {
        io.key('\u0003');
        await sleep(300);
        io.key('\u0003');
        await sleep(300);
        delete process.env.ALTERAN_HOME;
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('still shows everything the start screen says', async () => {
    const { io, close } = await open({ motion: 'reduced' });
    try {
      const screen = io.screen();
      // The facts are all there; only the movement is gone.
      expect(screen).toContain('A L T E R A N');
      expect(screen).toContain('ollama:test');
      expect(screen).toContain('Type a task');
      // Two frames a second apart are identical: nothing is animating.
      const before = io.text();
      await sleep(600);
      expect(io.text()).toBe(before);
    } finally {
      await close();
    }
  }, 30000);

  it('does animate at full motion, so the check above is not vacuous', async () => {
    const { io, close } = await open({ motion: 'full' });
    try {
      const before = io.text();
      await sleep(600);
      expect(io.text()).not.toBe(before);
    } finally {
      await close();
    }
  }, 30000);
});
