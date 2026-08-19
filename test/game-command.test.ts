import {describe, expect, it} from 'vitest';
import {InteractionContextType, PermissionFlagsBits} from 'discord.js';
import type {ContainerBuilder} from 'discord.js';
import {
  MAX_THRESHOLD,
  RESET_CONFIRM_ID,
  configCard,
  gameCommand,
  resetConfirmationCard,
} from '../src/commands/game.js';
import {isResetConfirmation} from '../src/discord/game-buttons.js';

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

function buttonsOf(container: ContainerBuilder) {
  const json = container.toJSON() as {
    components: Array<{
      components?: Array<{custom_id?: string; style?: number; label?: string}>;
    }>;
  };
  return json.components.flatMap(component => component.components ?? []);
}

describe('/game registration', () => {
  const json = gameCommand.data.toJSON() as {
    name: string;
    contexts?: number[];
    default_member_permissions?: string | null;
    options?: Array<{
      name: string;
      options?: Array<{
        name: string;
        required?: boolean;
        min_value?: number;
        max_value?: number;
      }>;
    }>;
  };

  it('is admin-only and guild-only', () => {
    expect(json.name).toBe('game');
    expect(json.default_member_permissions).toBe(
      String(PermissionFlagsBits.ManageGuild),
    );
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('offers reset and config', () => {
    expect(json.options?.map(option => option.name).sort()).toEqual([
      'config',
      'reset',
    ]);
  });

  it('bounds the threshold to something a round can actually reach', () => {
    const threshold = json.options
      ?.find(option => option.name === 'config')
      ?.options?.find(option => option.name === 'threshold');
    expect(threshold).toMatchObject({
      required: true,
      min_value: 1,
      max_value: MAX_THRESHOLD,
    });
  });
});

describe('resetConfirmationCard', () => {
  const card = resetConfirmationCard({activeCountries: 3, channels: 5});

  it('spells out exactly what will be destroyed', () => {
    const text = textOf(card);
    expect(text).toContain('**5** country channels');
    expect(text).toContain('3 active countries');
    expect(text).toContain('none of it can be recovered');
  });

  it('says what survives, so an admin knows setup is not lost', () => {
    expect(textOf(card)).toContain('category, the game log');
  });

  it('needs a second, deliberate press', () => {
    const [button] = buttonsOf(card);
    expect(button.custom_id).toBe(RESET_CONFIRM_ID);
    expect(button.style).toBe(4);
  });

  it('reads correctly for a single country', () => {
    const text = textOf(
      resetConfirmationCard({activeCountries: 1, channels: 1}),
    );
    expect(text).toContain('**1** country channel and');
    expect(text).toContain('1 active country');
  });
});

describe('isResetConfirmation', () => {
  it('recognises only its own button', () => {
    expect(isResetConfirmation(RESET_CONFIRM_ID)).toBe(true);
    expect(isResetConfirmation('vote:7:attack:approve')).toBe(false);
    expect(isResetConfirmation('game:reset')).toBe(false);
    expect(isResetConfirmation('')).toBe(false);
  });
});

describe('configCard', () => {
  it('states the new threshold and who is closest to it', () => {
    const text = textOf(
      configCard({threshold: 6, leader: {code: 'FR', territories: 4}}),
    );
    expect(text).toContain('**6** territories');
    expect(text).toContain('🇫🇷 France');
    expect(text).toContain('**4**');
  });

  it('copes with a world where nobody holds anything', () => {
    expect(textOf(configCard({threshold: 6}))).toContain('Nobody holds');
  });

  it('mentions the other way to win', () => {
    expect(textOf(configCard({threshold: 6}))).toContain('standing alone');
  });
});
