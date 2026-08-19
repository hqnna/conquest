/**
 * The reset confirmation button.
 *
 * Like every component in Conquest it carries no state: the click is checked
 * against the guild and the clicker's permissions before anything is wiped,
 * so a stale button from a previous round cannot destroy the current one
 * behind an admin's back.
 */
import {PermissionFlagsBits} from 'discord.js';
import type {ButtonInteraction, Guild} from 'discord.js';
import {RESET_CONFIRM_ID} from '../commands/game.js';
import {getGuildConfig} from '../db/guild-config.js';
import type {Database} from '../db/index.js';
import {endRound} from '../game/round-flow.js';
import {ACCENT, container, ephemeral, v2EditReply} from './ui.js';

/** Whether a customId is the reset confirmation. */
export function isResetConfirmation(customId: string): boolean {
  return customId === RESET_CONFIRM_ID;
}

/** Wipes the guild's game, if the person clicking is allowed to. */
export async function handleResetButton(
  db: Database,
  guild: Guild,
  interaction: ButtonInteraction,
): Promise<void> {
  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(
      ephemeral(
        container(
          ACCENT.danger,
          '### That is not yours to press.',
          'Resetting the game needs the Manage Server permission.',
        ),
      ),
    );
    return;
  }

  if (!getGuildConfig(db, guild.id)) {
    await interaction.reply(
      ephemeral(
        container(
          ACCENT.danger,
          '### There is no game to reset.',
          'Run `/setup category:<category>` first.',
        ),
      ),
    );
    return;
  }

  await interaction.deferUpdate();

  const result = await endRound(db, guild, null, Date.now());

  await interaction
    .editReply(
      v2EditReply(
        container(
          ACCENT.warning,
          '## The game has been reset',
          `Deleted ${result.channelsDeleted} channel${result.channelsDeleted === 1 ? '' : 's'} and ${result.rolesDeleted} role${result.rolesDeleted === 1 ? '' : 's'}.`,
          'The category, the game log, and the domination threshold are untouched. Players can `/join` again.',
        ),
      ),
    )
    .catch(() => undefined);
}
