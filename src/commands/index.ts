import {countryCommand} from './country.js';
import {defendCommand} from './defend.js';
import {farmCommand, mineCommand, recruitCommand} from './gather.js';
import {invadeCommand} from './invade.js';
import {joinCommand} from './join.js';
import {leaveCommand} from './leave.js';
import {mapCommand} from './map.js';
import {reinforceCommand, surrenderCommand} from './reinforce.js';
import {resourcesCommand} from './resources.js';
import {setupCommand} from './setup.js';
import type {Command} from './types.js';

export type {Command, CommandContext} from './types.js';

/** Every slash command Conquest registers. */
export const COMMANDS: readonly Command[] = [
  setupCommand,
  joinCommand,
  leaveCommand,
  countryCommand,
  farmCommand,
  mineCommand,
  recruitCommand,
  resourcesCommand,
  invadeCommand,
  defendCommand,
  reinforceCommand,
  surrenderCommand,
  mapCommand,
];

/** Commands indexed by name, for interaction routing. */
export const COMMANDS_BY_NAME = new Map<string, Command>(
  COMMANDS.map(command => [command.data.toJSON().name, command]),
);
