/**
 * Driving an invasion through its stages, with the Discord work each one
 * implies.
 *
 * The database transaction always commits first; the messages, roles, and
 * channels follow. If Discord fails afterwards the game is still consistent —
 * the reverse would not be true.
 */
import {ChannelType} from 'discord.js';
import type {Guild, TextChannel} from 'discord.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {
  finishInvasion,
  finishProposal,
  getPendingProposal,
  setAttackMessage,
  setProposalMessage,
} from '../db/invasions.js';
import type {DefenseProposal, Invasion} from '../db/invasions.js';
import {countCountryMembers} from '../db/players.js';
import {tallyVotes} from '../db/votes.js';
import {announce} from '../discord/log.js';
import {
  attackVoteCard,
  battleReportCard,
  closedVoteCard,
  declarationCard,
  defenseVoteCard,
  escrowFailedCard,
  stakeLine,
  underAttackCard,
} from '../discord/invasion-ui.js';
import {ACCENT, container, v2Message} from '../discord/ui.js';
import {
  archiveCountryChannel,
  grantCountryRole,
  reassignArchive,
  revokeCountryRole,
} from './country-lifecycle.js';
import {
  escrowAndOpenDefense,
  escrowDefense,
  recordArchive,
  resolveInvasion,
} from './invasions.js';
import {readTally} from './voting.js';

/** Fetches a country's channel, if it still exists and can be posted in. */
async function channelOf(
  db: Database,
  guild: Guild,
  code: string,
): Promise<TextChannel | undefined> {
  const state = getCountry(db, guild.id, code);
  if (!state?.channelId) return undefined;
  const channel = await guild.channels.fetch(state.channelId).catch(() => null);
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

/** Replaces a vote message with its closed form, buttons dead. */
async function closeVoteMessage(
  guild: Guild,
  channel: TextChannel | undefined,
  messageId: string | null,
  card: ReturnType<typeof closedVoteCard>,
): Promise<void> {
  if (!channel || !messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.edit(v2Message(card)).catch(() => undefined);
}

/**
 * Posts the attack vote in the attacking country's channel, then reads it
 * immediately — a one-player country passes on the initiator's own approval.
 */
export async function openAttackVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  proposerId: string,
  now: number,
): Promise<void> {
  const channel = await channelOf(db, guild, invasion.attackerCode);
  const memberCount = countCountryMembers(db, guild.id, invasion.attackerCode);
  const tally = tallyVotes(db, invasion.id, 'attack');

  if (channel) {
    const message = await channel
      .send(
        v2Message(attackVoteCard({invasion, proposerId, tally, memberCount})),
      )
      .catch(() => null);
    if (message) setAttackMessage(db, invasion.id, message.id);
  }

  await readAttackVote(db, guild, invasion, now);
}

/**
 * Counts an attack vote and acts on the answer.
 *
 * The threshold is a majority of the country's players as they stand right
 * now, so it moves with every join and departure.
 */
export async function readAttackVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<'approved' | 'rejected' | 'pending'> {
  const memberCount = countCountryMembers(db, guild.id, invasion.attackerCode);
  const tally = tallyVotes(db, invasion.id, 'attack');
  const outcome = readTally(tally, memberCount);

  if (outcome === 'approved') await approveAttack(db, guild, invasion, now);
  if (outcome === 'rejected') {
    await failAttack(
      db,
      guild,
      invasion,
      now,
      'The country voted it down. Nothing was spent.',
    );
  }
  return outcome;
}

/** Escrows the stake, declares the war publicly, and warns the defender. */
export async function approveAttack(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<void> {
  const escrow = escrowAndOpenDefense(db, invasion, now);
  const attackerChannel = await channelOf(db, guild, invasion.attackerCode);

  if (!escrow.ok) {
    await closeVoteMessage(
      guild,
      attackerChannel,
      invasion.attackMessageId,
      closedVoteCard({
        invasionId: invasion.id,
        kind: 'attack',
        heading: 'Invasion called off',
        detail:
          'The stockpile no longer covered the stake, so nothing was spent.',
        approved: false,
      }),
    );
    await attackerChannel
      ?.send(v2Message(escrowFailedCard(invasion, escrow.failure.stockpile)))
      .catch(() => undefined);
    return;
  }

  await closeVoteMessage(
    guild,
    attackerChannel,
    invasion.attackMessageId,
    closedVoteCard({
      invasionId: invasion.id,
      kind: 'attack',
      heading: 'The invasion was approved',
      detail: `${stakeLine(invasion.attack)} has left the stockpile and is committed to the field.`,
      approved: true,
    }),
  );

  await announce(db, guild, declarationCard(invasion, escrow.defenseDeadline));

  const defenderChannel = await channelOf(db, guild, invasion.defenderCode);
  const defender = getCountry(db, guild.id, invasion.defenderCode);
  await defenderChannel
    ?.send(
      v2Message(
        underAttackCard({
          invasion,
          defenseDeadline: escrow.defenseDeadline,
          defenderRoleId: defender?.roleId ?? null,
        }),
      ),
    )
    .catch(() => undefined);
}

/** Closes a failed attack vote without spending anything. */
export async function failAttack(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
  detail: string,
): Promise<void> {
  finishInvasion(db, invasion.id, 'cancelled', now);
  await closeVoteMessage(
    guild,
    await channelOf(db, guild, invasion.attackerCode),
    invasion.attackMessageId,
    closedVoteCard({
      invasionId: invasion.id,
      kind: 'attack',
      heading: 'The invasion was called off',
      detail,
      approved: false,
    }),
  );
}

/** Posts a defence proposal to the defending country and reads it at once. */
export async function openDefenseVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  proposal: DefenseProposal,
  now: number,
): Promise<void> {
  const channel = await channelOf(db, guild, invasion.defenderCode);
  const memberCount = countCountryMembers(db, guild.id, invasion.defenderCode);

  if (channel) {
    const message = await channel
      .send(
        v2Message(
          defenseVoteCard({
            invasion,
            proposal,
            tally: tallyVotes(db, invasion.id, 'defense'),
            memberCount,
          }),
        ),
      )
      .catch(() => null);
    if (message) setProposalMessage(db, proposal.id, message.id);
  }

  await readDefenseVote(db, guild, invasion, now);
}

/** Counts a defence vote and acts on the answer. */
export async function readDefenseVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<'approved' | 'rejected' | 'pending'> {
  const proposal = getPendingProposal(db, invasion.id);
  if (!proposal) return 'pending';

  const memberCount = countCountryMembers(db, guild.id, invasion.defenderCode);
  const tally = tallyVotes(db, invasion.id, 'defense');
  const outcome = readTally(tally, memberCount);
  const channel = await channelOf(db, guild, invasion.defenderCode);

  if (outcome === 'approved') {
    const escrow = escrowDefense(db, invasion, proposal, now);
    await closeVoteMessage(
      guild,
      channel,
      proposal.messageId,
      closedVoteCard({
        invasionId: invasion.id,
        kind: 'defense',
        heading: escrow.ok
          ? 'The defence was approved'
          : 'The defence could not be raised',
        detail: escrow.ok
          ? `${stakeLine(proposal.stake)} stands ready. The battle is fought when the window closes.`
          : 'The stockpile no longer covered it, so nothing was committed. Propose a smaller defence.',
        approved: escrow.ok,
      }),
    );
    return escrow.ok ? 'approved' : 'rejected';
  }

  if (outcome === 'rejected') {
    finishProposal(db, proposal.id, 'rejected', now);
    await closeVoteMessage(
      guild,
      channel,
      proposal.messageId,
      closedVoteCard({
        invasionId: invasion.id,
        kind: 'defense',
        heading: 'The defence was voted down',
        detail:
          'Nothing was committed. Anyone may propose a different defence while the window lasts.',
        approved: false,
      }),
    );
  }
  return outcome;
}

/** Closes a defence proposal whose vote window ran out. */
export async function expireDefenseProposal(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  proposal: DefenseProposal,
  now: number,
): Promise<void> {
  finishProposal(db, proposal.id, 'expired', now);
  await closeVoteMessage(
    guild,
    await channelOf(db, guild, invasion.defenderCode),
    proposal.messageId,
    closedVoteCard({
      invasionId: invasion.id,
      kind: 'defense',
      heading: 'The defence vote ran out of time',
      detail: 'Nothing was committed.',
      approved: false,
    }),
  );
}

/**
 * Fights the battle and carries out everything that follows: the archive, the
 * roles, the announcement.
 *
 * Role changes are applied one at a time. A large conquest moves every player
 * of a country, and Discord will not be rushed.
 */
export async function resolveAndAnnounce(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<void> {
  const pending = getPendingProposal(db, invasion.id);
  if (pending) finishProposal(db, pending.id, 'expired', now);

  const report = resolveInvasion(db, invasion, now);
  await announce(db, guild, battleReportCard(report));

  if (!report.outcome.attackerWins) {
    const channel = await channelOf(db, guild, invasion.defenderCode);
    await channel
      ?.send(
        v2Message(
          container(
            ACCENT.success,
            '## The invasion was thrown back',
            `Everything ${findCountry(invasion.attackerCode) ? countryLabel(findCountry(invasion.attackerCode)!) : invasion.attackerCode} committed is yours: ${stakeLine(report.outcome.captured)}.`,
          ),
        ),
      )
      .catch(() => undefined);
    return;
  }

  await applyConquest(db, guild, invasion, report);
}

/** The Discord half of a conquest: roles moved, channels archived. */
async function applyConquest(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  report: ReturnType<typeof resolveInvasion>,
): Promise<void> {
  const winnerRoleId = report.winnerRoleId;
  const defeated = findCountry(invasion.defenderCode);

  if (winnerRoleId) {
    for (const userId of report.transferredPlayers) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      await grantCountryRole(
        member,
        winnerRoleId,
        `Conquest: ${invasion.defenderCode} absorbed`,
      ).catch(() => undefined);
      if (report.defeatedRoleId) {
        await revokeCountryRole(
          member,
          report.defeatedRoleId,
          `Conquest: ${invasion.defenderCode} absorbed`,
        ).catch(() => undefined);
      }
    }
  }

  if (report.defeatedChannelId && winnerRoleId && defeated) {
    const channel = await guild.channels
      .fetch(report.defeatedChannelId)
      .catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await archiveCountryChannel(guild, channel, defeated, winnerRoleId).catch(
        () => undefined,
      );
      recordArchive(db, guild.id, invasion.defenderCode, channel.id);
    }
  }

  // Everything the fallen country had taken changes hands with it.
  for (const territory of report.capturedTerritories) {
    if (territory.code === invasion.defenderCode) continue;
    if (!territory.channelId || !winnerRoleId) continue;
    const channel = await guild.channels
      .fetch(territory.channelId)
      .catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await reassignArchive(guild, channel, winnerRoleId).catch(
        () => undefined,
      );
    }
  }

  // Its role goes last: until now it was what let its people read the archive.
  if (report.defeatedRoleId) {
    await guild.roles
      .delete(report.defeatedRoleId, `Conquest: ${invasion.defenderCode} fell`)
      .catch(() => undefined);
  }

  const winnerChannel = await channelOf(db, guild, invasion.attackerCode);
  await winnerChannel
    ?.send(
      v2Message(
        container(
          ACCENT.success,
          `## ${defeated ? countryLabel(defeated) : invasion.defenderCode} is ours`,
          report.transferredPlayers.length > 0
            ? `${report.transferredPlayers.map(id => `<@${id}>`).join(', ')} — you fight for us now. Welcome.`
            : 'The country fell without a soul left in it.',
          `The transfer is complete: ${report.capturedTerritories.length} territor${report.capturedTerritories.length === 1 ? 'y' : 'ies'} and everything they had stockpiled.`,
        ),
      ),
    )
    .catch(() => undefined);
}
