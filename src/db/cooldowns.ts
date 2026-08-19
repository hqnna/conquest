import type {Database} from 'better-sqlite3';

/** Gather commands are rate-limited per player, per command. */
export type GatherCommand = 'farm' | 'mine' | 'recruit';

/** Every gather command, in the order `/resources` lists them. */
export const GATHER_COMMANDS: readonly GatherCommand[] = [
  'farm',
  'mine',
  'recruit',
];

/**
 * When a player may next run a gather command, or null if they may now.
 *
 * Cooldowns are absolute timestamps rather than timers, so they survive a
 * restart and cannot be reset by bouncing the bot.
 */
export function getCooldown(
  db: Database,
  guildId: string,
  userId: string,
  command: GatherCommand,
): number | null {
  const row = db
    .prepare(
      `SELECT next_available_at FROM gather_cooldowns
        WHERE guild_id = ? AND user_id = ? AND command = ?`,
    )
    .get(guildId, userId, command) as {next_available_at: number} | undefined;
  return row?.next_available_at ?? null;
}

/** Starts or extends a player's cooldown on one command. */
export function setCooldown(
  db: Database,
  guildId: string,
  userId: string,
  command: GatherCommand,
  until: number,
): void {
  db.prepare(
    `INSERT INTO gather_cooldowns (guild_id, user_id, command, next_available_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, command) DO UPDATE SET
       next_available_at = excluded.next_available_at`,
  ).run(guildId, userId, command, until);
}

/** All of one player's cooldowns, for `/resources`. */
export function listCooldowns(
  db: Database,
  guildId: string,
  userId: string,
): Map<GatherCommand, number> {
  const rows = db
    .prepare(
      'SELECT command, next_available_at FROM gather_cooldowns WHERE guild_id = ? AND user_id = ?',
    )
    .all(guildId, userId) as Array<{
    command: GatherCommand;
    next_available_at: number;
  }>;
  return new Map(rows.map(row => [row.command, row.next_available_at]));
}

/** Forgets a guild's cooldowns, as when the game resets. */
export function clearCooldowns(db: Database, guildId: string): void {
  db.prepare('DELETE FROM gather_cooldowns WHERE guild_id = ?').run(guildId);
}
