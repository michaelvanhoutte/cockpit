import { STYLE } from '../../src/look';

/**
 * What a chart palette has to clear, worked out from the stylesheet the Monitor
 * serves: the WCAG contrast of a mark against its well, and how far apart two
 * colours read as OKLab distance times 100, with normal vision and with
 * protanopia and deuteranopia as Machado, Oliveira and Fernandes (2009)
 * simulate them at full severity. The matrices and the lightness maths are the
 * dataviz skill's validate_palette.js, which the thresholds are calibrated to.
 */

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

type Rgb = [number, number, number];

const channels = (hex: string): Rgb => {
  // #fff is #ffffff.
  const full = /^#[0-9a-f]{3}$/i.test(hex) ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  if (!/^#[0-9a-f]{6}$/i.test(full)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const linear = (hex: string): Rgb => channels(hex).map(toLinear) as Rgb;

const luminance = (hex: string) => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const oklab = ([r, g, b]: Rgb): Rgb => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};

const simulate = (hex: string, kind: keyof typeof MACHADO): Rgb => {
  const lin = linear(hex);
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return MACHADO[kind].map((row) => clamp(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])) as Rgb;
};

const distance = (a: Rgb, b: Rgb) => 100 * Math.hypot(...(oklab(a).map((v, i) => v - oklab(b)[i]!) as Rgb));

/** How far apart two colours read to someone with normal colour vision. */
export const apart = (a: string, b: string) => distance(linear(a), linear(b));
/** How far apart they read to the worse off of a protan and a deutan reader. */
export const apartColourBlind = (a: string, b: string) => Math.min(...(['protan', 'deutan'] as const).map((kind) => distance(simulate(a, kind), simulate(b, kind))));

// ---- The palette as the stylesheet declares it

export type Theme = 'light' | 'dark';

/** The custom properties a block of the stylesheet declares, name to value. */
function declared(block: string): Record<string, string> {
  return Object.fromEntries(
    block
      .split(';')
      .map((d) => /^\s*(--[\w-]+)\s*:\s*(.*?)\s*$/s.exec(d))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

/** A colour the stylesheet writes as a hex or as `color-mix(in srgb, var(--x) N%, #hex)`, which is all the well needs. */
function resolve(value: string, from: Record<string, string>): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const mix = /^color-mix\(in srgb,var\((--[\w-]+)\) (\d+)%,(#[0-9a-f]{3,6})\)$/i.exec(value);
  if (!mix) throw new Error(`The stylesheet writes a colour this check cannot resolve: ${value}`);
  const share = Number(mix[2]) / 100;
  const [base, over] = [channels(resolve(from[mix[1]!]!, from)), channels(mix[3]!)];
  return `#${base.map((c, i) => Math.round(c * share + over[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

/** Every colour a theme of the stylesheet declares, the dark theme's over the light's. */
export function paletteOf(theme: Theme): { well: string; slots: string[]; grey: string } {
  const light = declared(/:root\{([^}]*)\}/.exec(STYLE)![1]!);
  const dark = declared(/:root\[data-appearance=dark\]\{([^}]*)\}/.exec(STYLE)![1]!);
  const all = theme === 'light' ? light : { ...light, ...dark };
  const colour = (name: string) => {
    if (all[name] === undefined) throw new Error(`The ${theme} stylesheet declares no ${name}`);
    return resolve(all[name], all);
  };
  return { well: colour('--well'), slots: Array.from({ length: 8 }, (_, i) => colour(`--series-${i + 1}`)), grey: colour('--series-grey') };
}
