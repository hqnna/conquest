/**
 * Colouring the world.
 *
 * The base SVG is never rewritten path by path: Conquest injects one
 * stylesheet, and CSS beats the presentation attributes already on the paths.
 * That keeps the shipped asset untouched, makes a render a string
 * concatenation, and means a country's colour is a lookup by its ISO code
 * rather than a search through geometry.
 */
import worldMap from '../data/world-map.json' with {type: 'json'};
import {INACTIVE_COLOR, countryColor, dim} from '../game/colors.js';

/** Geometry and regions of the shipped map. */
export interface WorldMap {
  width: number;
  height: number;
  /** Every country the map can actually draw. */
  codes: string[];
  /** Continent name to `[x, y, width, height]` viewBox. */
  regions: Record<string, number[]>;
}

export const WORLD_MAP: WorldMap = worldMap;

/** Continents the map can be cropped to. */
export const MAP_REGIONS = Object.keys(WORLD_MAP.regions).sort();

/** How a country should be drawn. */
export interface MapCountry {
  code: string;
  /** Active countries get their own colour; territories take their owner's. */
  ownerCode: string | null;
  status: 'active' | 'defeated';
  /** Drawn with a red edge, so a war is visible on the map. */
  atWar: boolean;
}

/** Everything a render depends on. */
export interface MapState {
  countries: MapCountry[];
  /** Continent to crop to, or undefined for the whole world. */
  region?: string;
}

/** Renders a colour as CSS. */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * How dark a conquered territory is drawn against its owner's colour, so an
 * empire reads as one blob with a bright capital.
 */
const TERRITORY_DIMMING = 0.45;

/** The colour a country is drawn in. */
export function fillFor(country: MapCountry): number {
  if (country.status === 'defeated') {
    return country.ownerCode
      ? dim(countryColor(country.ownerCode), TERRITORY_DIMMING)
      : INACTIVE_COLOR;
  }
  return countryColor(country.code);
}

/**
 * Builds the stylesheet for one world state.
 *
 * Only countries that are in play get a rule; everything else inherits the
 * inactive fill, so the sheet stays small however big the world gets.
 */
export function stylesheet(state: MapState): string {
  // The default is deliberately a bare type selector: a per-country `#FR`
  // rule has to outrank it, and `#countries path` would outrank *it* on
  // specificity and leave the whole world grey.
  const rules = [
    '#ocean{fill:#0b1c2c}',
    `path{fill:${hex(INACTIVE_COLOR)};stroke:#0b1c2c;stroke-width:0.5}`,
  ];

  for (const country of state.countries) {
    if (!WORLD_MAP.codes.includes(country.code)) continue;
    rules.push(`#${country.code}{fill:${hex(fillFor(country))}}`);
  }

  const atWar = state.countries
    .filter(country => country.atWar && WORLD_MAP.codes.includes(country.code))
    .map(country => `#${country.code}`);
  if (atWar.length > 0) {
    rules.push(`${atWar.join(',')}{stroke:#ff3b30;stroke-width:1.6}`);
  }

  return rules.join('');
}

/** The viewBox for a state: one continent, or the whole world. */
export function viewBoxFor(state: MapState): string {
  const region = state.region && WORLD_MAP.regions[state.region];
  if (!region) return `0 0 ${WORLD_MAP.width} ${WORLD_MAP.height}`;
  return region.join(' ');
}

/**
 * Paints a world state onto the base SVG.
 *
 * @param base the shipped SVG, with its empty stylesheet placeholder.
 */
export function paint(base: string, state: MapState): string {
  const painted = base.replace(
    '<style id="conquest-colors"></style>',
    `<style id="conquest-colors">${stylesheet(state)}</style>`,
  );
  // A crop has its own aspect ratio, and the canvas must match it or the
  // render is letterboxed against the uncropped one.
  const [, , width, height] = viewBoxFor(state).split(' ').map(Number);
  return painted
    .replace(/viewBox="[^"]*"/, `viewBox="${viewBoxFor(state)}"`)
    .replace(/width="[^"]*"/, `width="${width}"`)
    .replace(/height="[^"]*"/, `height="${height}"`);
}
