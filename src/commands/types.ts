import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import type {Database} from '../db/index.js';
import type {MapRenderer} from '../map/index.js';

/** Everything a command handler needs beyond the interaction itself. */
export interface CommandContext {
  db: Database;
  /**
   * Renders the world map, or undefined when no rasterizer would load — in
   * which case `/map` falls back to the text standings it showed before.
   */
  map?: MapRenderer;
}

/** One slash command: its registration payload and its handlers. */
export interface Command {
  /** The command definition sent to Discord during registration. */
  data: {toJSON(): RESTPostAPIApplicationCommandsJSONBody};
  /** Handles an invocation of the command. */
  execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void>;
  /**
   * Answers autocomplete for this command. Must respond from the database or
   * cache within Discord's ~3s window and never call the Discord API.
   */
  autocomplete?(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void>;
}
