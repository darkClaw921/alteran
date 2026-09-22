import type { Line, Seg } from './lines.js';
import { textWidth } from './lines.js';
import { C, type Color } from './theme.js';

export interface GateState {
  /** Per-chevron state for the 9 GRADUS stages. */
  chevrons: Array<'off' | 'lit' | 'active' | 'failed'>;
  active: boolean;
  tick: number;
  label: string;
  sublabel: string;
  labelColor?: Color;
  /** Start-up dialling: rim pulse and drifting dust. Off once real work drives the gate. */
  dialing?: boolean;
}

const HORIZON = [' ', ' ', '.', '-', '~', '~', '='];
/** A terminal cell is about twice as tall as it is wide. */
const CELL_ASPECT = 2;

/**
 * Largest gate that still looks round inside the given box.
 *
 * A terminal cell is about twice as tall as it is wide, so a circle needs a radius ratio of
 * rx ≈ 2·ry; filling the full width of a wide panel would draw a flattened ellipse instead.
 */
export function gateSize(maxWidth: number, maxHeight: number, cellAspect = CELL_ASPECT): { width: number; height: number } {
  const heightFor = (w: number) => ((w / 2 - 1.5) / cellAspect + 0.6) * 2;
  const widthFor = (h: number) => (h / 2 - 0.6) * cellAspect * 2 + 3;
  const h = heightFor(maxWidth);
  if (h <= maxHeight) return { width: maxWidth, height: Math.max(7, Math.round(h)) };
  return { width: Math.max(11, Math.min(maxWidth, Math.round(widthFor(maxHeight)))), height: maxHeight };
}

/** Pad a gate line so a narrower gate sits centred in a wider column. */
export function centerGate(lines: Line[], width: number): Line[] {
  return lines.map((l) => {
    const w = l.reduce((n, x) => n + x.text.length, 0);
    const pad = Math.max(0, Math.floor((width - w) / 2));
    return pad ? [{ text: ' '.repeat(pad), color: C.bg }, ...l] : l;
  });
}

/** Procedural ASCII stargate: outer ring, glyph track, 9 chevrons and an animated event horizon. */
export function renderGate(width: number, height: number, st: GateState): Line[] {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const rx = width / 2 - 1.5;
  const ry = height / 2 - 0.6;
  const t = st.tick / 6;
  // The inner glyph track only reads as a track when the gate is tall enough to hold it.
  const showTrack = ry >= 7;
  // An energy pulse running around the rim — only while dialling on the start screen.
  const sweep = ((st.tick / 7) % (2 * Math.PI)) - Math.PI;
  const grid: Array<Array<{ ch: string; color: Color; bold?: boolean }>> = [];

  const chevronAngles = Array.from({ length: 9 }, (_, k) => -Math.PI / 2 + (k * 2 * Math.PI) / 9);
  const chevronColor = (k: number): Color => {
    const s = st.chevrons[k] ?? 'off';
    if (s === 'lit') return C.gold;
    if (s === 'failed') return C.red;
    if (s === 'active') return st.tick % 4 < 2 ? C.amber : C.bronze;
    return C.dim;
  };

  for (let y = 0; y < height; y++) {
    const row: Array<{ ch: string; color: Color; bold?: boolean }> = [];
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const r = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const a = Math.atan2(dy, dx);
      // Distance to the rim measured in columns of *visual* space (a row counts as CELL_ASPECT
      // columns), so the ring keeps the same apparent thickness all the way round.
      const grad = Math.hypot(dx / (r * rx), dy / (r * ry * CELL_ASPECT)) || 1e-6;
      const rim = (r - 1) / grad;
      let cell: { ch: string; color: Color; bold?: boolean } = { ch: ' ', color: C.bg };

      if (rim <= 0.4 && rim >= -2.2) {
        const pulse = st.dialing && Math.abs(((a - sweep + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.2;
        cell = pulse ? { ch: '*', color: C.gold, bold: true } : { ch: '#', color: C.bronze };
      } else if (showTrack && rim < -3.4 && rim > -5.6) {
        // Sparse glyph track: a solid second wall would read as a thicker ring.
        const glyph = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 39);
        const on = glyph % 2 === 0;
        cell = { ch: on ? '*' : ' ', color: C.rule };
      } else if (rim <= (showTrack ? -6.2 : -3.4)) {
        if (st.active) {
          const v = Math.sin(3 * a + t * 0.9 + r * 9) + Math.cos(r * 13 - t * 1.4) + 0.4 * Math.sin(dx * 5 + t);
          const idx = Math.max(0, Math.min(HORIZON.length - 1, Math.floor(((v + 2.4) / 4.8) * HORIZON.length)));
          const ch = HORIZON[idx];
          const color = idx >= 5 ? C.cyan : idx >= 3 ? C.muted : C.dim;
          cell = { ch, color };
        } else {
          // Dormant dust: it drifts only while dialling, otherwise the resting gate stays still.
          const drift = st.dialing ? Math.floor(st.tick / 5) : 0;
          const ch = (x * 13 + (y + drift) * 7) % 23 === 0 ? '.' : ' ';
          cell = { ch, color: C.dim };
        }
      }
      row.push(cell);
    }
    grid.push(row);
  }

  chevronAngles.forEach((ca, k) => {
    const ux = Math.cos(ca);
    const uy = Math.sin(ca);
    const px = Math.round(cx + ux * (rx + 0.2));
    const py = Math.round(cy + uy * (ry + 0.1));
    const sprite = Math.abs(uy) >= 0.45 ? (uy < 0 ? '\\V/' : '/^\\') : ux < 0 ? '=>' : '<=';
    const chars = [...sprite];
    const x0 = px - Math.floor(chars.length / 2);
    const color = chevronColor(k);
    chars.forEach((ch, i) => {
      const x = x0 + i;
      if (py >= 0 && py < height && x >= 0 && x < width) grid[py][x] = { ch, color, bold: st.chevrons[k] === 'lit' };
    });
  });

  const put = (y: number, text: string, color: Color, bold = true) => {
    if (y < 0 || y >= height || !text) return;
    const w = textWidth(text);
    const x0 = Math.max(0, Math.round(cx - w / 2));
    const chars = [...text];
    for (let i = 0; i < chars.length && x0 + i < width; i++) grid[y][x0 + i] = { ch: chars[i], color, bold };
  };
  const midY = Math.round(cy);
  put(midY, st.label, st.labelColor ?? (st.active ? C.gold : C.muted));
  put(midY + 1, st.sublabel, C.text, false);

  return grid.map((row) => {
    const line: Seg[] = [];
    for (const c of row) {
      const last = line[line.length - 1];
      if (last && last.color === c.color && Boolean(last.bold) === Boolean(c.bold)) last.text += c.ch;
      else line.push({ text: c.ch, color: c.color, bold: c.bold });
    }
    return line;
  });
}
