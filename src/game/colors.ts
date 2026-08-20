/**
 * Stable per-country colours, shared by country roles and the rendered map so
 * a country reads the same everywhere and keeps its colour across renders.
 */

/**
 * Curated high-contrast palette; index chosen by hashing the country code.
 *
 * Every colour has to stay legible against the sea, both at full strength and
 * once shaded down into a territory. That rules out very dark colours: a
 * near-black maroon or navy sits at the same brightness as the water and
 * leaves a country looking like it is not on the map at all.
 */
export const COUNTRY_PALETTE = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0xb532dd, 0x46f0f0,
  0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0xe6beff, 0x9a6324, 0xff0000,
  0xaaffc3, 0x808000, 0xffd8b1, 0x5656ff, 0x2b8c8c, 0xff6f61,
] as const;

/** Grey used for countries nobody has claimed. */
export const INACTIVE_COLOR = 0xbfbfbf;

/**
 * The sea the map is drawn on, and the colour a conquered country is shaded
 * towards. Territories are blended into the map's own background rather than
 * into black, which is what keeps them from disappearing.
 */
export const OCEAN_COLOR = 0x0b1c2c;

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
 * Blends one colour towards another, channel by channel.
 *
 * Territories are shaded with this rather than by scaling towards black.
 * Scaling multiplies every channel, which drains a colour of the very thing
 * that identifies its owner: a pale country turns muddy grey, and a dark one
 * falls below the sea it is drawn on and vanishes. Blending towards the sea
 * moves a colour along a line that ends at the map's own background, so the
 * hue survives the whole way and the result can never be darker than the
 * water around it.
 *
 * @param amount 0 leaves `from` untouched, 1 returns `to`.
 */
export function blend(from: number, to: number, amount: number): number {
  const clamp = Math.min(1, Math.max(0, amount));
  const channel = (shift: number) => {
    const start = (from >> shift) & 0xff;
    const end = (to >> shift) & 0xff;
    return Math.round(start + (end - start) * clamp);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
