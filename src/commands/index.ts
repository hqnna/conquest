import {countryCommand} from './country.js';
import {joinCommand} from './join.js';
import {leaveCommand} from './leave.js';
import {mapCommand} from './map.js';
import {setupCommand} from './setup.js';
import type {Command} from './types.js';

export type {Command, CommandContext} from './types.js';

/** Every slash command Conquest registers. */
export const COMMANDS: readonly Command[] = [
  setupCommand,
  joinCommand,
  leaveCommand,
  countryCommand,
  mapCommand,
];

/** Commands indexed by name, for interaction routing. */
export const COMMANDS_BY_NAME = new Map<string, Command>(
  COMMANDS.map(command => [command.data.toJSON().name, command]),
);
