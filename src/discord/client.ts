import {Client, GatewayIntentBits, Events} from 'discord.js';
import type {Interaction} from 'discord.js';
import {COMMANDS_BY_NAME} from '../commands/index.js';
import type {CommandContext} from '../commands/types.js';
import {errorReply} from './ui.js';

/**
 * Creates the Conquest gateway client.
 *
 * Conquest reads no message content: everything happens through slash
 * commands and message components, so only the Guilds intent is needed.
 */
export function createClient(): Client {
  return new Client({intents: [GatewayIntentBits.Guilds]});
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
