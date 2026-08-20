import {describe, expect, it} from 'vitest';
import {InteractionContextType, PermissionFlagsBits} from 'discord.js';
import type {ContainerBuilder} from 'discord.js';
import {
  RESET_CONFIRM_ID,
  formatSetting,
  gameCommand,
  resetConfirmationCard,
  settingsCard,
  tunedCard,
} from '../src/commands/game.js';
import {
  TUNABLES,
  TUNABLES_BY_KEY,
  defaultSettings,
} from '../src/config/settings.js';
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

  it('offers reset, settings, tune, and reset-settings', () => {
    expect(json.options?.map(option => option.name).sort()).toEqual([
      'reset',
      'reset-settings',
      'settings',
      'tune',
    ]);
  });

  it('offers every tunable as a choice, and no others', () => {
    const setting = json.options
      ?.find(option => option.name === 'tune')
      ?.options?.find(option => option.name === 'setting') as
      {choices?: Array<{value: string}>; required?: boolean} | undefined;
    expect(setting?.required).toBe(true);
    expect(setting?.choices?.map(choice => choice.value).sort()).toEqual(
      TUNABLES.map(tunable => tunable.key).sort(),
    );
  });

  it('makes the value optional, so leaving it out restores the default', () => {
    const value = json.options
      ?.find(option => option.name === 'tune')
      ?.options?.find(option => option.name === 'value');
    expect(value?.required).toBeFalsy();
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

describe('formatSetting', () => {
  it('reads durations as durations, not as raw minutes', () => {
    const window = TUNABLES_BY_KEY.get('defense_window')!;
    expect(formatSetting(window, 90)).toBe('1.5 hours');
    expect(formatSetting(window, 30)).toBe('30 minutes');
  });

  it('says "none" for a timer somebody turned off', () => {
    expect(formatSetting(TUNABLES_BY_KEY.get('rejoin_cooldown')!, 0)).toBe(
      'none',
    );
  });

  it('marks percentages and counts for what they are', () => {
    expect(formatSetting(TUNABLES_BY_KEY.get('home_advantage')!, 20)).toBe(
      '20%',
    );
    expect(
      formatSetting(TUNABLES_BY_KEY.get('domination_threshold')!, 10),
    ).toBe('10');
  });
});

describe('tunedCard', () => {
  it('shows what a setting was and what it became', () => {
    const text = textOf(
      tunedCard({
        tunable: TUNABLES_BY_KEY.get('war_tick')!,
        value: 15,
        previous: 60,
      }),
    );
    expect(text).toContain('1 hour');
    expect(text).toContain('15 minutes');
  });

  it('says that a war already running is not retuned underneath it', () => {
    const text = textOf(
      tunedCard({
        tunable: TUNABLES_BY_KEY.get('war_tick')!,
        value: 15,
        previous: 60,
      }),
    );
    expect(text).toContain('already running');
  });
});

describe('settingsCard', () => {
  const summaries = TUNABLES.map(tunable => ({
    tunable,
    value: tunable.read(defaultSettings()),
    isDefault: true,
  }));

  it('lists every setting the server has', () => {
    const text = textOf(settingsCard(summaries));
    for (const tunable of TUNABLES) expect(text).toContain(tunable.label);
  });

  it('says plainly when nothing has been changed', () => {
    expect(textOf(settingsCard(summaries))).toContain('as Conquest ships it');
  });

  it('marks what has been changed, and counts it', () => {
    const changed = summaries.map((summary, index) =>
      index === 0 ? {...summary, isDefault: false} : summary,
    );
    const text = textOf(settingsCard(changed));
    expect(text).toContain('✏️');
    expect(text).toContain('1 setting this server has changed');
  });
});
