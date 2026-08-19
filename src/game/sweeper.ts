/**
 * The sweeper: the only thing that makes deadlines happen.
 *
 * Every deadline in Conquest is an absolute timestamp in the database, and
 * nothing schedules an in-memory timer against it. This runs on an interval,
 * finds whatever has expired, and settles it — so a restart in the middle of
 * a war loses nothing but the seconds it was down.
 */
import type {Client, Guild} from 'discord.js';
import {GAME} from '../config/constants.js';
import type {Database} from '../db/index.js';
import type {MapRenderer} from '../map/index.js';
import {
  getInvasion,
  listExpiredAttackVotes,
  listExpiredProposals,
  listExpiredReinforcements,
  listUnansweredInvasions,
  listWarsDueATick,
} from '../db/invasions.js';
import {getGuildIds} from '../db/guild-config.js';
import {
  endWar,
  expireDefenseProposal,
  failAttack,
  fightRoundAndReport,
} from './invasion-flow.js';
import {concludeRound} from './round-flow.js';
import {checkVictory} from './victory.js';

/** What one sweep settled. */
export interface SweepResult {
  /** Attack votes that ran out of time. */
  votesExpired: number;
  /** Defence and reinforcement votes that ran out of time. */
  proposalsExpired: number;
  /** Invasions nobody answered, which became voluntary merges. */
  warsUnanswered: number;
  /** Rounds of fighting resolved. */
  roundsFought: number;
  /** Wars ended by a side failing to reinforce in time. */
  warsEnded: number;
  /** Rounds won and wiped clean. */
  roundsWon: number;
}

/** Resolves a guild, or undefined if Conquest is no longer in it. */
async function guildOf(
  client: Client,
  guildId: string,
): Promise<Guild | undefined> {
  return (await client.guilds.fetch(guildId).catch(() => null)) ?? undefined;
}

/**
 * Settles everything whose deadline has passed.
 *
 * Each item is handled on its own and failures are logged rather than thrown,
 * so one guild Conquest has been kicked from cannot stall every other game.
 *
 * @returns counts of what was settled, for logging and tests.
 */
export async function sweep(
  db: Database,
  client: Client,
  now: number = Date.now(),
  map?: MapRenderer,
): Promise<SweepResult> {
  let votesExpired = 0;
  let proposalsExpired = 0;
  let warsUnanswered = 0;
  let roundsFought = 0;
  let warsEnded = 0;
  let roundsWon = 0;

  for (const invasion of listExpiredAttackVotes(db, now)) {
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await failAttack(
        db,
        guild,
        invasion,
        now,
        'The vote ran out of time without a majority. Nothing was spent.',
      );
      votesExpired++;
    } catch (error) {
      console.error(`Could not expire attack vote ${invasion.id}:`, error);
    }
  }

  for (const proposal of listExpiredProposals(db, now)) {
    const invasion = getInvasion(db, proposal.invasionId);
    if (!invasion) continue;
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await expireDefenseProposal(db, guild, invasion, proposal, now);
      proposalsExpired++;
    } catch (error) {
      console.error(`Could not expire defence proposal ${proposal.id}:`, error);
    }
  }

  // A defender that never answered is absorbed without a fight.
  for (const invasion of listUnansweredInvasions(db, now)) {
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await endWar(db, guild, invasion, 'attacker', 'unanswered', now, map);
      warsUnanswered++;
    } catch (error) {
      console.error(`Could not settle invasion ${invasion.id}:`, error);
    }
  }

  for (const invasion of listWarsDueATick(db, now)) {
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await fightRoundAndReport(db, guild, invasion, now);
      roundsFought++;
    } catch (error) {
      console.error(`Could not fight a round of war ${invasion.id}:`, error);
    }
  }

  // Silence is surrender: a country that never approved reinforcements has
  // given up, and the other side has won.
  for (const invasion of listExpiredReinforcements(db, now)) {
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await endWar(
        db,
        guild,
        invasion,
        invasion.reinforcingSide === 'attacker' ? 'defender' : 'attacker',
        'surrender',
        now,
        map,
      );
      warsEnded++;
    } catch (error) {
      console.error(`Could not end war ${invasion.id}:`, error);
    }
  }

  // Victory is checked last, so a conquest resolved by this same sweep is
  // counted before the round is judged.
  for (const guildId of getGuildIds(db)) {
    const victory = checkVictory(db, guildId, now);
    if (!victory) continue;
    const guild = await guildOf(client, guildId);
    if (!guild) continue;
    try {
      await concludeRound(db, guild, victory, now, map);
      roundsWon++;
    } catch (error) {
      console.error(`Could not end the round in ${guildId}:`, error);
    }
  }

  return {
    votesExpired,
    proposalsExpired,
    warsUnanswered,
    roundsFought,
    warsEnded,
    roundsWon,
  };
}

/**
 * Starts the sweeper.
 *
 * Sweeps never overlap: a slow one delays the next rather than racing it.
 *
 * @returns a function that stops it.
 */
export function startSweeper(
  db: Database,
  client: Client,
  map?: MapRenderer,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweep(db, client, Date.now(), map)
      .catch((error: unknown) => {
        console.error('Sweep failed:', error);
      })
      .finally(() => {
        running = false;
      });
  }, GAME.sweeperInterval);

  // The sweeper must never hold the process open on its own.
  timer.unref?.();
  return () => clearInterval(timer);
}
