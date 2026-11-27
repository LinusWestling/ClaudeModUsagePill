/**
 * The drawings are SVG images, and an image can't read the app's theme colours.
 * What it does follow is the embedding page's colour scheme, through the
 * `prefers-color-scheme` media query: each drawing is written for dark mode and
 * gives its light-mode colours here.
 */
export const inLight = (rules: string) => `@media (prefers-color-scheme:light){${rules}}`

/**
 * A track or hairline that reads on either background: a mid grey at low
 * opacity darkens a light panel and lightens a dark one alike.
 */
export const NEUTRAL = (opacity: number) => `rgba(128,128,128,${opacity})`
