/**
 * Rendered maps, kept until the world changes.
 *
 * Rendering is cheap but not free, and the same picture is asked for far more
 * often than the world changes: every `/map`, and one more after every
 * conquest. The key is a hash of exactly the state a render depends on, so a
 * stale picture is impossible — if anything that would look different
 * changes, the key changes with it.
 */
import {createHash} from 'node:crypto';
import type {MapState} from './stylesheet.js';

/** How many rendered maps to keep. */
const CAPACITY = 32;

/** Hashes the state a render depends on, and nothing else. */
export function mapCacheKey(state: MapState, width: number): string {
  const shape = [
    state.region ?? 'world',
    String(width),
    ...state.countries
      .map(
        country =>
          `${country.code}:${country.status}:${country.ownerCode ?? ''}:${country.atWar ? 'w' : ''}`,
      )
      .sort(),
  ].join('|');
  return createHash('sha1').update(shape).digest('hex');
}

/** A small cache of rendered maps, evicting whatever was used longest ago. */
export class MapCache {
  private readonly entries = new Map<string, Buffer>();

  constructor(private readonly capacity = CAPACITY) {}

  /** How many renders are held. */
  get size(): number {
    return this.entries.size;
  }

  /** Returns a cached render, marking it as freshly used. */
  get(key: string): Buffer | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** Stores a render, evicting the least recently used if that fills it. */
  set(key: string, png: Buffer): void {
    this.entries.delete(key);
    this.entries.set(key, png);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Forgets everything, e.g. when a round is wiped. */
  clear(): void {
    this.entries.clear();
  }
}
