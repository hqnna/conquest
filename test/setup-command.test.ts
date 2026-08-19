import {describe, expect, it} from 'vitest';
import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import type {CategoryChannel, Guild} from 'discord.js';
import {DISCORD_LIMITS} from '../src/config/constants.js';
import {
  missingBotPermissions,
  remainingCategorySlots,
  resolveExistingLogChannel,
  setupCommand,
} from '../src/commands/setup.js';

const ALL_REQUIRED =
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages;

/** A guild whose channel cache holds exactly the given channels. */
function fakeGuild(channels: Array<{id: string; type: ChannelType}>): Guild {
  const cache = new Map(channels.map(channel => [channel.id, channel]));
  return {channels: {cache}} as unknown as Guild;
}

function fakeCategory(childCount: number): CategoryChannel {
  return {
    children: {cache: {size: childCount}},
  } as unknown as CategoryChannel;
}

describe('missingBotPermissions', () => {
  it('reports nothing when every permission is granted', () => {
    expect(
      missingBotPermissions(new PermissionsBitField(ALL_REQUIRED)),
    ).toEqual([]);
  });

  it('names each missing permission', () => {
    const permissions = new PermissionsBitField(
      ALL_REQUIRED & ~PermissionFlagsBits.ManageRoles,
    );
    expect(missingBotPermissions(permissions)).toEqual(['Manage Roles']);
  });

  it('names every permission when none are known', () => {
    expect(missingBotPermissions(null)).toEqual([
      'Manage Channels',
      'Manage Roles',
      'View Channels',
      'Send Messages',
    ]);
  });

  it('treats Administrator as sufficient', () => {
    const admin = new PermissionsBitField(PermissionFlagsBits.Administrator);
    expect(missingBotPermissions(admin)).toEqual([]);
  });
});

describe('resolveExistingLogChannel', () => {
  it('reuses a text channel that still exists', () => {
    const guild = fakeGuild([{id: 'log-1', type: ChannelType.GuildText}]);
    expect(resolveExistingLogChannel(guild, 'log-1')).toBeDefined();
  });

  it('ignores a channel that was deleted', () => {
    const guild = fakeGuild([]);
    expect(resolveExistingLogChannel(guild, 'log-1')).toBeUndefined();
  });

  it('ignores a channel that is no longer a text channel', () => {
    const guild = fakeGuild([{id: 'log-1', type: ChannelType.GuildVoice}]);
    expect(resolveExistingLogChannel(guild, 'log-1')).toBeUndefined();
  });

  it('returns nothing when the guild has never been set up', () => {
    expect(resolveExistingLogChannel(fakeGuild([]), undefined)).toBeUndefined();
  });
});

describe('remainingCategorySlots', () => {
  it('counts every existing channel against the cap', () => {
    expect(remainingCategorySlots(fakeCategory(0))).toBe(
      DISCORD_LIMITS.channelsPerCategory,
    );
    expect(remainingCategorySlots(fakeCategory(7))).toBe(
      DISCORD_LIMITS.channelsPerCategory - 7,
    );
  });

  it('never reports negative capacity', () => {
    expect(
      remainingCategorySlots(
        fakeCategory(DISCORD_LIMITS.channelsPerCategory + 5),
      ),
    ).toBe(0);
  });
});

describe('/setup registration', () => {
  const json = setupCommand.data.toJSON();

  it('is named setup and gated on Manage Guild', () => {
    expect(json.name).toBe('setup');
    expect(json.default_member_permissions).toBe(
      String(PermissionFlagsBits.ManageGuild),
    );
  });

  it('is usable only inside a guild', () => {
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('takes a required category channel option', () => {
    const [option] = json.options ?? [];
    expect(option).toMatchObject({
      name: 'category',
      required: true,
      channel_types: [ChannelType.GuildCategory],
    });
  });
});
