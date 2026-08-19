/**
 * Rendering the world as it currently stands.
 */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {listCountries} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {listPendingInvasions} from '../db/invasions.js';
import {MapCache, mapCacheKey} from './cache.js';
import type {Rasterizer} from './rasterizer.js';
import {selectRasterizer} from './rasterizer.js';
import {paint} from './stylesheet.js';
import type {MapCountry, MapState} from './stylesheet.js';

export {MAP_REGIONS, WORLD_MAP} from './stylesheet.js';
export type {MapState} from './stylesheet.js';

/** Width the map is rendered at. Wide enough to read on a phone. */
export const MAP_WIDTH = 1400;

/**
 * Reads the world as the map sees it: who holds what, and who is at war.
 *
 * Countries with no row have never been touched and are drawn inactive, so
 * only what is in play needs reading.
 */
export function mapState(
  db: Database,
  guildId: string,
  region?: string,
): MapState {
  const atWar = new Set<string>();
  for (const invasion of listPendingInvasions(db, guildId)) {
    atWar.add(invasion.attackerCode);
    atWar.add(invasion.defenderCode);
  }

  const countries: MapCountry[] = listCountries(db, guildId)
    .filter(country => country.status !== 'inactive')
    .map(country => ({
      code: country.code,
      ownerCode: country.ownerCode,
      status: country.status === 'defeated' ? 'defeated' : 'active',
      atWar: atWar.has(country.code),
    }));

  return {countries, region};
}

/** Renders maps, caching each picture until the world changes. */
export class MapRenderer {
  private readonly cache = new MapCache();
  private base?: string;

  constructor(private readonly rasterizer: Rasterizer) {}

  /** The backend in use, for the startup log. */
  get backend(): string {
    return this.rasterizer.name;
  }

  /**
   * Renders a state, or returns the identical picture rendered earlier.
   *
   * @returns the PNG, and whether it came from the cache.
   */
  async render(
    state: MapState,
    width = MAP_WIDTH,
  ): Promise<{png: Buffer; cached: boolean}> {
    const key = mapCacheKey(state, width);
    const hit = this.cache.get(key);
    if (hit) return {png: hit, cached: true};

    this.base ??= await readFile(
      fileURLToPath(new URL('../data/world.svg', import.meta.url)),
      'utf8',
    );
    const png = await this.rasterizer.render(paint(this.base, state), width);
    this.cache.set(key, png);
    return {png, cached: false};
  }

  /** Forgets every rendered map, e.g. when a round is wiped. */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Builds the renderer, or nothing if no rasterizer will load.
 *
 * A missing rasterizer is a working state rather than a failure: `/map` falls
 * back to text standings, which is what it showed before the map existed.
 */
export async function createMapRenderer(): Promise<MapRenderer | undefined> {
  const rasterizer = await selectRasterizer();
  return rasterizer && new MapRenderer(rasterizer);
}
