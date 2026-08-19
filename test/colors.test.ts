import {describe, expect, it} from 'vitest';
import {COUNTRIES} from '../src/data/countries.js';
import {COUNTRY_PALETTE, countryColor, dim} from '../src/game/colors.js';

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

describe('dim', () => {
  it('leaves a colour alone at zero', () => {
    expect(dim(0x3cb44b, 0)).toBe(0x3cb44b);
  });

  it('goes black at one', () => {
    expect(dim(0x3cb44b, 1)).toBe(0x000000);
  });

  it('darkens each channel proportionally', () => {
    expect(dim(0xffffff, 0.5)).toBe(0x808080);
  });

  it('clamps factors outside the range', () => {
    expect(dim(0xffffff, -1)).toBe(0xffffff);
    expect(dim(0xffffff, 2)).toBe(0x000000);
  });
});
