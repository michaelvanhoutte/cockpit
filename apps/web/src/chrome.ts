/**
 * A workspace's tint, as it is drawn *on* the chrome rather than on the sheet.
 *
 * The chrome is near-black in every theme now ("Cockpit Shell Explorations",
 * artboard 2c), and the tints were designed to be read on a page: at their own
 * saturation a seven-pixel dot of one on a near-black bar is a smudge, and the
 * Capture tab filled with one cannot carry the app's ink at all. Lifting the
 * colour towards white keeps the hue - which is the whole job of a tint - and
 * gives it the contrast the surface under it takes.
 *
 * **Seventy percent, once, here.** It is the mix the artboard's own violet
 * measures at, and every place that draws a tint on the chrome has to use the
 * same one or two shades of the same workspace appear in one bar.
 *
 * A `color-mix` rather than a computed hex, because the tint arrives as a
 * string from the workspace and mixing it in CSS keeps this a stylesheet
 * question; nothing here has to parse a colour.
 */
export function litForChrome(tint: string): string {
  return `color-mix(in srgb, ${tint} 70%, white)`;
}
