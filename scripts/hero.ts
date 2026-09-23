/**
 * Generates `assets/hero.svg` — the animated gate for the README.
 *
 * The geometry (39 glyphs on a spinning track, 9 chevrons, the kawoosh) is easier to get right
 * from formulas than by hand, and the animation is plain CSS keyframes so GitHub renders it
 * inside `<img>`. Run: `node_modules/.bin/tsx scripts/hero.ts`
 */
import { writeFileSync } from 'node:fs';

const C = {
  bg: '#05080A',
  text: '#CFE3E6',
  muted: '#6E8F96',
  gold: '#E8C77A',
  rule: '#8A6A38',
  cyan: '#2BD9E8',
  green: '#5BD98A',
  amber: '#F0A73C',
  dim: '#486F7C',
  /** Naquadah: the ring is dark metal, not gold — gold is only the rim light. */
  metalLit: '#7E8A93',
  metalMid: '#39424A',
  metalDark: '#11161B',
};

const W = 1200;
const H = 420;
/** Gate centre, ring band, glyph track and the hole the horizon fills. */
const CX = 214;
const CY = 210;
const R_OUT = 158;
const R_TRACK_OUT = 136;
const R_TRACK_IN = 112;
const R_IN = 104;
const R_GLYPH = 124;
const R_SEAT = 145; // a chevron sits on the outer band, it does not stick out of it

/** One loop: dial nine chevrons, kawoosh, run the stages, shut down. */
const LOOP = 13;
const LOCK = 0.55; // seconds between chevrons
const KAWOOSH = 9 * LOCK + 0.5;
const pct = (t: number) => `${((t / LOOP) * 100).toFixed(2)}%`;

const rad = (deg: number) => (deg * Math.PI) / 180;
const px = (r: number, deg: number) => (CX + r * Math.sin(rad(deg))).toFixed(2);
const py = (r: number, deg: number) => (CY - r * Math.cos(rad(deg))).toFixed(2);

/** Chevron angles: nine, evenly spaced, top one first — the dial order the TUI uses. */
const CHEVRONS = [0, 40, -40, 80, -80, 120, -120, 160, -160];

/**
 * A chevron: a block overhanging the outer rim whose underside opens into a V aimed at the
 * centre, with the lamp inside it. Local axes have -y pointing away from the centre.
 */
const housing = 'M -22 -13 L 22 -13 L 19 -1 L 9 -1 L 0 11 L -9 -1 L -19 -1 Z';
const lamp = 'M -12 -10 L 12 -10 L 12 -4 L 0 6 L -12 -4 Z';

/** 39 marks on the track: three shapes in a fixed rotation, so the ring reads as engraved. */
const glyphs = Array.from({ length: 39 }, (_, i) => {
  const a = (360 / 39) * i;
  const at = `transform="translate(${px(R_GLYPH, a)} ${py(R_GLYPH, a)}) rotate(${a.toFixed(2)})"`;
  const shape =
    i % 3 === 0
      ? '<path d="M -4.5 5 L 0 -6 L 4.5 5 M -2.6 1.4 L 2.6 1.4" />'
      : i % 3 === 1
        ? '<path d="M -4 -6 L -4 6 M -4 -6 L 4 -6 M -4 0 L 2.6 0" />'
        : '<path d="M 0 -6 L 4.5 0 L 0 6 L -4.5 0 Z M 0 -2.4 L 0 2.4" />';
  return `<g ${at} class="${i % 13 === 0 ? 'glyph hot' : 'glyph'}">${shape}</g>`;
}).join('\n        ');

const chevrons = CHEVRONS.map((a, i) => {
  const scale = i === 0 ? ' scale(1.22)' : '';
  const at = `transform="translate(${px(R_SEAT, a)} ${py(R_SEAT, a)}) rotate(${a})${scale}"`;
  return `<g ${at}>
        <path class="ch-body" d="${housing}" />
        <path class="ch-lamp l${i}" d="${lamp}" />
      </g>`;
}).join('\n      ');

/** Each chevron locks at its own moment; they all shut down together at the end. */
const lampKeys = CHEVRONS.map((_, i) => {
  const on = i * LOCK;
  return `@keyframes lock${i}{0%,${pct(on)}{opacity:.06}${pct(on + 0.1)}{opacity:1}${pct(on + 0.45)}{opacity:.85}${pct(LOOP - 1.4)}{opacity:.85}${pct(LOOP - 0.6)}{opacity:.06}}`;
}).join('\n    ');
const lampUse = CHEVRONS.map((_, i) => `.l${i}{animation-name:lock${i}}`).join('');

/** Nine seams in the ring, offset from the chevrons — the gate is cast in segments. */
const seams = Array.from({ length: 9 }, (_, i) => {
  const a = 20 + i * 40;
  return `<line x1="${px(R_IN, a)}" y1="${py(R_IN, a)}" x2="${px(R_OUT, a)}" y2="${py(R_OUT, a)}" />`;
}).join('\n        ');

const STAGES = ['ctx', 'plan', 'read', 'patch', 'types', 'tests', 'lint', 'review', 'commit'];
const SX = 470;
const stageW = 68;
const stages = STAGES.map((s, i) => {
  const sx = SX + i * stageW;
  return `<g class="st s${i}">
        <rect x="${sx}" y="292" width="${stageW - 10}" height="7" rx="3.5" />
        <text x="${sx}" y="284" class="stage-label">${s}</text>
      </g>`;
}).join('\n      ');
/** Stages fill after the gate opens, one after another, and hold until the shutdown. */
const stageKeys = STAGES.map((_, i) => {
  const on = KAWOOSH + 0.75 + i * 0.42;
  return `@keyframes run${i}{0%,${pct(on)}{opacity:.18}${pct(on + 0.2)}{opacity:1}${pct(LOOP - 1.4)}{opacity:1}${pct(LOOP - 0.6)}{opacity:.18}}`;
}).join('\n    ');
const stageUse = STAGES.map((_, i) => `.s${i}{animation-name:run${i}}`).join('');

const CHIPS = [
  { label: '/plan', w: 92 },
  { label: '/create-tasks', w: 168 },
  { label: '/run-phase 1', w: 156 },
];
let chipX = SX;
const chips = CHIPS.map((c, i) => {
  const at = chipX;
  chipX += c.w + 46;
  const arrow = i < CHIPS.length - 1 ? `<path class="arrow a${i}" d="M ${at + c.w + 12} 222 L ${at + c.w + 34} 222 M ${at + c.w + 27} 217 L ${at + c.w + 34} 222 L ${at + c.w + 27} 227" />` : '';
  return `<g class="chip c${i}">
        <rect x="${at}" y="205" width="${c.w}" height="34" rx="4" />
        <text x="${at + c.w / 2}" y="227" text-anchor="middle">${c.label}</text>
      </g>
      ${arrow}`;
}).join('\n      ');
const chipKeys = CHIPS.map((_, i) => {
  const on = KAWOOSH + 0.2 + i * 1.1;
  return `@keyframes chip${i}{0%,${pct(on)}{opacity:.25}${pct(on + 0.25)}{opacity:1}${pct(LOOP - 1.4)}{opacity:1}${pct(LOOP - 0.6)}{opacity:.25}}`;
}).join('\n    ');
const chipUse = CHIPS.map((_, i) => `.c${i},.a${i}{animation-name:chip${i}}`).join('');

/** Faint star field — deterministic, so the file does not churn between runs. */
let seed = 20260923;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const stars = Array.from({ length: 70 }, () => {
  const sx = (rnd() * W).toFixed(1);
  const sy = (rnd() * H).toFixed(1);
  const r = (0.4 + rnd() * 1.1).toFixed(2);
  const o = (0.08 + rnd() * 0.3).toFixed(2);
  const d = (rnd() * LOOP).toFixed(2);
  return `<circle cx="${sx}" cy="${sy}" r="${r}" fill="${C.text}" opacity="${o}" style="animation:twinkle 4s ease-in-out infinite;animation-delay:-${d}s" />`;
}).join('\n    ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ALTERAN — терминальный кодинг-агент с фазовым трекером задач">
  <title>ALTERAN — терминальный кодинг-агент с фазовым трекером задач</title>
  <defs>
    <linearGradient id="metal" x1="0.15" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="${C.metalLit}" />
      <stop offset="34%" stop-color="${C.metalMid}" />
      <stop offset="72%" stop-color="#20272D" />
      <stop offset="100%" stop-color="${C.metalDark}" />
    </linearGradient>
    <linearGradient id="metalEdge" x1="0.2" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#6C7780" />
      <stop offset="55%" stop-color="#333C43" />
      <stop offset="100%" stop-color="#171D23" />
    </linearGradient>
    <radialGradient id="pool" cx="50%" cy="46%" r="70%">
      <stop offset="0%" stop-color="#2FA6D2" />
      <stop offset="55%" stop-color="#1A83B8" />
      <stop offset="86%" stop-color="#0E6392" />
      <stop offset="100%" stop-color="#083F60" />
    </radialGradient>
    <radialGradient id="splash" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".95" />
      <stop offset="38%" stop-color="#9FEBFB" stop-opacity=".8" />
      <stop offset="72%" stop-color="${C.cyan}" stop-opacity=".35" />
      <stop offset="100%" stop-color="${C.cyan}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.rule}" stop-opacity=".9" />
      <stop offset="100%" stop-color="${C.rule}" stop-opacity="0" />
    </linearGradient>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="6" result="b" />
      <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <filter id="soft" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="4" />
    </filter>
    <clipPath id="gateHole"><circle cx="${CX}" cy="${CY}" r="${R_IN}" /></clipPath>
  </defs>

  <style>
    text { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .ch-body { fill: url(#metalEdge); stroke: #77838B; stroke-width: .8; stroke-linejoin: round; }
    .ch-lamp { fill: ${C.amber}; filter: url(#glow); animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: ease-out; }
    ${lampUse}
    .glyph { fill: none; stroke: #C6D4DA; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: .42; }
    .glyph.hot { stroke: ${C.gold}; opacity: .95; }
    .seams { stroke: #0A0E12; stroke-width: 2; opacity: .55; }
    .spin { transform-origin: ${CX}px ${CY}px; animation: spin ${LOOP}s cubic-bezier(.3,.04,.18,1) infinite; }
    .horizon { transform-origin: ${CX}px ${CY}px; animation: openGate ${LOOP}s ease-out infinite; }
    .shimmer { opacity: .24; fill: none; stroke: #DFF8FF; stroke-width: 3; filter: url(#soft); animation: drift 7s ease-in-out infinite; }
    .shimmer.b { animation-duration: 9s; animation-direction: reverse; opacity: .15; }
    .burst { transform-origin: ${CX}px ${CY}px; animation: kawoosh ${LOOP}s cubic-bezier(.1,.75,.25,1) infinite; }
    .ripple { fill: none; stroke: #DFFAFF; stroke-width: 1.4; transform-origin: ${CX}px ${CY}px; animation: ripple ${LOOP}s ease-out infinite; opacity: 0; }
    .r2 { animation-delay: .9s } .r3 { animation-delay: 1.8s }
    .word { fill: ${C.gold}; font-size: 52px; font-weight: 700; letter-spacing: 12px; }
    .tagline { fill: ${C.text}; font-size: 17px; letter-spacing: .6px; }
    .sub { fill: ${C.muted}; font-size: 14px; }
    .chip rect { fill: #0C161B; stroke: ${C.dim}; stroke-width: 1; }
    .chip text { fill: ${C.cyan}; font-size: 15px; }
    .chip, .arrow { animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: ease-out; }
    .arrow { fill: none; stroke: ${C.dim}; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    ${chipUse}
    .st rect { fill: ${C.green}; }
    .stage-label { fill: ${C.muted}; font-size: 11px; letter-spacing: .4px; }
    .st { animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: ease-out; opacity: .18; }
    ${stageUse}
    .prompt { fill: ${C.green}; font-size: 15px; }
    .cmd { fill: ${C.text}; font-size: 15px; }
    .caret { fill: ${C.cyan}; animation: blink 1.1s steps(1) infinite; }
    .porta { fill: ${C.amber}; font-size: 13px; letter-spacing: 1.4px; animation: openText ${LOOP}s ease-out infinite; }

    ${lampKeys}
    ${stageKeys}
    ${chipKeys}
    @keyframes spin { 0% { transform: rotate(0) } ${pct(KAWOOSH - 0.7)}, 100% { transform: rotate(-424deg) } }
    @keyframes openGate {
      0%, ${pct(KAWOOSH + 0.05)} { opacity: 0; transform: scale(.72) }
      ${pct(KAWOOSH + 0.5)} { opacity: 1; transform: scale(1) }
      ${pct(LOOP - 1.4)} { opacity: .96; transform: scale(1) }
      ${pct(LOOP - 0.5)}, 100% { opacity: 0; transform: scale(.7) }
    }
    @keyframes kawoosh {
      0%, ${pct(KAWOOSH)} { opacity: 0; transform: scale(.12) }
      ${pct(KAWOOSH + 0.14)} { opacity: 1; transform: scale(.55) }
      ${pct(KAWOOSH + 0.5)} { opacity: .75; transform: scale(1.45) }
      ${pct(KAWOOSH + 1.1)}, 100% { opacity: 0; transform: scale(1.9) }
    }
    @keyframes ripple {
      0%, ${pct(KAWOOSH + 0.55)} { opacity: 0; transform: scale(.2) }
      ${pct(KAWOOSH + 0.85)} { opacity: .45 }
      ${pct(KAWOOSH + 2.7)} { opacity: 0; transform: scale(1) }
      100% { opacity: 0; transform: scale(1) }
    }
    @keyframes drift { 0%, 100% { transform: translateY(7px) } 50% { transform: translateY(-7px) } }
    @keyframes openText {
      0%, ${pct(KAWOOSH + 0.2)} { opacity: 0 }
      ${pct(KAWOOSH + 0.6)}, ${pct(LOOP - 1)} { opacity: 1 }
      ${pct(LOOP - 0.5)}, 100% { opacity: 0 }
    }
    @keyframes twinkle { 0%, 100% { opacity: .12 } 50% { opacity: .5 } }
    @keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
    @media (prefers-reduced-motion: reduce) {
      .ch-lamp, .spin, .horizon, .burst, .ripple, .shimmer, .chip, .arrow, .st, .caret, .porta, circle { animation: none !important; }
      .ch-lamp, .st, .chip, .arrow, .horizon, .porta { opacity: 1 !important; }
    }
  </style>

  <rect width="${W}" height="${H}" fill="${C.bg}" />
  <g>
    ${stars}
  </g>

  <!-- gate -->
  <g>
    <!-- event horizon, behind the ring -->
    <g clip-path="url(#gateHole)">
      <g class="horizon">
        <circle cx="${CX}" cy="${CY}" r="${R_IN}" fill="url(#pool)" />
        <g class="shimmer">
          <ellipse cx="${CX}" cy="${CY - 26}" rx="78" ry="26" />
          <ellipse cx="${CX}" cy="${CY + 34}" rx="62" ry="17" />
        </g>
        <g class="shimmer b">
          <ellipse cx="${CX}" cy="${CY + 2}" rx="86" ry="21" />
          <ellipse cx="${CX}" cy="${CY + 66}" rx="40" ry="12" />
        </g>
        <circle cx="${CX}" cy="${CY}" r="${R_IN - 2}" fill="none" stroke="#CDF3FF" stroke-width="5" opacity=".55" filter="url(#soft)" />
        <circle cx="${CX}" cy="${CY}" r="${R_IN - 1}" fill="none" stroke="#EAFCFF" stroke-width="1.2" opacity=".5" />
      </g>
    </g>

    <!-- ring: outer band, inset glyph track, rims -->
    <circle cx="${CX}" cy="${CY}" r="${(R_OUT + R_IN) / 2}" fill="none" stroke="url(#metal)" stroke-width="${R_OUT - R_IN}" />
    <circle cx="${CX}" cy="${CY}" r="${(R_TRACK_OUT + R_TRACK_IN) / 2}" fill="none" stroke="#0E1319" stroke-width="${R_TRACK_OUT - R_TRACK_IN}" opacity=".85" />
    <g class="spin">
      <g>
        ${glyphs}
      </g>
    </g>
    <g class="seams">
      ${seams}
    </g>
    <circle cx="${CX}" cy="${CY}" r="${R_OUT}" fill="none" stroke="#A8B4BC" stroke-width="1.4" opacity=".5" />
    <circle cx="${CX}" cy="${CY}" r="${R_TRACK_OUT}" fill="none" stroke="#5E6A73" stroke-width="1" opacity=".5" />
    <circle cx="${CX}" cy="${CY}" r="${R_TRACK_IN}" fill="none" stroke="#5E6A73" stroke-width="1" opacity=".5" />
    <circle cx="${CX}" cy="${CY}" r="${R_IN}" fill="none" stroke="#8D99A1" stroke-width="1.6" opacity=".6" />

    <!-- nine chevrons -->
    <g>
      ${chevrons}
    </g>

    <!-- the kawoosh bursts out past the rim, then settles back into the pool -->
    <circle class="burst" cx="${CX}" cy="${CY}" r="${R_IN}" fill="url(#splash)" />
    <g clip-path="url(#gateHole)">
      <circle class="ripple" cx="${CX}" cy="${CY}" r="${R_IN - 6}" />
      <circle class="ripple r2" cx="${CX}" cy="${CY}" r="${R_IN - 6}" />
      <circle class="ripple r3" cx="${CX}" cy="${CY}" r="${R_IN - 6}" />
    </g>
  </g>

  <!-- wordmark and pipeline -->
  <g>
    <text x="${SX}" y="112" class="word">ALTERAN</text>
    <text x="${SX + 4}" y="146" class="tagline">терминальный кодинг-агент · фазовый трекер задач</text>
    <text x="${SX + 4}" y="170" class="sub">план → эпики-фазы → задачи с зависимостями → выполнение по одной</text>
    <rect x="${SX}" y="186" width="${W - SX - 60}" height="1" fill="url(#fade)" />

    ${chips}

    <text x="${SX}" y="266" class="sub" opacity=".8">GRADUS</text>
    <g>
      ${stages}
    </g>

    <text x="${SX}" y="352" class="prompt">&gt;</text>
    <text x="${SX + 22}" y="352" class="cmd">alteran /run-phase 1</text>
    <rect class="caret" x="${SX + 232}" y="339" width="9" height="17" />
    <text x="${W - 60}" y="352" text-anchor="end" class="porta">ASTRIA PORTA: OPEN</text>
  </g>
</svg>
`;

writeFileSync(new URL('../assets/hero.svg', import.meta.url), svg);
console.log(`assets/hero.svg — ${(svg.length / 1024).toFixed(1)} KB`);
