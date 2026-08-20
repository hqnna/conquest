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
  getInvasion,
  getPendingProposal,
  setAttackMessage,
  setProposalMessage,
} from '../db/invasions.js';
import type {Invasion, Side, StakeProposal} from '../db/invasions.js';
import {countCountryMembers} from '../db/players.js';
import {tallyVotes} from '../db/votes.js';
import {announce} from '../discord/log.js';
import {postWorldMap} from '../discord/map-message.js';
import type {MapRenderer} from '../map/index.js';
import {
  attackVoteCard,
  closedVoteCard,
  declarationCard,
  defenseVoteCard,
  escrowFailedCard,
  reinforceOrSurrenderCard,
  reinforcementVoteCard,
  roundReportCard,
  stakeLine,
  underAttackCard,
  warReportCard,
} from '../discord/invasion-ui.js';
import {ACCENT, container, v2Message} from '../discord/ui.js';
import {applyAbsorption} from './absorption.js';
import {abandonMerge} from './merge-flow.js';
import {
  concludeWar,
  escrowAndOpenDefense,
  escrowDefense,
  escrowReinforcement,
  fightWarRound,
} from './invasions.js';
import type {ConclusionReport} from './invasions.js';
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

  for (const merge of escrow.cancelledMerges) {
    await abandonMerge(
      db,
      guild,
      merge,
      'A war broke out before it could be made. A country cannot be handed over mid-battle.',
    );
  }

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
  proposal: StakeProposal,
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

/**
 * Counts a defence or reinforcement vote and acts on the answer.
 *
 * Which vote it is follows from the invasion's state: a country under
 * invasion is answering the invasion, and a country whose force is spent is
 * answering for that.
 */
export async function readDefenseVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<'approved' | 'rejected' | 'pending'> {
  const proposal = getPendingProposal(db, invasion.id);
  if (!proposal) return 'pending';

  const code =
    proposal.side === 'attacker'
      ? invasion.attackerCode
      : invasion.defenderCode;
  const memberCount = countCountryMembers(db, guild.id, code);
  const tally = tallyVotes(
    db,
    invasion.id,
    proposal.side === 'attacker' ? 'attack' : 'defense',
  );
  const outcome = readTally(tally, memberCount);
  const channel = await channelOf(db, guild, code);
  const kind = proposal.side === 'attacker' ? 'attack' : 'defense';

  if (outcome === 'pending') return outcome;

  if (outcome === 'rejected') {
    finishProposal(db, proposal.id, 'rejected', now);
    await closeVoteMessage(
      guild,
      channel,
      proposal.messageId,
      closedVoteCard({
        invasionId: invasion.id,
        kind,
        heading:
          proposal.kind === 'defense'
            ? 'The defence was voted down'
            : 'The reinforcements were voted down',
        detail:
          proposal.kind === 'defense'
            ? 'Nothing was committed. Anyone may propose a different defence while the window lasts.'
            : 'Nothing was committed. Propose something smaller before the deadline, or the war is over.',
        approved: false,
      }),
    );
    return outcome;
  }

  const escrow =
    proposal.kind === 'defense'
      ? escrowDefense(db, invasion, proposal, now)
      : escrowReinforcement(db, invasion, proposal, now);

  await closeVoteMessage(
    guild,
    channel,
    proposal.messageId,
    closedVoteCard({
      invasionId: invasion.id,
      kind,
      heading: escrow.ok
        ? proposal.kind === 'defense'
          ? 'The defence takes the field'
          : 'The reinforcements are on their way'
        : 'It could not be raised',
      detail: escrow.ok
        ? `${stakeLine(proposal.stake)} joins the fighting.`
        : 'The stockpile no longer covered it, so nothing was committed. Propose less.',
      approved: escrow.ok,
    }),
  );

  if (escrow.ok && proposal.kind === 'defense') {
    await announceWarBegins(db, guild, invasion);
  }
  return escrow.ok ? 'approved' : 'rejected';
}

/** Tells both countries the fighting has started. */
async function announceWarBegins(
  db: Database,
  guild: Guild,
  invasion: Invasion,
): Promise<void> {
  const current = getInvasion(db, invasion.id);
  if (!current) return;
  await announce(
    db,
    guild,
    container(
      ACCENT.warning,
      `## The war for ${countryName(invasion.defenderCode)} has begun`,
      `${countryName(invasion.defenderCode)} met the invasion in the field. Neither side walks away now until one of them has nothing left to send.`,
      `**${countryName(invasion.attackerCode)}:** ${stakeLine(current.attackField)}\n**${countryName(invasion.defenderCode)}:** ${stakeLine(current.defenseField)}`,
    ),
  );
}

/** A country's name for copy, falling back to its code. */
function countryName(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

/** Closes a proposal whose vote window ran out. */
export async function expireDefenseProposal(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  proposal: StakeProposal,
  now: number,
): Promise<void> {
  finishProposal(db, proposal.id, 'expired', now);
  const code =
    proposal.side === 'attacker'
      ? invasion.attackerCode
      : invasion.defenderCode;
  await closeVoteMessage(
    guild,
    await channelOf(db, guild, code),
    proposal.messageId,
    closedVoteCard({
      invasionId: invasion.id,
      kind: proposal.side === 'attacker' ? 'attack' : 'defense',
      heading: 'The vote ran out of time',
      detail: 'Nothing was committed.',
      approved: false,
    }),
  );
}

/** Posts a reinforcement proposal and reads it at once. */
export async function openReinforcementVote(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  proposal: StakeProposal,
  now: number,
): Promise<void> {
  const code =
    proposal.side === 'attacker'
      ? invasion.attackerCode
      : invasion.defenderCode;
  const channel = await channelOf(db, guild, code);

  if (channel) {
    const message = await channel
      .send(
        v2Message(
          reinforcementVoteCard({
            invasion,
            proposal,
            tally: tallyVotes(
              db,
              invasion.id,
              proposal.side === 'attacker' ? 'attack' : 'defense',
            ),
            memberCount: countCountryMembers(db, guild.id, code),
          }),
        ),
      )
      .catch(() => null);
    if (message) setProposalMessage(db, proposal.id, message.id);
  }

  await readDefenseVote(db, guild, invasion, now);
}

/**
 * Fights one round of a war and says what it cost.
 *
 * If a side is left with nothing in the field, its country is called on to
 * reinforce or give up — unless it has nothing at home either, in which case
 * the war is already over: a country fought dry cannot fight on.
 */
export async function fightRoundAndReport(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  now: number,
): Promise<void> {
  const report = fightWarRound(db, invasion, now);
  const card = roundReportCard(report);

  for (const code of [invasion.attackerCode, invasion.defenderCode]) {
    const channel = await channelOf(db, guild, code);
    await channel?.send(v2Message(card)).catch(() => undefined);
  }

  if (!report.spentSide) return;

  if (report.exhausted) {
    await endWar(
      db,
      guild,
      report.invasion,
      report.spentSide === 'attacker' ? 'defender' : 'attacker',
      'exhausted',
      now,
    );
    return;
  }

  const code =
    report.spentSide === 'attacker'
      ? invasion.attackerCode
      : invasion.defenderCode;
  const channel = await channelOf(db, guild, code);
  const country = getCountry(db, guild.id, code);
  await channel
    ?.send(
      v2Message(
        reinforceOrSurrenderCard({
          invasion: report.invasion,
          side: report.spentSide,
          deadline: report.invasion.reinforceDeadline ?? now,
          roleId: country?.roleId ?? null,
        }),
      ),
    )
    .catch(() => undefined);
}

/**
 * Ends a war and carries out everything that follows: the archive, the roles,
 * the announcement.
 */
export async function endWar(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  winner: Side,
  reason: ConclusionReport['reason'],
  now: number,
  map?: MapRenderer,
): Promise<void> {
  const pending = getPendingProposal(db, invasion.id);
  if (pending) finishProposal(db, pending.id, 'expired', now);

  const report = concludeWar(db, invasion, winner, reason, now);
  await announce(db, guild, warReportCard(report));

  if (winner === 'defender') {
    const channel = await channelOf(db, guild, invasion.defenderCode);
    await channel
      ?.send(
        v2Message(
          container(
            ACCENT.success,
            '## The invasion is over',
            `${countryName(invasion.attackerCode)} could not finish what it started. Your survivors are home: ${stakeLine(report.defenderReturns)}.`,
          ),
        ),
      )
      .catch(() => undefined);
    return;
  }

  await applyConquest(db, guild, invasion, report);
  await postWorldMap(
    db,
    guild,
    '## The world has changed hands',
    'The world after the conquest',
    map,
  );
}

/** The Discord half of a conquest: roles moved, channels archived. */
async function applyConquest(
  db: Database,
  guild: Guild,
  invasion: Invasion,
  report: ConclusionReport,
): Promise<void> {
  await applyAbsorption(
    db,
    guild,
    {
      absorbedCode: invasion.defenderCode,
      transferredPlayers: report.transferredPlayers,
      capturedTerritories: report.capturedTerritories,
      absorbedRoleId: report.defeatedRoleId,
      absorbedChannelId: report.defeatedChannelId,
      absorberRoleId: report.winnerRoleId,
    },
    `Conquest: ${invasion.defenderCode} conquered`,
  );

  const defeated = findCountry(invasion.defenderCode);
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
