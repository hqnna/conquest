/**
 * Handling vote button clicks.
 *
 * Nothing is remembered between a button being drawn and being pressed: the
 * `customId` carries the invasion, the side, and the choice, and everything
 * else is read from the database and revalidated. Buttons therefore keep
 * working across a restart.
 */
import {MessageFlags} from 'discord.js';
import type {ButtonInteraction, Guild} from 'discord.js';
import {getInvasion, getPendingProposal} from '../db/invasions.js';
import type {Database} from '../db/index.js';
import {getPlayer} from '../db/players.js';
import {castVote, tallyVotes} from '../db/votes.js';
import {countCountryMembers} from '../db/players.js';
import {readAttackVote, readDefenseVote} from '../game/invasion-flow.js';
import {
  attackVoteCard,
  defenseVoteCard,
  parseVoteCustomId,
} from './invasion-ui.js';
import {ACCENT, container, ephemeral, v2Message} from './ui.js';

/** Why a click did not count. */
type Rejection = {heading: string; detail: string};

function refuse(rejection: Rejection) {
  return ephemeral(
    container(ACCENT.danger, `### ${rejection.heading}`, rejection.detail),
  );
}

/**
 * Casts a vote from a button press, then re-reads the vote.
 *
 * The voter must belong to the country the vote belongs to — the attacker's
 * for an attack vote, the defender's for a defence — which is checked here
 * rather than trusted from the channel the button happens to sit in.
 */
export async function handleVoteButton(
  db: Database,
  guild: Guild,
  interaction: ButtonInteraction,
): Promise<void> {
  const action = parseVoteCustomId(interaction.customId);
  if (!action) return;

  const invasion = getInvasion(db, action.invasionId);
  if (!invasion || invasion.guildId !== guild.id) {
    await interaction.reply(
      refuse({
        heading: 'That vote is gone.',
        detail: 'The invasion it belonged to no longer exists.',
      }),
    );
    return;
  }

  const expectedStatus =
    action.kind === 'attack' ? 'attack_vote' : 'defense_window';
  if (invasion.status !== expectedStatus) {
    await interaction.reply(
      refuse({
        heading: 'That vote is already over.',
        detail:
          'Its outcome is settled — the buttons above are only history now.',
      }),
    );
    return;
  }

  const country =
    action.kind === 'attack' ? invasion.attackerCode : invasion.defenderCode;
  const player = getPlayer(db, guild.id, interaction.user.id);
  if (player?.countryCode !== country) {
    await interaction.reply(
      refuse({
        heading: 'This is not your country’s decision.',
        detail: 'Only players of the country holding the vote may cast one.',
      }),
    );
    return;
  }

  const now = Date.now();
  const proposal =
    action.kind === 'defense' ? getPendingProposal(db, invasion.id) : undefined;

  if (action.kind === 'attack' && invasion.attackVoteDeadline <= now) {
    await interaction.reply(
      refuse({
        heading: 'That vote has closed.',
        detail: 'The window ran out before your click landed.',
      }),
    );
    return;
  }
  if (action.kind === 'defense') {
    if (!proposal) {
      await interaction.reply(
        refuse({
          heading: 'There is no defence on the table.',
          detail: 'Propose one with `/defend troops:<n>`.',
        }),
      );
      return;
    }
    if (proposal.voteDeadline <= now) {
      await interaction.reply(
        refuse({
          heading: 'That vote has closed.',
          detail: 'Propose a new defence if the window is still open.',
        }),
      );
      return;
    }
  }

  castVote(db, {
    invasionId: invasion.id,
    kind: action.kind,
    userId: interaction.user.id,
    choice: action.choice,
    now,
  });

  // Show the new tally on the message that was clicked, before the vote is
  // read: if it now passes, reading it replaces this message anyway.
  const memberCount = countCountryMembers(db, guild.id, country);
  const tally = tallyVotes(db, invasion.id, action.kind);
  const card =
    action.kind === 'attack'
      ? attackVoteCard({
          invasion,
          proposerId: interaction.user.id,
          tally,
          memberCount,
        })
      : defenseVoteCard({
          invasion,
          proposal: proposal!,
          tally,
          memberCount,
        });

  await interaction.update(v2Message(card)).catch(() => undefined);

  const outcome =
    action.kind === 'attack'
      ? await readAttackVote(db, guild, invasion, now)
      : await readDefenseVote(db, guild, invasion, now);

  if (outcome === 'pending') {
    await interaction
      .followUp({
        flags: MessageFlags.Ephemeral,
        content:
          action.choice === 'approve'
            ? 'Your approval is counted.'
            : 'Your rejection is counted.',
      })
      .catch(() => undefined);
  }
}
