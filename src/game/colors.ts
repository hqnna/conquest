/**
 * Stable per-country colours, shared by country roles and the rendered map so
 * a country reads the same everywhere and keeps its colour across renders.
 */

/** Curated high-contrast palette; index chosen by hashing the country code. */
export const COUNTRY_PALETTE = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0,
  0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0xe6beff, 0x9a6324, 0x800000,
  0xaaffc3, 0x808000, 0xffd8b1, 0x000075, 0x2b8c8c, 0xff6f61,
] as const;

/** Grey used for countries nobody has claimed. */
export const INACTIVE_COLOR = 0xbfbfbf;

/**
 * Picks a country's colour deterministically from its ISO code, so the same
 * country is the same colour in every guild, render, and restart.
 */
export function countryColor(code: string): number {
  let hash = 0;
  for (const character of code.toUpperCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return COUNTRY_PALETTE[hash % COUNTRY_PALETTE.length];
}

/**
 * Darkens a colour towards black, used to render a conqueror's territories as
 * a dimmer shade of the empire's colour.
 *
 * @param factor 0 leaves the colour untouched, 1 makes it black.
 */
export function dim(color: number, factor: number): number {
  const clamp = Math.min(1, Math.max(0, factor));
  const channel = (shift: number) =>
    Math.round(((color >> shift) & 0xff) * (1 - clamp));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
