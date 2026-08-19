/**
 * Every message the invasion pipeline sends: vote cards, declarations, and
 * battle reports.
 *
 * Vote buttons carry everything they need in their `customId` and are
 * revalidated against the database when clicked, so they keep working across
 * a restart with no collector to survive.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
} from 'discord.js';
import {countryLabel, findCountry} from '../data/countries.js';
import type {DefenseProposal, Invasion, Stake} from '../db/invasions.js';
import type {Stockpile} from '../db/resources.js';
import type {Tally} from '../db/votes.js';
import type {VoteKind} from '../db/votes.js';
import type {ResolutionReport} from '../game/invasions.js';
import {tallyLine} from '../game/voting.js';
import {ACCENT, container, relativeTime} from './ui.js';

/** How a vote button encodes what it does. */
export interface VoteAction {
  invasionId: number;
  kind: VoteKind;
  choice: 'approve' | 'reject';
}

/** Builds the `customId` for a vote button. */
export function voteCustomId(action: VoteAction): string {
  return `vote:${action.invasionId}:${action.kind}:${action.choice}`;
}

/**
 * Reads a vote button's `customId`.
 *
 * @returns the action, or undefined if the id is not one of Conquest's — the
 *   button may predate a rename, and nothing should be trusted from it.
 */
export function parseVoteCustomId(customId: string): VoteAction | undefined {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'vote') return undefined;
  const [, rawId, kind, choice] = parts;
  const invasionId = Number(rawId);
  if (!Number.isInteger(invasionId) || invasionId <= 0) return undefined;
  if (kind !== 'attack' && kind !== 'defense') return undefined;
  if (choice !== 'approve' && choice !== 'reject') return undefined;
  return {invasionId, kind, choice};
}

/** Approve and Reject, disabled once the vote is over. */
export function voteButtons(
  invasionId: number,
  kind: VoteKind,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(voteCustomId({invasionId, kind, choice: 'approve'}))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(voteCustomId({invasionId, kind, choice: 'reject'}))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/** Renders a stake, supplies included only when there are any. */
export function stakeLine(stake: Stake): string {
  const parts = [`⚔️ **${stake.troops}** troops`];
  if (stake.gold > 0) parts.push(`🪙 **${stake.gold}** gold`);
  if (stake.food > 0) parts.push(`🌾 **${stake.food}** food`);
  return parts.join(' · ');
}

/** How a country reads, falling back to its code if it is somehow unknown. */
function label(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

/** The attack vote put to the attacking country. */
export function attackVoteCard(input: {
  invasion: Invasion;
  proposerId: string;
  tally: Tally;
  memberCount: number;
}): ContainerBuilder {
  const {invasion} = input;
  const card = container(
    ACCENT.attacker,
    `## ⚔️ Invade ${label(invasion.defenderCode)}?`,
    [
      `<@${input.proposerId}> proposes marching on ${label(invasion.defenderCode)}.`,
      `**Stake:** ${stakeLine(invasion.attack)}`,
      'Approving commits it: the stake leaves the stockpile at once, and a lost invasion hands all of it to the defender.',
    ].join('\n'),
    `Voting closes ${relativeTime(invasion.attackVoteDeadline)}.\n${tallyLine(input.tally, input.memberCount)}`,
  );
  card.addActionRowComponents(voteButtons(invasion.id, 'attack'));
  return card;
}

/** The defence vote put to the defending country. */
export function defenseVoteCard(input: {
  invasion: Invasion;
  proposal: DefenseProposal;
  tally: Tally;
  memberCount: number;
}): ContainerBuilder {
  const {invasion, proposal} = input;
  const card = container(
    ACCENT.defender,
    `## 🛡️ Defend against ${label(invasion.attackerCode)}?`,
    [
      `<@${proposal.proposerId}> proposes meeting the invasion in the field.`,
      `**Defence:** ${stakeLine(proposal.stake)}`,
      `**They committed:** ${stakeLine(invasion.attack)}`,
      'Defending is easier than attacking — the home ground is worth a fifth of your strength again.',
    ].join('\n'),
    `Voting closes ${relativeTime(proposal.voteDeadline)}.\n${tallyLine(input.tally, input.memberCount)}`,
  );
  card.addActionRowComponents(voteButtons(invasion.id, 'defense'));
  return card;
}

/** A vote that is over, with its buttons dead and its outcome stated. */
export function closedVoteCard(input: {
  invasionId: number;
  kind: VoteKind;
  heading: string;
  detail: string;
  approved: boolean;
}): ContainerBuilder {
  const card = container(
    input.approved ? ACCENT.success : ACCENT.danger,
    `## ${input.heading}`,
    input.detail,
  );
  card.addActionRowComponents(voteButtons(input.invasionId, input.kind, true));
  return card;
}

/** The public declaration, stake and all — big stakes should be visible. */
export function declarationCard(
  invasion: Invasion,
  defenseDeadline: number,
): ContainerBuilder {
  return container(
    ACCENT.attacker,
    `## ⚔️ ${label(invasion.attackerCode)} declares war on ${label(invasion.defenderCode)}`,
    [
      `**Committed:** ${stakeLine(invasion.attack)}`,
      `The battle resolves ${relativeTime(defenseDeadline)}.`,
    ].join('\n'),
    'Defenders: run `/defend` to put a defence to your country. Whatever is approved is escrowed, and the battle is fought when the window closes — approving early buys nothing.',
  );
}

/** The warning posted in the defending country's channel. */
export function underAttackCard(input: {
  invasion: Invasion;
  defenseDeadline: number;
  defenderRoleId: string | null;
}): ContainerBuilder {
  return container(
    ACCENT.defender,
    `## 🛡️ ${label(input.invasion.attackerCode)} is marching on you`,
    [
      input.defenderRoleId ? `<@&${input.defenderRoleId}>` : '',
      `**They committed:** ${stakeLine(input.invasion.attack)}`,
      `The battle is fought ${relativeTime(input.defenseDeadline)}, whatever you do before then.`,
    ]
      .filter(Boolean)
      .join('\n'),
    'Run `/defend troops:<n> [gold] [food]` to propose a defence. Doing nothing means the country falls without a fight.',
  );
}

/** How a battle read, for the game log. */
export function battleReportCard(report: ResolutionReport): ContainerBuilder {
  const {invasion, outcome, defense} = report;
  const attacker = label(invasion.attackerCode);
  const defender = label(invasion.defenderCode);

  const powers =
    `**${attacker}:** ${outcome.attackPower.toFixed(1)} power from ${stakeLine(invasion.attack)}\n` +
    `**${defender}:** ${outcome.defensePower.toFixed(1)} power from ${
      defense.troops > 0 ? stakeLine(defense) : 'no defence at all'
    }`;

  if (!outcome.attackerWins) {
    const haul = stakeLine(outcome.captured);
    return container(
      ACCENT.defender,
      `## 🛡️ ${defender} holds against ${attacker}`,
      powers,
      [
        `${defender} captured the entire invading force: ${haul}.`,
        `It lost **${outcome.defenderCasualties}** troops doing it; the rest went home.`,
      ].join('\n'),
      `${attacker} cannot declare another invasion for a while, and ${defender} cannot be invaded again for a while either.`,
    );
  }

  const spoils: string[] = [
    `**${outcome.attackerCasualties}** attacking troops fell; the survivors marched home.`,
  ];
  if (report.loot) {
    spoils.push(
      `**Looted:** ${stakeLine({troops: report.loot.troops, gold: report.loot.gold, food: report.loot.food})}`,
    );
  }
  if (report.transferredPlayers.length > 0) {
    spoils.push(
      `**${report.transferredPlayers.length}** player${report.transferredPlayers.length === 1 ? '' : 's'} now serve ${attacker}.`,
    );
  }
  if (report.capturedTerritories.length > 1) {
    spoils.push(
      `**${report.capturedTerritories.length}** territories changed hands, including everything ${defender} had taken.`,
    );
  }

  return container(
    ACCENT.attacker,
    `## 🏳️ ${attacker} has conquered ${defender}`,
    powers,
    spoils.join('\n'),
  );
}

/** What a country was told when a stake it had promised evaporated. */
export function escrowFailedCard(
  invasion: Invasion,
  stockpile: Stockpile,
): ContainerBuilder {
  return container(
    ACCENT.danger,
    '## The invasion was called off',
    `${label(invasion.attackerCode)} approved a stake of ${stakeLine(invasion.attack)}, but the stockpile no longer covers it.`,
    `It holds ⚔️ ${stockpile.troops} troops · 🪙 ${stockpile.gold} gold · 🌾 ${stockpile.food} food. Nothing was spent — gather, then declare again.`,
  );
}
