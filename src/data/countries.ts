import countriesJson from './countries.json' with {type: 'json'};

/** A real-world country, as shipped in `countries.json`. */
export interface CountryData {
  /** ISO 3166-1 alpha-2 code, uppercase. The key everything else joins on. */
  code: string;
  /** Common English name, e.g. `DR Congo`. */
  name: string;
  /** Flag emoji, used in role names, channel names, and copy. */
  flag: string;
  /** Continent, used to crop the map and group listings. */
  region: string;
}

/** Every country in the game, sorted by code. All of them always exist. */
export const COUNTRIES: readonly CountryData[] = countriesJson as CountryData[];

const BY_CODE = new Map(COUNTRIES.map(country => [country.code, country]));

/** Looks a country up by ISO code, case-insensitively. */
export function findCountry(code: string): CountryData | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

/** Whether a string is a known country code. */
export function isCountryCode(code: string): boolean {
  return BY_CODE.has(code.trim().toUpperCase());
}

/**
 * Ranks countries against an autocomplete query, matching on name substring
 * and ISO code. Exact code matches come first, then names that start with the
 * query, then everything else that contains it — so typing `fr` offers France
 * before Central African Republic.
 *
 * @param query raw user input; empty offers everything in name order.
 */
export function searchCountries(
  countries: readonly CountryData[],
  query: string,
): CountryData[] {
  const needle = query.trim().toLowerCase();
  const byName = [...countries].sort((a, b) => a.name.localeCompare(b.name));
  if (needle.length === 0) return byName;

  const score = (country: CountryData): number => {
    const name = country.name.toLowerCase();
    const code = country.code.toLowerCase();
    if (code === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    if (code.startsWith(needle)) return 3;
    return Number.POSITIVE_INFINITY;
  };

  return byName
    .map(country => ({country, rank: score(country)}))
    .filter(entry => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.country);
}

/** How a country reads in listings and announcements: `🇫🇷 France`. */
export function countryLabel(country: CountryData): string {
  return `${country.flag} ${country.name}`;
}

/**
 * Discord channel name for a country's private channel, e.g. `🇫🇷-france`.
 *
 * Discord lowercases names and replaces runs of unsupported characters with a
 * dash; doing it here keeps the stored name and the real one identical.
 */
export function countryChannelName(country: CountryData): string {
  const slug = country.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${country.flag}-${slug}`;
}

/** Channel name for a country that has been conquered, e.g. `🏳️-france`. */
export function defeatedChannelName(country: CountryData): string {
  return `🏳️-${countryChannelName(country).split('-').slice(1).join('-')}`;
}

/** Discord role name for a country, e.g. `🇫🇷 France`. */
export function countryRoleName(country: CountryData): string {
  return countryLabel(country);
}
