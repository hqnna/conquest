import {describe, expect, it} from 'vitest';
import {
  COUNTRIES,
  countryChannelName,
  countryLabel,
  countryRoleName,
  defeatedChannelName,
  findCountry,
  isCountryCode,
  searchCountries,
} from '../src/data/countries.js';

/** Rebuilds a flag from its code, to check the shipped data agrees. */
function flagFromCode(code: string): string {
  return [...code]
    .map(letter =>
      String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 'A'.charCodeAt(0)),
    )
    .join('');
}

describe('country data', () => {
  it('ships the ISO 3166-1 world', () => {
    expect(COUNTRIES.length).toBeGreaterThan(240);
    expect(findCountry('FR')?.name).toBe('France');
    expect(findCountry('JP')?.name).toBe('Japan');
  });

  it('has a unique, well-formed code for every country', () => {
    const codes = new Set<string>();
    for (const country of COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      expect(codes.has(country.code)).toBe(false);
      codes.add(country.code);
      expect(country.name.length).toBeGreaterThan(0);
      expect(country.region.length).toBeGreaterThan(0);
    }
  });

  it('flags match their country codes', () => {
    for (const country of COUNTRIES) {
      expect(country.flag).toBe(flagFromCode(country.code));
    }
  });

  it('looks countries up case-insensitively and rejects non-countries', () => {
    expect(findCountry('fr')).toBe(findCountry('FR'));
    expect(findCountry(' de ')?.code).toBe('DE');
    expect(findCountry('XX')).toBeUndefined();
    expect(isCountryCode('jp')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
  });
});

describe('searchCountries', () => {
  it('puts an exact code match first', () => {
    expect(searchCountries(COUNTRIES, 'fr')[0].code).toBe('FR');
  });

  it('prefers names that start with the query', () => {
    const results = searchCountries(COUNTRIES, 'ind');
    expect(results[0].name).toBe('India');
    expect(results.map(c => c.code)).toContain('ID');
  });

  it('matches anywhere in the name', () => {
    expect(searchCountries(COUNTRIES, 'guinea').map(c => c.code)).toContain(
      'PG',
    );
  });

  it('offers everything, name-ordered, for an empty query', () => {
    const all = searchCountries(COUNTRIES, '');
    expect(all).toHaveLength(COUNTRIES.length);
    expect(all[0].name.localeCompare(all[1].name)).toBeLessThanOrEqual(0);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchCountries(COUNTRIES, 'zzzzzz')).toEqual([]);
  });

  it('searches only the pool it is given', () => {
    const pool = COUNTRIES.filter(country => country.code === 'DE');
    expect(searchCountries(pool, 'france')).toEqual([]);
  });
});

describe('naming', () => {
  const france = findCountry('FR')!;

  it('builds channel names Discord will not rewrite', () => {
    expect(countryChannelName(france)).toBe('🇫🇷-france');
    expect(countryChannelName(findCountry('US')!)).toBe('🇺🇸-united-states');
    expect(countryChannelName(findCountry('CI')!)).toMatch(/^🇨🇮-[a-z0-9-]+$/);
  });

  it('strips accents rather than letting Discord mangle them', () => {
    for (const country of COUNTRIES) {
      const name = countryChannelName(country);
      expect(name.slice(country.flag.length)).toMatch(/^-[a-z0-9-]+$/);
    }
  });

  it('marks a defeated country with a white flag', () => {
    expect(defeatedChannelName(france)).toBe('🏳️-france');
  });

  it('names roles with the flag', () => {
    expect(countryRoleName(france)).toBe('🇫🇷 France');
    expect(countryLabel(france)).toBe('🇫🇷 France');
  });
});
