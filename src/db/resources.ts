import type {Database} from 'better-sqlite3';

/** A country's shared pool. Resources belong to the country, not the player. */
export interface Stockpile {
  food: number;
  gold: number;
  troops: number;
}

/** An amount to add to or take from a stockpile. */
export type ResourceDelta = Partial<Stockpile>;

/** The pool of an active country, or undefined if there is no such country. */
export function getStockpile(
  db: Database,
  guildId: string,
  code: string,
): Stockpile | undefined {
  return db
    .prepare(
      'SELECT food, gold, troops FROM countries WHERE guild_id = ? AND code = ?',
    )
    .get(guildId, code) as Stockpile | undefined;
}

/** Adds to a country's pool. Negative amounts are not this function's job. */
export function addResources(
  db: Database,
  guildId: string,
  code: string,
  delta: ResourceDelta,
): void {
  db.prepare(
    `UPDATE countries
        SET food = food + ?, gold = gold + ?, troops = troops + ?
      WHERE guild_id = ? AND code = ?`,
  ).run(delta.food ?? 0, delta.gold ?? 0, delta.troops ?? 0, guildId, code);
}

/**
 * Takes resources out of a country's pool, but only if they are all there.
 *
 * The check and the deduction are one statement, so two players spending the
 * same gold at the same moment cannot both succeed.
 *
 * @returns whether the country could afford it.
 */
export function spendResources(
  db: Database,
  guildId: string,
  code: string,
  cost: ResourceDelta,
): boolean {
  const food = cost.food ?? 0;
  const gold = cost.gold ?? 0;
  const troops = cost.troops ?? 0;
  const result = db
    .prepare(
      `UPDATE countries
          SET food = food - ?, gold = gold - ?, troops = troops - ?
        WHERE guild_id = ? AND code = ?
          AND food >= ? AND gold >= ? AND troops >= ?`,
    )
    .run(food, gold, troops, guildId, code, food, gold, troops);
  return result.changes === 1;
}

/**
 * Moves everything one country has into another, as when its stockpile is
 * looted after a conquest.
 *
 * @returns what was taken.
 */
export function lootStockpile(
  db: Database,
  guildId: string,
  fromCode: string,
  toCode: string,
): Stockpile {
  return db.transaction(() => {
    const taken = getStockpile(db, guildId, fromCode) ?? {
      food: 0,
      gold: 0,
      troops: 0,
    };
    db.prepare(
      `UPDATE countries SET food = 0, gold = 0, troops = 0
        WHERE guild_id = ? AND code = ?`,
    ).run(guildId, fromCode);
    addResources(db, guildId, toCode, taken);
    return taken;
  })();
}
