/**
 * Ending a round: the announcement, the teardown, and the fresh start.
 */
import type {ContainerBuilder, Guild} from 'discord.js';
import {formatDuration} from '../config/constants.js';
import {countryLabel, findCountry} from '../data/countries.js';
import type {Database} from '../db/index.js';
import {announce} from '../discord/log.js';
import {ACCENT, container} from '../discord/ui.js';
import type {Victory} from './victory.js';
import {resetGame, summariseVictory} from './victory.js';

/** A country's name for copy, falling back to its code. */
function label(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

/**
 * Renders a territory list that stays inside a message.
 *
 * A late-game empire can hold dozens of countries, so the first few are named
 * and the rest are shown as flags. Nothing is dropped: an empire's roll of
 * conquests is the whole point of winning.
 */
export function territoryRoll(codes: readonly string[]): string {
  if (codes.length === 0) return 'None — it won without taking a single one.';
  const named = codes.slice(0, 8).map(label);
  const rest = codes.slice(8).map(code => findCountry(code)?.flag ?? code);
  return rest.length > 0
    ? `${named.join(', ')} ${rest.join('')}`
    : named.join(', ');
}

/** The victory announcement. */
export function victoryCard(input: {
  victory: Victory;
  members: string[];
  territoryCodes: string[];
}): ContainerBuilder {
  const {victory} = input;
  const roster =
    input.members.length > 0
      ? input.members.map(id => `<@${id}>`).join(', ')
      : 'nobody at all';

  return container(
    ACCENT.success,
    `# 👑 ${label(victory.code)} has won`,
    victory.reason === 'domination'
      ? `It holds **${victory.territories}** territories — enough to call the world its own.`
      : 'It outlasted everyone — the last country standing, long enough that there was nobody left to challenge it.',
    [
      `**Victors:** ${roster}`,
      `**Conquests (${input.territoryCodes.length}):** ${territoryRoll(input.territoryCodes)}`,
      `**The round ran:** ${formatDuration(victory.duration)}`,
    ].join('\n'),
    'The world is being wiped clean. Every country channel and role goes with it — run `/join` to start again.',
  );
}

/**
 * Ends the round: announces the winner, wipes the guild's game, and deletes
 * every country channel and role.
 *
 * The database is wiped first and in one transaction, so a Discord failure
 * mid-teardown leaves stale channels rather than a game that still believes
 * in a round somebody already won. Deletions are serialised, because a full
 * world is fifty channels and as many roles, and Discord will not be rushed.
 *
 * @returns how much of the teardown Discord accepted.
 */
export async function endRound(
  db: Database,
  guild: Guild,
  victory: Victory | null,
  now: number,
): Promise<{channelsDeleted: number; rolesDeleted: number}> {
  if (victory) {
    const summary = summariseVictory(db, guild.id, victory.code);
    await announce(
      db,
      guild,
      victoryCard({
        victory,
        members: summary.members,
        territoryCodes: summary.territories.map(country => country.code),
      }),
    );
  }

  const teardown = resetGame(db, guild.id, now);

  let channelsDeleted = 0;
  for (const channelId of teardown.channelIds) {
    const deleted = await guild.channels
      .delete(channelId, 'Conquest: the round is over')
      .then(() => true)
      .catch(() => false);
    if (deleted) channelsDeleted++;
  }

  let rolesDeleted = 0;
  for (const roleId of teardown.roleIds) {
    const deleted = await guild.roles
      .delete(roleId, 'Conquest: the round is over')
      .then(() => true)
      .catch(() => false);
    if (deleted) rolesDeleted++;
  }

  if (!victory) {
    await announce(
      db,
      guild,
      container(
        ACCENT.warning,
        '## The game has been reset',
        'An admin wiped the world. Every country, stockpile, and war is gone.',
        'Run `/join country:<name>` to claim a country and start again.',
      ),
    );
  }

  return {channelsDeleted, rolesDeleted};
}

/** Announces a fresh round in the guild's log, once the dust settles. */
export async function announceNewRound(
  db: Database,
  guild: Guild,
): Promise<void> {
  await announce(
    db,
    guild,
    container(
      ACCENT.neutral,
      '## A new round begins',
      'Every country is unclaimed again. `/join` one to raise its flag.',
    ),
  );
}

/** Convenience for the sweeper: post-teardown message, then the new round. */
export async function concludeRound(
  db: Database,
  guild: Guild,
  victory: Victory,
  now: number,
): Promise<void> {
  await endRound(db, guild, victory, now);
  await announceNewRound(db, guild);
}
