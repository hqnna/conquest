/**
 * Winning the round, and starting the next one.
 *
 * A round ends when one country dominates: it holds enough territory, or it
 * is simply the last one standing and has been for long enough. Both are
 * checked from stored state on every sweep, so neither depends on a timer
 * surviving a restart.
 */
import {
  listCountriesByStatus,
  listCountries,
  territoryCounts,
} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import {getGuildConfig, setSoleActive, startRound} from '../db/guild-config.js';
import {settingsFor} from '../db/guild-settings.js';
import type {Database} from '../db/index.js';
import {clearCooldowns} from '../db/cooldowns.js';
import {listCountryMembers} from '../db/players.js';

/** How a country won the round. */
export type VictoryReason = 'domination' | 'last_standing';

/** A won round. */
export interface Victory {
  code: string;
  reason: VictoryReason;
  /** Territories held at the moment of victory. */
  territories: number;
  /** How long the round ran. */
  duration: number;
}

/**
 * Decides whether a country has won on territory alone.
 *
 * Only an active country can win: a defeated one holds nothing, since its
 * territories change hands along with it.
 */
export function findDominator(
  active: readonly CountryState[],
  territories: ReadonlyMap<string, number>,
  threshold: number,
): {code: string; territories: number} | undefined {
  const standings = active
    .map(country => ({
      code: country.code,
      territories: territories.get(country.code) ?? 0,
    }))
    .filter(entry => entry.territories >= threshold)
    .sort(
      (a, b) => b.territories - a.territories || a.code.localeCompare(b.code),
    );
  return standings[0];
}

/**
 * Checks both ways to win, and keeps the last-country-standing clock.
 *
 * The clock is reset rather than paused whenever the world stops being a
 * one-country world, so a country cannot bank time towards a walkover between
 * rivals coming and going.
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
  const territories = territoryCounts(db, guildId);

  const settings = settingsFor(db, guildId);
  const dominator = findDominator(
    active,
    territories,
    settings.game.dominationThreshold,
  );
  if (dominator) {
    return {
      code: dominator.code,
      reason: 'domination',
      territories: dominator.territories,
      duration: now - config.roundStartedAt,
    };
  }

  if (active.length !== 1) {
    if (config.soleActiveCode !== null) setSoleActive(db, guildId, null, null);
    return undefined;
  }

  const alone = active[0].code;
  if (config.soleActiveCode !== alone || config.soleActiveSince === null) {
    setSoleActive(db, guildId, alone, now);
    return undefined;
  }
  if (
    now - config.soleActiveSince <
    settings.game.lastCountryStandingDuration
  ) {
    return undefined;
  }

  return {
    code: alone,
    reason: 'last_standing',
    territories: territories.get(alone) ?? 0,
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

    // Votes and proposals hang off invasions and go with them.
    db.prepare('DELETE FROM invasions WHERE guild_id = ?').run(guildId);
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
