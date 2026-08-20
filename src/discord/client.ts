import {Client, GatewayIntentBits, Events} from 'discord.js';
import type {GuildMember, Interaction, PartialGuildMember} from 'discord.js';
import {COMMANDS_BY_NAME} from '../commands/index.js';
import {removePlayerFromCountry} from '../commands/leave.js';
import type {CommandContext} from '../commands/types.js';
import {errorReply} from './ui.js';
import {handleResetButton, isResetConfirmation} from './game-buttons.js';
import {handleHelpButton, handleHelpSelect} from './help-buttons.js';
import {isHelpComponent} from './help-ui.js';
import {handleMergeButton} from './merge-buttons.js';
import {isMergeComponent} from './merge-ui.js';
import {handleVoteButton} from './vote-buttons.js';

/**
 * Creates the Conquest gateway client.
 *
 * Conquest reads no message content: everything happens through slash
 * commands and message components. GuildMembers is needed to notice players
 * leaving the server and to look members up when their roles change — it is
 * privileged, so it must be enabled for the application in Discord's
 * developer portal.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}

/**
 * Treats a player leaving the server as leaving their country, without the
 * rejoin cooldown: there is nothing to discourage and no one to hold to it.
 * If they were the last of their country, the country falls with them.
 */
export function registerMemberHandler(
  client: Client,
  ctx: CommandContext,
): void {
  client.on(
    Events.GuildMemberRemove,
    async (member: GuildMember | PartialGuildMember) => {
      try {
        await removePlayerFromCountry(ctx.db, member.guild, member.id, {
          withCooldown: false,
          now: Date.now(),
        });
      } catch (error) {
        console.error(
          `Could not release ${member.id} from their country in ${member.guild.id}:`,
          error,
        );
      }
    },
  );
}

/**
 * Routes slash-command and autocomplete interactions to their handlers.
 *
 * Component interactions are stateless — their handlers parse the `customId`
 * and revalidate against the database — and are registered by later phases.
 */
export function registerInteractionHandler(
  client: Client,
  ctx: CommandContext,
): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      const command = COMMANDS_BY_NAME.get(interaction.commandName);
      try {
        await command?.autocomplete?.(interaction, ctx);
      } catch (error) {
        console.error(
          `Autocomplete for /${interaction.commandName} failed:`,
          error,
        );
        // Discord shows nothing rather than an error; an empty list is the
        // only graceful fallback.
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    if (interaction.isButton()) {
      if (!interaction.guild) return;
      try {
        if (isHelpComponent(interaction.customId)) {
          await handleHelpButton(ctx.db, interaction);
        } else if (isResetConfirmation(interaction.customId)) {
          await handleResetButton(ctx.db, interaction.guild, interaction);
        } else if (isMergeComponent(interaction.customId)) {
          await handleMergeButton(
            ctx.db,
            interaction.guild,
            interaction,
            ctx.map,
          );
        } else {
          await handleVoteButton(ctx.db, interaction.guild, interaction);
        }
      } catch (error) {
        console.error(`Button ${interaction.customId} failed:`, error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction
            .reply(
              errorReply(
                'Conquest could not record that click.',
                'Nothing was changed. Try again in a moment.',
              ),
            )
            .catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      try {
        await handleHelpSelect(ctx.db, interaction);
      } catch (error) {
        console.error(`Select ${interaction.customId} failed:`, error);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = COMMANDS_BY_NAME.get(interaction.commandName);
    if (!command) {
      await interaction.reply(
        errorReply(
          `Conquest does not know the command /${interaction.commandName}.`,
          'It may have been removed — try `/help` for the current command list.',
        ),
      );
      return;
    }

    try {
      await command.execute(interaction, ctx);
    } catch (error) {
      console.error(`/${interaction.commandName} failed:`, error);
      const failure = errorReply(
        'Conquest hit an unexpected error running that command.',
        'Nothing was changed. Try again in a moment, and tell a server admin if it keeps happening.',
      );
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(failure).catch(() => undefined);
      } else {
        await interaction.reply(failure).catch(() => undefined);
      }
    }
  });
}
