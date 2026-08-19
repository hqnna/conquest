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
import {
  getInvasion,
  listExpiredAttackVotes,
  listExpiredProposals,
  listInvasionsToResolve,
} from '../db/invasions.js';
import {
  expireDefenseProposal,
  failAttack,
  resolveAndAnnounce,
} from './invasion-flow.js';

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
): Promise<{
  votesExpired: number;
  proposalsExpired: number;
  battlesFought: number;
}> {
  let votesExpired = 0;
  let proposalsExpired = 0;
  let battlesFought = 0;

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

  for (const invasion of listInvasionsToResolve(db, now)) {
    const guild = await guildOf(client, invasion.guildId);
    if (!guild) continue;
    try {
      await resolveAndAnnounce(db, guild, invasion, now);
      battlesFought++;
    } catch (error) {
      console.error(`Could not resolve invasion ${invasion.id}:`, error);
    }
  }

  return {votesExpired, proposalsExpired, battlesFought};
}

/**
 * Starts the sweeper.
 *
 * Sweeps never overlap: a slow one delays the next rather than racing it.
 *
 * @returns a function that stops it.
 */
export function startSweeper(db: Database, client: Client): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweep(db, client)
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
