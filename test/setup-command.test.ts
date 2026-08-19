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
  logChannelOverwrites,
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

describe('logChannelOverwrites', () => {
  const [everyone, conquest] = logChannelOverwrites('everyone-role', 'bot-id');

  it('lets everyone read and react but not post', () => {
    expect(everyone.id).toBe('everyone-role');
    expect(everyone.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(everyone.allow).toContain(PermissionFlagsBits.ReadMessageHistory);
    expect(everyone.allow).toContain(PermissionFlagsBits.AddReactions);
    expect(everyone.deny).toContain(PermissionFlagsBits.SendMessages);
  });

  it('denies every way of starting a thread, which would be writable', () => {
    expect(everyone.deny).toContain(PermissionFlagsBits.CreatePublicThreads);
    expect(everyone.deny).toContain(PermissionFlagsBits.CreatePrivateThreads);
    expect(everyone.deny).toContain(PermissionFlagsBits.SendMessagesInThreads);
  });

  it('leaves Conquest able to post and attach the map', () => {
    expect(conquest.id).toBe('bot-id');
    expect(conquest.allow).toContain(PermissionFlagsBits.SendMessages);
    expect(conquest.allow).toContain(PermissionFlagsBits.AttachFiles);
    expect(conquest.deny).toBeUndefined();
  });

  it('grants view explicitly, so a private category stays public here', () => {
    expect(everyone.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(conquest.allow).toContain(PermissionFlagsBits.ViewChannel);
  });
});

describe('remainingCategorySlots', () => {
  it('counts every existing channel — game log included — against the cap', () => {
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
