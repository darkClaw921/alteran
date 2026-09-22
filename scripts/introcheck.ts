/** Print a few frames of the boot animation as plain text. */
import { INTRO_FRAMES, introFrame } from '../src/tui/intro.ts';

for (const i of [0, 4, 8, 9, 11, 12, 16, INTRO_FRAMES - 1]) {
  const f = introFrame(i, 78, 22);
  console.log(`--- frame ${i} (${f.phase}) ---`);
  console.log(f.lines.map((l) => l.map((s) => s.text).join('')).join('\n'));
}
