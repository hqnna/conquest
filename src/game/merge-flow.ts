/**
 * Driving a merge through its two votes, with the Discord work each one
 * implies.
 *
 * As with invasions, the database transaction always commits first and the
 * messages, roles, and channels follow: if Discord fails afterwards the game
 * is still consistent, and the reverse would not be true.
 */
import {ChannelType} from 'discord.js';
import type {Guild, TextChannel} from 'discord.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry, listTerritories} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {
  finishMerge,
  getMerge,
  setMergeMessage,
  tallyMergeVotes,
} from '../db/merges.js';
import type {Merge} from '../db/merges.js';
import {countCountryMembers} from '../db/players.js';
import {announce} from '../discord/log.js';
import {postWorldMap} from '../discord/map-message.js';
import type {MapRenderer} from '../map/index.js';
import {
  acceptVoteCard,
  closedMergeCard,
  mergeAnnouncementCard,
  offerCarriedCard,
  offerVoteCard,
} from '../discord/merge-ui.js';
import {ACCENT, container, v2Message} from '../discord/ui.js';
import {applyAbsorption} from './absorption.js';
import {beginAcceptVote, completeMerge} from './merges.js';
import {readTally} from './voting.js';

/** How a vote read, once it was counted. */
export type MergeOutcome = 'approved' | 'rejected' | 'pending';

/** A country's name for copy, falling back to its code. */
function label(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

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
  channel: TextChannel | undefined,
  messageId: string | null,
  card: ReturnType<typeof closedMergeCard>,
): Promise<void> {
  if (!channel || !messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.edit(v2Message(card)).catch(() => undefined);
}

/**
 * Posts the offer vote in the offering country's channel, then reads it
 * immediately — a one-player country passes on the proposer's own approval.
 */
export async function openOfferVote(
  db: Database,
  guild: Guild,
  merge: Merge,
  now: number,
  map?: MapRenderer,
): Promise<void> {
  const channel = await channelOf(db, guild, merge.fromCode);
  if (channel) {
    const message = await channel
      .send(v2Message(offerCard(db, guild.id, merge)))
      .catch(() => null);
    if (message) setMergeMessage(db, merge.id, 'offer', message.id);
  }

  await readOfferVote(db, guild, merge, now, map);
}

/**
 * Counts the offering country's vote and acts on the answer.
 *
 * The threshold is a majority of that country's players as they stand right
 * now, so it moves with every join and departure.
 */
export async function readOfferVote(
  db: Database,
  guild: Guild,
  merge: Merge,
  now: number,
  map?: MapRenderer,
): Promise<MergeOutcome> {
  const current = getMerge(db, merge.id);
  if (!current || current.status !== 'offer_vote') return 'pending';

  const memberCount = countCountryMembers(db, guild.id, current.fromCode);
  const outcome = readTally(
    tallyMergeVotes(db, current.id, 'offer'),
    memberCount,
  );
  if (outcome === 'pending') return outcome;

  const channel = await channelOf(db, guild, current.fromCode);

  if (outcome === 'rejected') {
    finishMerge(db, current.id, 'declined', now);
    await closeVoteMessage(
      channel,
      current.offerMessageId,
      closedMergeCard({
        mergeId: current.id,
        kind: 'offer',
        heading: 'The offer was voted down',
        detail: `${label(current.fromCode)} stays its own country. Nothing was moved.`,
        approved: false,
      }),
    );
    return outcome;
  }

  const acceptDeadline = beginAcceptVote(db, current, now);
  await closeVoteMessage(
    channel,
    current.offerMessageId,
    closedMergeCard({
      mergeId: current.id,
      kind: 'offer',
      heading: 'The offer was approved',
      detail: `${label(current.intoCode)} has been asked to take us in.`,
      approved: true,
    }),
  );
  await channel
    ?.send(v2Message(offerCarriedCard({...current, acceptDeadline})))
    .catch(() => undefined);

  await openAcceptVote(
    db,
    guild,
    {...current, status: 'accept_vote', acceptDeadline},
    now,
    map,
  );
  return outcome;
}

/** Puts the offer to the country asked to absorb, and reads it at once. */
export async function openAcceptVote(
  db: Database,
  guild: Guild,
  merge: Merge,
  now: number,
  map?: MapRenderer,
): Promise<void> {
  const channel = await channelOf(db, guild, merge.intoCode);
  if (channel) {
    const message = await channel
      .send(v2Message(acceptCard(db, guild.id, merge)))
      .catch(() => null);
    if (message) setMergeMessage(db, merge.id, 'accept', message.id);
  }

  await readAcceptVote(db, guild, merge, now, map);
}

/**
 * The offer vote card, with the tally as it stands.
 *
 * Both cards are built here rather than at each call site, so a vote message
 * redrawn by a button click says exactly what the one posted by the sweeper
 * says.
 */
export function offerCard(
  db: Database,
  guildId: string,
  merge: Merge,
): ReturnType<typeof offerVoteCard> {
  return offerVoteCard({
    merge,
    tally: tallyMergeVotes(db, merge.id, 'offer'),
    memberCount: countCountryMembers(db, guildId, merge.fromCode),
  });
}

/** The accept vote card, filled in with what the offering country brings. */
export function acceptCard(
  db: Database,
  guildId: string,
  merge: Merge,
): ReturnType<typeof acceptVoteCard> {
  const offered = getCountry(db, guildId, merge.fromCode);
  return acceptVoteCard({
    merge,
    tally: tallyMergeVotes(db, merge.id, 'accept'),
    memberCount: countCountryMembers(db, guildId, merge.intoCode),
    offeredMembers: countCountryMembers(db, guildId, merge.fromCode),
    // Its homeland counts as territory, exactly as it does everywhere else.
    offeredTerritories: 1 + listTerritories(db, guildId, merge.fromCode).length,
    offeredStockpile: {
      troops: offered?.troops ?? 0,
      gold: offered?.gold ?? 0,
      food: offered?.food ?? 0,
    },
    roleId: getCountry(db, guildId, merge.intoCode)?.roleId ?? null,
  });
}

/** Counts the absorbing country's vote and acts on the answer. */
export async function readAcceptVote(
  db: Database,
  guild: Guild,
  merge: Merge,
  now: number,
  map?: MapRenderer,
): Promise<MergeOutcome> {
  const current = getMerge(db, merge.id);
  if (!current || current.status !== 'accept_vote') return 'pending';

  const memberCount = countCountryMembers(db, guild.id, current.intoCode);
  const outcome = readTally(
    tallyMergeVotes(db, current.id, 'accept'),
    memberCount,
  );
  if (outcome === 'pending') return outcome;

  const channel = await channelOf(db, guild, current.intoCode);

  if (outcome === 'rejected') {
    finishMerge(db, current.id, 'declined', now);
    await closeVoteMessage(
      channel,
      current.acceptMessageId,
      closedMergeCard({
        mergeId: current.id,
        kind: 'accept',
        heading: 'The offer was turned down',
        detail: `${label(current.fromCode)} remains its own country.`,
        approved: false,
      }),
    );
    await tell(
      db,
      guild,
      current.fromCode,
      container(
        ACCENT.warning,
        `## ${label(current.intoCode)} turned us down`,
        'They voted against taking us in. Nothing has changed — we are still our own country.',
      ),
    );
    return outcome;
  }

  const merged = completeMerge(db, current, now);
  if (!merged.ok) {
    await closeVoteMessage(
      channel,
      current.acceptMessageId,
      closedMergeCard({
        mergeId: current.id,
        kind: 'accept',
        heading: 'The merge could not be made',
        detail:
          merged.failure.kind === 'at_war'
            ? `${label(merged.failure.code)} is at war. A country cannot be handed over mid-battle.`
            : `${label(merged.failure.code)} is no longer standing. There was nothing left to merge.`,
        approved: false,
      }),
    );
    return 'rejected';
  }

  await closeVoteMessage(
    channel,
    current.acceptMessageId,
    closedMergeCard({
      mergeId: current.id,
      kind: 'accept',
      heading: `${label(current.fromCode)} is part of us now`,
      detail: `${merged.report.transferredPlayers.length} player${merged.report.transferredPlayers.length === 1 ? '' : 's'} and everything they held came with them.`,
      approved: true,
    }),
  );

  await announce(db, guild, mergeAnnouncementCard(merged.report));

  await applyAbsorption(
    db,
    guild,
    {
      absorbedCode: current.fromCode,
      transferredPlayers: merged.report.transferredPlayers,
      capturedTerritories: merged.report.capturedTerritories,
      absorbedRoleId: merged.report.absorbedRoleId,
      absorbedChannelId: merged.report.absorbedChannelId,
      absorberRoleId: merged.report.absorberRoleId,
    },
    `Conquest: ${current.fromCode} merged into ${current.intoCode}`,
  );

  await tell(
    db,
    guild,
    current.intoCode,
    container(
      ACCENT.success,
      `## ${label(current.fromCode)} is ours`,
      merged.report.transferredPlayers.length > 0
        ? `${merged.report.transferredPlayers.map(id => `<@${id}>`).join(', ')} — you are one of us now. Welcome.`
        : 'They handed over a country with nobody left in it.',
      `The transfer is complete: ${merged.report.capturedTerritories.length} territor${merged.report.capturedTerritories.length === 1 ? 'y' : 'ies'} and everything they had stockpiled.`,
    ),
  );

  await postWorldMap(
    db,
    guild,
    '## The world has changed hands',
    'The world after the merge',
    map,
  );
  return outcome;
}

/** Closes a merge whose vote ran out of time. */
export async function expireMerge(
  db: Database,
  guild: Guild,
  merge: Merge,
  now: number,
): Promise<void> {
  const kind = merge.status === 'offer_vote' ? 'offer' : 'accept';
  const code = kind === 'offer' ? merge.fromCode : merge.intoCode;
  finishMerge(db, merge.id, 'expired', now);
  await closeVoteMessage(
    await channelOf(db, guild, code),
    kind === 'offer' ? merge.offerMessageId : merge.acceptMessageId,
    closedMergeCard({
      mergeId: merge.id,
      kind,
      heading: 'The vote ran out of time',
      detail:
        kind === 'offer'
          ? 'The offer was never made. Nothing has changed.'
          : `${label(merge.fromCode)} never got an answer, so the offer lapsed. Nothing has changed.`,
      approved: false,
    }),
  );
  if (kind === 'accept') {
    await tell(
      db,
      guild,
      merge.fromCode,
      container(
        ACCENT.warning,
        `## ${label(merge.intoCode)} never answered`,
        'Our offer lapsed. We are still our own country.',
      ),
    );
  }
}

/**
 * Calls off a merge that the world moved out from under — a country at war,
 * disbanded, or conquered while the votes were still open.
 */
export async function abandonMerge(
  db: Database,
  guild: Guild,
  merge: Merge,
  detail: string,
): Promise<void> {
  const stages: Array<{
    kind: 'offer' | 'accept';
    code: string;
    messageId: string | null;
  }> = [
    {kind: 'offer', code: merge.fromCode, messageId: merge.offerMessageId},
    {kind: 'accept', code: merge.intoCode, messageId: merge.acceptMessageId},
  ];
  for (const stage of stages) {
    await closeVoteMessage(
      await channelOf(db, guild, stage.code),
      stage.messageId,
      closedMergeCard({
        mergeId: merge.id,
        kind: stage.kind,
        heading: 'The merge was called off',
        detail,
        approved: false,
      }),
    );
  }
}

/** Posts to a country's channel, if it still has one. */
async function tell(
  db: Database,
  guild: Guild,
  code: string,
  card: ReturnType<typeof container>,
): Promise<void> {
  const channel = await channelOf(db, guild, code);
  await channel?.send(v2Message(card)).catch(() => undefined);
}
