/**
 * Generates DEMO ARTWORK (SVG) for demo tenants: studio-lit car silhouette,
 * ceiling light rigs, monogram marks. It is labelled as demo artwork in
 * business.json (branding.demoArtwork) and must be replaced by the studio's
 * own photography before going live.
 *
 * Usage: tsx scripts/tenant/demo-art.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')

const CAR_BODY =
  'M170 640 C170 610 190 588 240 580 L430 552 C520 540 600 528 660 512 C740 450 800 420 880 412 L1080 410 ' +
  'C1160 412 1230 450 1290 500 L1400 516 C1440 522 1452 548 1450 590 L1446 640 L1300 640 A110 110 0 0 0 1080 640 ' +
  'L560 640 A110 110 0 0 0 340 640 Z'
const CAR_GLASS = 'M700 508 C765 462 812 436 886 430 L1068 428 C1136 431 1190 462 1232 498 Z'

function wheel(cx: number, accent: string, caliper: boolean): string {
  const spokes = Array.from({ length: 5 }, (_, i) => {
    const a = (i * 72 * Math.PI) / 180
    return `<line x1="${cx + Math.cos(a) * 18}" y1="${640 + Math.sin(a) * 18}" x2="${cx + Math.cos(a) * 60}" y2="${640 + Math.sin(a) * 60}" stroke="#4a5058" stroke-width="7" stroke-linecap="round"/>`
  }).join('')
  return `<g>
    <circle cx="${cx}" cy="640" r="92" fill="#08090b" stroke="#23272d" stroke-width="8"/>
    <circle cx="${cx}" cy="640" r="64" fill="#101216" stroke="#3a3f47" stroke-width="3"/>
    ${caliper ? `<path d="M${cx + 30} ${640 - 48} A56 56 0 0 1 ${cx + 54} ${640 - 10}" stroke="${accent}" stroke-width="10" fill="none" stroke-linecap="round"/>` : ''}
    ${spokes}
    <circle cx="${cx}" cy="640" r="14" fill="#2b2f36"/>
  </g>`
}

function car(accent: string, caliper: boolean): string {
  return `<g>
    <path d="${CAR_BODY}" fill="url(#body)"/>
    <path d="${CAR_BODY}" fill="none" stroke="#2c3038" stroke-width="2"/>
    <path d="${CAR_GLASS}" fill="#050607"/>
    <path d="M700 508 C765 462 812 436 886 430 L1068 428" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="2"/>
    <line x1="962" y1="429" x2="958" y2="505" stroke="#0e1013" stroke-width="10"/>
    <path d="M250 585 C500 560 900 540 1420 545" fill="none" stroke="${accent}" stroke-width="3" filter="url(#glow)"/>
    <path d="M300 578 C450 560 560 548 650 520" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="2"/>
    <path d="M880 414 L1078 412" stroke="#ffffff" stroke-opacity=".5" stroke-width="2" filter="url(#glow)"/>
    <path d="M190 600 L262 588 L264 597 L196 607 Z" fill="#f4f6f8" filter="url(#glow)"/>
    <path d="M1418 540 L1450 546 L1450 561 L1420 557 Z" fill="#c2332b" filter="url(#glow)"/>
    ${wheel(450, accent, caliper)}
    ${wheel(1190, accent, caliper)}
  </g>`
}

function hexCeiling(): string {
  const s = 54
  const hex = (cx: number, cy: number) =>
    `<path d="${Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i
      return `${i === 0 ? 'M' : 'L'}${(cx + s * Math.cos(a)).toFixed(1)} ${(cy + s * Math.sin(a)).toFixed(1)}`
    }).join(' ')} Z" fill="none" stroke="#f3f5f7" stroke-opacity=".6" stroke-width="4"/>`
  return `<pattern id="hex" width="180" height="103.92" patternUnits="userSpaceOnUse" patternTransform="translate(10 -30)">
      ${hex(60, 51.96)}${hex(150, 0)}${hex(150, 103.92)}
    </pattern>
    <rect x="0" y="0" width="1600" height="360" fill="url(#hex)" mask="url(#ceilingFade)" filter="url(#softglow)"/>`
}

function tubeCeiling(accent: string): string {
  const tubes = [
    [120, 70, 520], [760, 70, 700], [300, 150, 620], [1020, 150, 460], [80, 230, 380], [560, 230, 760],
  ]
  return tubes
    .map(([x, y, w], i) => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="${i % 3 === 0 ? accent : '#f3f7fa'}" mask="url(#ceilingFade)" filter="url(#softglow)"/>`)
    .join('')
}

function hero(accent: string, style: 'hex' | 'tubes', caliper: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101216"/><stop offset=".55" stop-color="#0a0b0d"/><stop offset="1" stop-color="#060708"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3f47"/><stop offset=".35" stop-color="#1b1e23"/><stop offset=".62" stop-color="#101216"/><stop offset="1" stop-color="#1a1d22"/>
    </linearGradient>
    <radialGradient id="floor" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx=".5" cy=".45" r=".75">
      <stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".75"/>
    </radialGradient>
    <linearGradient id="fadeDown" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="ceilingFade"><rect width="1600" height="360" fill="url(#fadeDown)"/></mask>
    <linearGradient id="reflFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="reflMask"><rect y="735" width="1600" height="265" fill="url(#reflFade)"/></mask>
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="softglow" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1600" height="1000" fill="url(#bg)"/>
  ${style === 'hex' ? hexCeiling() : tubeCeiling(accent)}
  <ellipse cx="810" cy="740" rx="780" ry="80" fill="url(#floor)"/>
  <g mask="url(#reflMask)"><g transform="translate(0 1470) scale(1 -1)" opacity=".35">${car(accent, caliper)}</g></g>
  ${car(accent, caliper)}
  <rect width="1600" height="1000" fill="url(#vignette)"/>
</svg>
`
}

function paintCloseup(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c1f24"/><stop offset="1" stop-color="#07080a"/></linearGradient>
    <filter id="g"><feGaussianBlur stdDeviation="4"/></filter>
  </defs>
  <rect width="800" height="600" fill="url(#p)"/>
  <path d="M-40 420 C200 300 460 260 860 300" stroke="#ffffff" stroke-opacity=".75" stroke-width="10" fill="none" filter="url(#g)"/>
  <path d="M-40 470 C220 360 480 330 860 360" stroke="#ffffff" stroke-opacity=".35" stroke-width="5" fill="none" filter="url(#g)"/>
  <path d="M-40 520 C240 430 520 400 860 420" stroke="${accent}" stroke-opacity=".8" stroke-width="4" fill="none" filter="url(#g)"/>
  <path d="M0 160 C260 120 540 110 800 130" stroke="#ffffff" stroke-opacity=".12" stroke-width="40" fill="none" filter="url(#g)"/>
</svg>
`
}

function wheelCloseup(accent: string): string {
  const spokes = Array.from({ length: 10 }, (_, i) => {
    const a = (i * 36 * Math.PI) / 180
    return `<line x1="${400 + Math.cos(a) * 60}" y1="${300 + Math.sin(a) * 60}" x2="${400 + Math.cos(a) * 205}" y2="${300 + Math.sin(a) * 205}" stroke="#565c66" stroke-width="${i % 2 ? 10 : 18}" stroke-linecap="round"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#08090b"/>
  <circle cx="400" cy="300" r="280" fill="#0d0f12" stroke="#1d2126" stroke-width="30"/>
  <circle cx="400" cy="300" r="222" fill="#121418" stroke="#3b4048" stroke-width="6"/>
  <path d="M480 110 A200 200 0 0 1 590 250" stroke="${accent}" stroke-width="34" fill="none" stroke-linecap="round"/>
  ${spokes}
  <circle cx="400" cy="300" r="56" fill="#1a1d22" stroke="#4a5058" stroke-width="4"/>
  <path d="M250 150 C320 90 470 80 560 130" stroke="#fff" stroke-opacity=".25" stroke-width="6" fill="none"/>
</svg>
`
}

function hexMark(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M32 4 L56 18 L56 46 L32 60 L8 46 L8 18 Z" fill="none" stroke="${accent}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M42 24 L32 18 L20 25 L20 39 L32 46 L44 39 L44 32 L33 32" fill="none" stroke="#e8eaed" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
</svg>
`
}

function iceMark(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M32 6 L58 32 L32 58 L6 32 Z" fill="none" stroke="${accent}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M32 18 V46 M20 32 H44" stroke="#e8eaed" stroke-width="4" stroke-linecap="round"/>
</svg>
`
}

function write(slug: string, file: string, svg: string): void {
  writeFileSync(join(ROOT, 'tenants', slug, 'assets', file), svg)
}

const GRAPHITE = '#d6a84a'
write('graphite', 'hero.svg', hero(GRAPHITE, 'hex', true))
write('graphite', 'logo.svg', hexMark(GRAPHITE))
write('graphite', 'gallery-paint.svg', paintCloseup(GRAPHITE))
write('graphite', 'gallery-wheel.svg', wheelCloseup(GRAPHITE))

const ICE = '#5ec8e5'
write('ice-lab', 'hero.svg', hero(ICE, 'tubes', false))
write('ice-lab', 'logo.svg', iceMark(ICE))
console.log('demo artwork written')
