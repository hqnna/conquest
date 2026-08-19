/**
 * Regenerates `src/data/countries.json` from the `world-countries` dataset.
 *
 * The result is committed, so Conquest itself has no dependency on that
 * package and the country list cannot shift under a running game. Rerun with
 * `pnpm generate-countries` after updating the dataset.
 *
 * ISO 3166-1 alpha-2 codes are the join between this file, the map SVG, and
 * every `country_code` in the database — they must stay identical.
 */
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import type {Country} from 'world-countries';

// world-countries publishes no export map, so Node resolves it as CommonJS.
const countries = createRequire(import.meta.url)(
  'world-countries',
) as Country[];

interface CountryEntry {
  code: string;
  name: string;
  flag: string;
  region: string;
}

/** Derives the flag emoji from a country code's regional indicator letters. */
function flagFromCode(code: string): string {
  const REGIONAL_INDICATOR_A = 0x1f1e6;
  return [...code.toUpperCase()]
    .map(letter =>
      String.fromCodePoint(
        REGIONAL_INDICATOR_A + letter.charCodeAt(0) - 'A'.charCodeAt(0),
      ),
    )
    .join('');
}

const entries: CountryEntry[] = countries
  .map(country => ({
    code: country.cca2.toUpperCase(),
    name: country.name.common,
    flag: flagFromCode(country.cca2),
    region: country.region,
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

const target = fileURLToPath(
  new URL('../data/countries.json', import.meta.url),
);
writeFileSync(target, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Wrote ${entries.length} countries to ${target}`);
