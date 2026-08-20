/**
 * Handling merge vote button clicks.
 *
 * As with invasion votes, nothing is remembered between a button being drawn
 * and being pressed: the `customId` carries the merge, the side, and the
 * choice, and everything else is read from the database and revalidated.
 */
import {MessageFlags} from 'discord.js';
import type {ButtonInteraction, Guild} from 'discord.js';
import type {Database} from '../db/index.js';
import {castMergeVote, getMerge} from '../db/merges.js';
import {getPlayer} from '../db/players.js';
import {
  acceptCard,
  offerCard,
  readAcceptVote,
  readOfferVote,
} from '../game/merge-flow.js';
import type {MapRenderer} from '../map/index.js';
import {parseMergeVoteCustomId} from './merge-ui.js';
import {ACCENT, container, ephemeral, v2Message} from './ui.js';

/** Why a click did not count. */
function refuse(heading: string, detail: string) {
  return ephemeral(container(ACCENT.danger, `### ${heading}`, detail));
}

/**
 * Casts a merge vote from a button press, then re-reads the vote.
 *
 * Which country may vote follows from the side: the country offering itself
 * decides the offer, and the country being asked decides the answer. That is
 * checked here rather than trusted from the channel the button sits in.
 */
export async function handleMergeButton(
  db: Database,
  guild: Guild,
  interaction: ButtonInteraction,
  map?: MapRenderer,
): Promise<void> {
  const action = parseMergeVoteCustomId(interaction.customId);
  if (!action) return;

  const merge = getMerge(db, action.mergeId);
  if (!merge || merge.guildId !== guild.id) {
    await interaction.reply(
      refuse(
        'That vote is gone.',
        'The merge it belonged to no longer exists.',
      ),
    );
    return;
  }

  const expectedStatus = action.kind === 'offer' ? 'offer_vote' : 'accept_vote';
  if (merge.status !== expectedStatus) {
    await interaction.reply(
      refuse(
        'That vote is already over.',
        'Its outcome is settled — the buttons above are only history now.',
      ),
    );
    return;
  }

  const code = action.kind === 'offer' ? merge.fromCode : merge.intoCode;
  const player = getPlayer(db, guild.id, interaction.user.id);
  if (player?.countryCode !== code) {
    await interaction.reply(
      refuse(
        'This is not your country’s decision.',
        'Only players of the country holding the vote may cast one.',
      ),
    );
    return;
  }

  const now = Date.now();
  const deadline =
    action.kind === 'offer'
      ? merge.offerDeadline
      : (merge.acceptDeadline ?? merge.offerDeadline);
  if (deadline <= now) {
    await interaction.reply(
      refuse(
        'That vote has closed.',
        'The window ran out before your click landed.',
      ),
    );
    return;
  }

  castMergeVote(db, {
    mergeId: merge.id,
    kind: action.kind,
    userId: interaction.user.id,
    choice: action.choice,
    now,
  });

  // Show the new tally on the message that was clicked, before the vote is
  // read: if it now settles, reading it replaces this message anyway.
  await interaction
    .update(
      v2Message(
        action.kind === 'offer'
          ? offerCard(db, guild.id, merge)
          : acceptCard(db, guild.id, merge),
      ),
    )
    .catch(() => undefined);

  const outcome =
    action.kind === 'offer'
      ? await readOfferVote(db, guild, merge, now, map)
      : await readAcceptVote(db, guild, merge, now, map);

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
