/** Audit rendered TUI output: report colours whose contrast against the terminal background is too low. */
import { execFileSync } from 'node:child_process';

const out = execFileSync('node_modules/.bin/tsx', ['scripts/preview.tsx'], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '3' } });

const lum = (r: number, g: number, b: number) => {
  const f = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const BG = lum(0x05, 0x08, 0x0a);

const seen = new Map<string, { sample: string; count: number }>();
const re = /\u001b\[(?:1;)?38;2;(\d+);(\d+);(\d+)m([^\u001b]*)/g;
let m: RegExpExecArray | null;
while ((m = re.exec(out))) {
  const [, r, g, b, text] = m;
  if (!text.trim()) continue;
  const key = `${r},${g},${b}`;
  const e = seen.get(key) ?? { sample: text.trim().slice(0, 40), count: 0 };
  e.count++;
  seen.set(key, e);
}

const rows = [...seen.entries()]
  .map(([key, e]) => {
    const [r, g, b] = key.split(',').map(Number);
    const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return { hex, contrast: ratio(lum(r, g, b), BG), ...e };
  })
  .sort((a, b) => a.contrast - b.contrast);

for (const r of rows) {
  const flag = r.contrast < 3 ? 'LOW ' : r.contrast < 4.5 ? 'ok  ' : 'good';
  console.log(`${flag} ${r.hex}  ${r.contrast.toFixed(2)}:1  x${String(r.count).padStart(4)}  ${JSON.stringify(r.sample)}`);
}
const low = rows.filter((r) => r.contrast < 3);
console.log(low.length ? `\n${low.length} colour(s) below 3:1` : '\nAll rendered colours are at least 3:1 against the background.');
