/**
 * Winning the round, and starting the next one.
 *
 * There is one way to win: total conquest. A country wins the moment it is
 * the only one left active and it got there by taking somebody — every other
 * country that raised a flag this round is now its territory. The check reads
 * stored state on every sweep, so it does not depend on a timer surviving a
 * restart.
 */
import {
  conquestCount,
  listCountriesByStatus,
  listCountries,
  territoryCounts,
} from '../db/countries.js';
import {getGuildConfig, startRound} from '../db/guild-config.js';
import type {CountryState} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {clearCooldowns} from '../db/cooldowns.js';
import {listCountryMembers} from '../db/players.js';

/** A won round. */
export interface Victory {
  code: string;
  /** Territories held at the moment of victory, its homeland included. */
  territories: number;
  /** How long the round ran. */
  duration: number;
}

/**
 * Checks whether the round has been won.
 *
 * Standing alone is not enough on its own: the first country founded is the
 * only active one until somebody else joins, and a country whose only rival
 * quietly disbanded never conquered anything. So a winner must also hold at
 * least one country it took by force.
 *
 * @returns the victory, or undefined if the round goes on.
 */
export function checkVictory(
  db: Database,
  guildId: string,
  now: number,
): Victory | undefined {
  const config = getGuildConfig(db, guildId);
  if (!config) return undefined;

  const active = listCountriesByStatus(db, guildId, 'active');
  if (active.length !== 1) return undefined;

  const winner = active[0].code;
  if (conquestCount(db, guildId, winner) === 0) return undefined;

  return {
    code: winner,
    territories: territoryCounts(db, guildId).get(winner) ?? 0,
    duration: now - config.roundStartedAt,
  };
}

/** Everything Discord must tear down when a round ends. */
export interface Teardown {
  channelIds: string[];
  roleIds: string[];
}

/**
 * Wipes the guild's game and starts a fresh round.
 *
 * The guild's setup survives — its category, its game log, and its tuning —
 * so a new round can begin without an admin running `/setup` again. Everything
 * that belongs to the round itself goes: countries, players, cooldowns, and
 * every invasion with its votes and proposals.
 *
 * One transaction, so a reset cannot half-happen and leave players in
 * countries that no longer exist.
 *
 * @returns the channels and roles to delete, gathered before the wipe.
 */
export function resetGame(
  db: Database,
  guildId: string,
  now: number,
): Teardown {
  return db.transaction(() => {
    const countries = listCountries(db, guildId);
    const teardown: Teardown = {
      channelIds: countries
        .map(country => country.channelId)
        .filter((id): id is string => id !== null),
      roleIds: countries
        .map(country => country.roleId)
        .filter((id): id is string => id !== null),
    };

    // Votes and proposals hang off invasions and go with them, as merge votes
    // hang off merges.
    db.prepare('DELETE FROM invasions WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM merges WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM countries WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM players WHERE guild_id = ?').run(guildId);
    clearCooldowns(db, guildId);
    startRound(db, guildId, now);

    return teardown;
  })();
}

/** The roster and holdings of the winning country, for the announcement. */
export interface VictorySummary {
  members: string[];
  territories: CountryState[];
}

/** Reads what the winner ended the round with. */
export function summariseVictory(
  db: Database,
  guildId: string,
  code: string,
): VictorySummary {
  return {
    members: listCountryMembers(db, guildId, code),
    territories: listCountries(db, guildId).filter(
      country => country.ownerCode === code,
    ),
  };
}
