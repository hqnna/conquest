/**
 * Every message a merge sends: the two vote cards, and the union itself.
 *
 * Like invasion votes, merge buttons carry everything they need in their
 * `customId` and are revalidated against the database when clicked, so they
 * keep working across a restart with no collector to survive.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
} from 'discord.js';
import {countryLabel, findCountry} from '../data/countries.js';
import type {Merge, MergeTally, MergeVoteKind} from '../db/merges.js';
import type {Stockpile} from '../db/resources.js';
import type {MergeReport} from '../game/merges.js';
import {tallyLine} from '../game/voting.js';
import {ACCENT, container, relativeTime} from './ui.js';

/** How a merge vote button encodes what it does. */
export interface MergeVoteAction {
  mergeId: number;
  kind: MergeVoteKind;
  choice: 'approve' | 'reject';
}

/** Builds the `customId` for a merge vote button. */
export function mergeVoteCustomId(action: MergeVoteAction): string {
  return `merge:${action.mergeId}:${action.kind}:${action.choice}`;
}

/** Whether a component id belongs to a merge vote. */
export function isMergeComponent(customId: string): boolean {
  return customId.startsWith('merge:');
}

/**
 * Reads a merge vote button's `customId`.
 *
 * @returns the action, or undefined if the id is not one of Conquest's — the
 *   button may predate a rename, and nothing should be trusted from it.
 */
export function parseMergeVoteCustomId(
  customId: string,
): MergeVoteAction | undefined {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'merge') return undefined;
  const [, rawId, kind, choice] = parts;
  const mergeId = Number(rawId);
  if (!Number.isInteger(mergeId) || mergeId <= 0) return undefined;
  if (kind !== 'offer' && kind !== 'accept') return undefined;
  if (choice !== 'approve' && choice !== 'reject') return undefined;
  return {mergeId, kind, choice};
}

/** Approve and Reject, disabled once the vote is over. */
export function mergeVoteButtons(
  mergeId: number,
  kind: MergeVoteKind,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(mergeVoteCustomId({mergeId, kind, choice: 'approve'}))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(mergeVoteCustomId({mergeId, kind, choice: 'reject'}))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/** How a country reads, falling back to its code if it is somehow unknown. */
function label(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

/** What a country brings with it, for the country deciding whether to take it. */
export function dowryLine(input: {
  members: number;
  territories: number;
  stockpile: Stockpile;
}): string {
  return [
    `**They bring:** ${input.members} player${input.members === 1 ? '' : 's'} · ` +
      `${input.territories} territor${input.territories === 1 ? 'y' : 'ies'}`,
    `**Their stockpile:** ⚔️ ${input.stockpile.troops} troops · 🪙 ${input.stockpile.gold} gold · 🌾 ${input.stockpile.food} food`,
  ].join('\n');
}

/** The offer vote, put to the country giving itself up. */
export function offerVoteCard(input: {
  merge: Merge;
  tally: MergeTally;
  memberCount: number;
}): ContainerBuilder {
  const {merge} = input;
  const card = container(
    ACCENT.warning,
    `## 🤝 Become part of ${label(merge.intoCode)}?`,
    [
      `<@${merge.proposerId}> proposes giving ${label(merge.fromCode)} to ${label(merge.intoCode)}.`,
      'Approving ends this country: everyone here joins them, the whole stockpile goes with us, and every territory we hold becomes theirs.',
      'They must agree too — if they vote it down, nothing changes.',
    ].join('\n'),
    `Voting closes ${relativeTime(merge.offerDeadline)}.\n${tallyLine(input.tally, input.memberCount)}`,
  );
  card.addActionRowComponents(mergeVoteButtons(merge.id, 'offer'));
  return card;
}

/** The accept vote, put to the country asked to take the other one in. */
export function acceptVoteCard(input: {
  merge: Merge;
  tally: MergeTally;
  memberCount: number;
  offeredMembers: number;
  offeredTerritories: number;
  offeredStockpile: Stockpile;
  roleId: string | null;
}): ContainerBuilder {
  const {merge} = input;
  const card = container(
    ACCENT.success,
    `## 🤝 Take ${label(merge.fromCode)} in?`,
    [
      input.roleId ? `<@&${input.roleId}>` : '',
      `${label(merge.fromCode)} has voted to give itself to us.`,
      dowryLine({
        members: input.offeredMembers,
        territories: input.offeredTerritories,
        stockpile: input.offeredStockpile,
      }),
      'Approving makes them us: their players vote with ours from then on, so a large country joining a small one changes who decides things here.',
    ]
      .filter(Boolean)
      .join('\n'),
    `Voting closes ${relativeTime(merge.acceptDeadline ?? merge.offerDeadline)}.\n${tallyLine(input.tally, input.memberCount)}`,
  );
  card.addActionRowComponents(mergeVoteButtons(merge.id, 'accept'));
  return card;
}

/** A merge vote that is over, with its buttons dead and its outcome stated. */
export function closedMergeCard(input: {
  mergeId: number;
  kind: MergeVoteKind;
  heading: string;
  detail: string;
  approved: boolean;
}): ContainerBuilder {
  const card = container(
    input.approved ? ACCENT.success : ACCENT.neutral,
    `## ${input.heading}`,
    input.detail,
  );
  card.addActionRowComponents(
    mergeVoteButtons(input.mergeId, input.kind, true),
  );
  return card;
}

/** Told to the offering country once its own vote has passed. */
export function offerCarriedCard(merge: Merge): ContainerBuilder {
  return container(
    ACCENT.neutral,
    `## The offer is with ${label(merge.intoCode)}`,
    `They are voting on whether to take us in. Nothing moves unless they agree, and their answer is due ${relativeTime(merge.acceptDeadline ?? merge.offerDeadline)}.`,
  );
}

/** The union, announced to the whole server. */
export function mergeAnnouncementCard(report: MergeReport): ContainerBuilder {
  const {merge} = report;
  return container(
    ACCENT.success,
    `## 🤝 ${label(merge.fromCode)} has joined ${label(merge.intoCode)}`,
    `Both countries voted for it. ${label(merge.fromCode)} is no longer its own country — its people, its stockpile, and its land are ${label(merge.intoCode)}’s now.`,
    [
      `**Territories gained:** ${report.capturedTerritories.length}`,
      `**Players moved:** ${report.transferredPlayers.length}`,
      `**Stockpile handed over:** ⚔️ ${report.stockpile.troops} troops · 🪙 ${report.stockpile.gold} gold · 🌾 ${report.stockpile.food} food`,
    ].join('\n'),
    'A country given away counts the same as one taken by force. The round still ends only when somebody holds every country in the world.',
  );
}
