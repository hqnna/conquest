import {describe, expect, it} from 'vitest';
import {InteractionContextType} from 'discord.js';
import {COMMANDS, COMMANDS_BY_NAME} from '../src/commands/index.js';

describe('command registry', () => {
  const payloads = COMMANDS.map(command => command.data.toJSON());

  it('registers the commands this phase provides', () => {
    expect(payloads.map(payload => payload.name).sort()).toEqual([
      'country',
      'join',
      'leave',
      'map',
      'setup',
    ]);
  });

  it('indexes every command by its registered name', () => {
    expect(COMMANDS_BY_NAME.size).toBe(COMMANDS.length);
    for (const payload of payloads) {
      expect(COMMANDS_BY_NAME.get(payload.name)).toBeDefined();
    }
  });

  it('keeps every command inside a guild, since games are per-guild', () => {
    for (const payload of payloads) {
      expect(payload.contexts).toEqual([InteractionContextType.Guild]);
    }
  });

  it('describes every command and option for the command picker', () => {
    for (const payload of payloads) {
      // Every Conquest command is a chat-input command, which must carry a
      // description; the payload union also covers context-menu commands.
      expect(payload).toHaveProperty('description');
      const chatInput = payload as {
        description: string;
        options?: Array<{description: string}>;
      };
      expect(chatInput.description.length).toBeGreaterThan(0);
      for (const option of chatInput.options ?? []) {
        expect(option.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('offers autocomplete wherever a country is named', () => {
    for (const name of ['join', 'country']) {
      const payload = payloads.find(entry => entry.name === name)!;
      const option = payload.options?.[0] as
        {autocomplete?: boolean} | undefined;
      expect(option?.autocomplete).toBe(true);
      expect(COMMANDS_BY_NAME.get(name)?.autocomplete).toBeInstanceOf(Function);
    }
  });

  it('requires a country to join and defaults /country to your own', () => {
    const optionsOf = (name: string) =>
      (
        payloads.find(payload => payload.name === name) as {
          options?: Array<Record<string, unknown>>;
        }
      ).options;
    expect(optionsOf('join')?.[0]).toMatchObject({
      name: 'country',
      required: true,
    });
    expect(optionsOf('country')?.[0]).toMatchObject({
      name: 'name',
      required: false,
    });
  });
});
