import type { Outfit } from '../types'

/** The mascot, on a 16 by 16 grid: the body is fixed, and an outfit is drawn over it. */

export const OUTFITS: readonly Outfit[] = [
  'explorer',
  'hardhat',
  'wizard',
  'tophat',
  'cowboy',
  'pirate',
  'chef',
  'royal',
  'shades',
  'headphones',
]

/** `moving` walks, `still` stands, and the last two wear the agent's result on the face. */
export type Mood = 'moving' | 'still' | 'done' | 'failed'

type Pixel = readonly [x: number, y: number, w: number, h: number, color: string]

const BODY = '#D97757'
const EYE = '#1F1A17'

const SHAPE: Pixel[] = [
  [3, 6, 10, 6, BODY],
  [1, 8, 2, 2, BODY],
  [13, 8, 2, 2, BODY],
]

const legs = (at: readonly number[]): Pixel[] => at.map(x => [x, 12, 1, 2, BODY])
const STANDING = legs([4, 6, 9, 11])
const STRIDING = legs([3, 5, 10, 12])

const OPEN_EYES: Pixel[] = [
  [5, 8, 1, 2, EYE],
  [10, 8, 1, 2, EYE],
]

const EYES: Record<Mood, Pixel[]> = {
  moving: OPEN_EYES,
  still: OPEN_EYES,
  done: [
    [4, 9, 1, 1, EYE],
    [5, 8, 1, 1, EYE],
    [6, 9, 1, 1, EYE],
    [9, 9, 1, 1, EYE],
    [10, 8, 1, 1, EYE],
    [11, 9, 1, 1, EYE],
  ],
  failed: [
    [4, 7, 1, 1, EYE],
    [6, 7, 1, 1, EYE],
    [5, 8, 1, 1, EYE],
    [4, 9, 1, 1, EYE],
    [6, 9, 1, 1, EYE],
    [9, 7, 1, 1, EYE],
    [11, 7, 1, 1, EYE],
    [10, 8, 1, 1, EYE],
    [9, 9, 1, 1, EYE],
    [11, 9, 1, 1, EYE],
  ],
}

const CLOTHES: Record<Outfit, Pixel[]> = {
  explorer: [
    [5, 2, 6, 3, '#B8935A'],
    [5, 4, 6, 1, '#6B4F2A'],
    [2, 5, 12, 1, '#C9A66B'],
    [3, 11, 10, 1, '#C0392B'],
  ],
  hardhat: [
    [7, 2, 2, 1, '#F5C542'],
    [4, 3, 8, 3, '#F5C542'],
    [3, 5, 10, 1, '#E0AC2B'],
    [4, 10, 8, 2, '#FF8A3D'],
    [4, 10, 8, 1, '#F7F24B'],
  ],
  wizard: [
    [7, 0, 2, 1, '#6C4AD6'],
    [6, 1, 4, 1, '#6C4AD6'],
    [5, 2, 6, 2, '#6C4AD6'],
    [4, 4, 8, 1, '#6C4AD6'],
    [2, 5, 12, 1, '#54379F'],
    [7, 2, 1, 1, '#FFD166'],
    [9, 3, 1, 1, '#FFD166'],
  ],
  tophat: [
    [5, 0, 6, 5, '#26262B'],
    [5, 3, 6, 1, '#C0392B'],
    [3, 5, 10, 1, '#26262B'],
    [6, 10, 1, 2, '#C0392B'],
    [9, 10, 1, 2, '#C0392B'],
    [7, 10, 2, 1, '#C0392B'],
  ],
  cowboy: [
    [5, 2, 6, 3, '#7A4E2D'],
    [7, 2, 2, 1, '#5F3B20'],
    [1, 5, 14, 1, '#7A4E2D'],
    [1, 4, 2, 1, '#7A4E2D'],
    [13, 4, 2, 1, '#7A4E2D'],
    [3, 10, 10, 1, '#2F6DB5'],
  ],
  pirate: [
    [6, 2, 4, 1, '#26262B'],
    [4, 3, 8, 2, '#26262B'],
    [2, 5, 12, 1, '#111114'],
    [7, 3, 2, 1, '#EEEEEE'],
    [3, 7, 10, 1, '#111114'],
    [4, 8, 3, 2, '#111114'],
  ],
  chef: [
    [5, 0, 6, 1, '#F2F2F2'],
    [4, 1, 8, 3, '#F2F2F2'],
    [5, 4, 6, 2, '#D8D8D8'],
    [5, 10, 6, 2, '#F2F2F2'],
  ],
  royal: [
    [4, 2, 1, 2, '#F5C542'],
    [7, 2, 2, 2, '#F5C542'],
    [11, 2, 1, 2, '#F5C542'],
    [4, 4, 8, 2, '#F5C542'],
    [7, 4, 2, 1, '#D64545'],
    [3, 11, 10, 1, '#7B2D8E'],
  ],
  shades: [
    [4, 3, 8, 3, '#3F8CFF'],
    [9, 5, 6, 1, '#2E6FCC'],
    [4, 8, 3, 2, '#111114'],
    [9, 8, 3, 2, '#111114'],
    [7, 8, 2, 1, '#111114'],
  ],
  headphones: [
    [3, 4, 10, 1, '#55555C'],
    [2, 5, 1, 1, '#55555C'],
    [13, 5, 1, 1, '#55555C'],
    [2, 6, 1, 3, '#E36BFF'],
    [13, 6, 1, 3, '#E36BFF'],
  ],
}

const pixels = (list: readonly Pixel[]): string =>
  list
    .map(([x, y, w, h, color]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`)
    .join('')

/** The rules `mascotMarkup`'s classes need, for the `<style>` of the drawing holding it. */
export const MASCOT_STYLE =
  `.m-bob{animation:m-bob .5s steps(1) infinite}` +
  `.m-a{animation:m-a .5s steps(1) infinite}.m-b{animation:m-b .5s steps(1) infinite}` +
  `@keyframes m-bob{50%{transform:translateY(-1px)}}` +
  `@keyframes m-a{0%{opacity:1}50%{opacity:0}}` +
  `@keyframes m-b{0%{opacity:0}50%{opacity:1}}` +
  `@media (prefers-reduced-motion:reduce){.m-bob,.m-a,.m-b{animation:none}.m-b{opacity:0}}`

/** The mascot in grid units, with no outfit if none is given: place it with a transform. */
export const mascotMarkup = (mood: Mood, outfit?: Outfit): string => {
  const isMoving = mood === 'moving'
  const feet = isMoving
    ? `<g class="m-a">${pixels(STANDING)}</g><g class="m-b">${pixels(STRIDING)}</g>`
    : pixels(STANDING)
  const parts = pixels(SHAPE) + feet + pixels(EYES[mood]) + (outfit ? pixels(CLOTHES[outfit]) : '')

  return isMoving ? `<g class="m-bob">${parts}</g>` : `<g>${parts}</g>`
}

/** The mascot as a drawing of its own. */
export const mascotSvg = (mood: Mood, outfit: Outfit | undefined, size: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">` +
  `<style>${MASCOT_STYLE}</style>${mascotMarkup(mood, outfit)}</svg>`

const BY_TYPE: Record<string, Outfit> = {
  Explore: 'explorer',
  Plan: 'hardhat',
  'claude-code-guide': 'wizard',
}

/** The type's own outfit if free, else the first not in use, so agents side by side differ. */
export const pickOutfit = (type: string, taken: readonly Outfit[]): Outfit => {
  const own = BY_TYPE[type]

  if (own && !taken.includes(own)) return own

  // Past the last outfit they repeat, in order.
  return OUTFITS.find(o => !taken.includes(o)) ?? OUTFITS[taken.length % OUTFITS.length]!
}
