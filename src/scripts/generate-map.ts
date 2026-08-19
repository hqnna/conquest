/**
 * Regenerates the world map Conquest colours in, from Natural Earth data.
 *
 * Both the SVG and its metadata are committed, so the running bot has no
 * dependency on the map packages and the world cannot shift under a game.
 * Rerun with `pnpm generate-map`.
 *
 * Every country path carries its ISO 3166-1 alpha-2 code as its `id`, the
 * same code used in `countries.json` and in every `country_code` in the
 * database, so colouring a country is a lookup rather than a search.
 */
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {geoNaturalEarth1, geoPath} from 'd3-geo';
import {feature} from 'topojson-client';
import type {Topology} from 'topojson-specification';
import type {Country} from 'world-countries';

const require = createRequire(import.meta.url);
const countries = require('world-countries') as Country[];
const topology = require('world-atlas/countries-50m.json') as Topology;

/** Canvas the map is projected into. */
const WIDTH = 1200;
const HEIGHT = 620;

/** Numeric ISO 3166-1 to alpha-2, which is what the game keys everything on. */
const ALPHA_2_BY_NUMERIC = new Map(
  countries.map(country => [country.ccn3, country.cca2.toUpperCase()]),
);

/** Continent per country, for cropping the map to one. */
const REGION_BY_CODE = new Map(
  countries.map(country => [country.cca2.toUpperCase(), country.region]),
);

interface CountryFeature {
  id?: string | number;
  type: string;
  properties?: {name?: string};
  geometry: unknown;
}

const collection = feature(topology, topology.objects.countries) as unknown as {
  features: CountryFeature[];
};

const projection = geoNaturalEarth1().fitSize([WIDTH, HEIGHT], {
  type: 'Sphere',
} as never);
// One decimal place is finer than a pixel at this size, and keeps the shipped
// asset a fraction of what full precision would cost.
const path = geoPath(projection).digits(1);

interface Rendered {
  code: string;
  d: string;
  bounds: [[number, number], [number, number]];
  centre: [number, number];
}

const rendered: Rendered[] = [];
for (const country of collection.features) {
  const code = ALPHA_2_BY_NUMERIC.get(String(country.id));
  if (!code) continue;
  const d = path(country as never);
  if (!d) continue;
  rendered.push({
    code,
    d,
    bounds: path.bounds(country as never),
    centre: path.centroid(country as never) as [number, number],
  });
}
rendered.sort((a, b) => a.code.localeCompare(b.code));

/** Tukey fences, which drop the far-flung without a magic threshold. */
function inlierRange(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const q1 = at(0.25);
  const q3 = at(0.75);
  const fence = (q3 - q1) * 1.5;
  return [
    Math.max(sorted[0], q1 - fence),
    Math.min(sorted[sorted.length - 1], q3 + fence),
  ];
}

/**
 * The box a region is cropped to.
 *
 * Built from country centres rather than their full extents, and trimmed to
 * the inliers: France's Pacific islands and Russia's far east are genuinely
 * in their regions, but a box that contained them would be the whole world
 * and crop nothing. Countries at the edge simply bleed past the crop, which
 * is what a crop is for.
 */
function regionBox(codes: readonly string[]): [number, number, number, number] {
  const centres = rendered
    .filter(entry => codes.includes(entry.code))
    .map(entry => entry.centre)
    .filter(centre => Number.isFinite(centre[0]) && Number.isFinite(centre[1]));
  if (centres.length === 0) return [0, 0, WIDTH, HEIGHT];

  const [minX, maxX] = inlierRange(centres.map(centre => centre[0]));
  const [minY, maxY] = inlierRange(centres.map(centre => centre[1]));

  // Enough padding to show whole countries whose centre sits on the edge.
  const padding = 45;
  const x = Math.max(0, Math.round(minX - padding));
  const y = Math.max(0, Math.round(minY - padding));
  return [
    x,
    y,
    Math.min(WIDTH - x, Math.round(maxX - minX + padding * 2)),
    Math.min(HEIGHT - y, Math.round(maxY - minY + padding * 2)),
  ];
}

const regions: Record<string, [number, number, number, number]> = {};
for (const region of new Set(REGION_BY_CODE.values())) {
  if (!region) continue;
  const codes = rendered
    .map(entry => entry.code)
    .filter(code => REGION_BY_CODE.get(code) === region);
  if (codes.length === 0) continue;
  regions[region] = regionBox(codes);
}

const paths = rendered
  .map(entry => `<path id="${entry.code}" d="${entry.d}"/>`)
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
<style id="conquest-colors"></style>
<rect id="ocean" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"/>
<g id="countries">
${paths}
</g>
</svg>
`;

const target = (name: string) =>
  fileURLToPath(new URL(`../data/${name}`, import.meta.url));

writeFileSync(target('world.svg'), svg);
writeFileSync(
  target('world-map.json'),
  `${JSON.stringify(
    {
      width: WIDTH,
      height: HEIGHT,
      codes: rendered.map(entry => entry.code),
      regions,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Wrote ${rendered.length} country paths and ${Object.keys(regions).length} regions.`,
);
