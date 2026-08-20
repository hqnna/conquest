import {describe, expect, it} from 'vitest';
import {COUNTRIES} from '../src/data/countries.js';
import {
  COUNTRY_PALETTE,
  OCEAN_COLOR,
  blend,
  countryColor,
} from '../src/game/colors.js';

describe('countryColor', () => {
  it('gives a country the same colour every time', () => {
    expect(countryColor('FR')).toBe(countryColor('FR'));
    expect(countryColor('fr')).toBe(countryColor('FR'));
  });

  it('always lands in the palette', () => {
    for (const country of COUNTRIES) {
      expect(COUNTRY_PALETTE).toContain(countryColor(country.code));
    }
  });

  it('spreads the world across the whole palette', () => {
    const used = new Set(COUNTRIES.map(country => countryColor(country.code)));
    expect(used.size).toBe(COUNTRY_PALETTE.length);
  });
});

describe('blend', () => {
  it('leaves a colour alone at zero', () => {
    expect(blend(0x3cb44b, OCEAN_COLOR, 0)).toBe(0x3cb44b);
  });

  it('arrives at the target at one', () => {
    expect(blend(0x3cb44b, OCEAN_COLOR, 1)).toBe(OCEAN_COLOR);
  });

  it('meets in the middle', () => {
    expect(blend(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });

  it('clamps amounts outside the range', () => {
    expect(blend(0xffffff, 0x000000, -1)).toBe(0xffffff);
    expect(blend(0xffffff, 0x000000, 2)).toBe(0x000000);
  });

  it('moves a channel towards the target, not always downwards', () => {
    // Scaling towards black could only ever darken; a blend has to be able to
    // raise a channel the target is brighter in, which is what keeps a dark
    // colour from sinking into the sea.
    expect(blend(0x800000, OCEAN_COLOR, 0.4) & 0xff).toBeGreaterThan(0);
  });
});
