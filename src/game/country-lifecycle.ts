/**
 * Creating, archiving, and tearing down a country's Discord presence.
 *
 * Permissions are role-based throughout: a country is a role plus a private
 * channel, and membership is the role. Conquest never writes per-user channel
 * overwrites.
 */
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import type {
  CategoryChannel,
  Guild,
  GuildMember,
  OverwriteData,
  Role,
  TextChannel,
} from 'discord.js';
import type {CountryData} from '../data/countries.js';
import {
  countryChannelName,
  countryRoleName,
  defeatedChannelName,
} from '../data/countries.js';
import {activateCountry, deactivateCountry} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {countryColor} from './colors.js';

/** What a country's private channel grants its own members. */
const MEMBER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
] as const;

/** What Conquest itself needs in a country channel. */
const CONQUEST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageMessages,
] as const;

/** Overwrites for a country's private channel: its role, and nobody else. */
export function countryChannelOverwrites(
  everyoneRoleId: string,
  countryRoleId: string,
  conquestId: string,
): OverwriteData[] {
  return [
    {id: everyoneRoleId, deny: [PermissionFlagsBits.ViewChannel]},
    {id: countryRoleId, allow: [...MEMBER_PERMISSIONS]},
    {id: conquestId, allow: [...CONQUEST_PERMISSIONS]},
  ];
}

/**
 * Overwrites for a defeated country's channel: a read-only archive its
 * conquerors may browse.
 *
 * The defeated role is gone by the time this settles, so the winner's role is
 * what carries access.
 */
export function archiveOverwrites(
  everyoneRoleId: string,
  winnerRoleId: string,
  conquestId: string,
): OverwriteData[] {
  return [
    {id: everyoneRoleId, deny: [PermissionFlagsBits.ViewChannel]},
    {
      id: winnerRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
    {id: conquestId, allow: [...CONQUEST_PERMISSIONS]},
  ];
}

/** A country's freshly created Discord presence. */
export interface CountryPresence {
  state: CountryState;
  role: Role;
  channel: TextChannel;
}

/**
 * Founds a country: creates its role and private channel, then records it.
 *
 * Discord resources are created before the database is written and torn down
 * again if that write fails, so a failed activation never leaves an orphaned
 * channel behind.
 */
export async function foundCountry(
  db: Database,
  guild: Guild,
  category: CategoryChannel,
  country: CountryData,
  now: number,
): Promise<CountryPresence> {
  const conquestId = (guild.members.me ?? (await guild.members.fetchMe())).id;

  const role = await guild.roles.create({
    name: countryRoleName(country),
    color: countryColor(country.code),
    // Countries get pinged when they are invaded.
    mentionable: true,
    reason: `Conquest: ${country.name} activated`,
  });

  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: countryChannelName(country),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: countryChannelOverwrites(
        guild.roles.everyone.id,
        role.id,
        conquestId,
      ),
      topic: `${country.flag} ${country.name} — plan here. Only members of this country can see this channel.`,
      reason: `Conquest: ${country.name} activated`,
    });
  } catch (error) {
    await role
      .delete('Conquest: rolling back a failed activation')
      .catch(() => undefined);
    throw error;
  }

  try {
    const state = activateCountry(db, {
      guildId: guild.id,
      code: country.code,
      name: country.name,
      channelId: channel.id,
      roleId: role.id,
      now,
    });
    return {state, role, channel};
  } catch (error) {
    await channel
      .delete('Conquest: rolling back a failed activation')
      .catch(() => undefined);
    await role
      .delete('Conquest: rolling back a failed activation')
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Disbands a country whose last player left: deletes its channel and role,
 * releases every territory it held, and deletes those archives too.
 *
 * The database is updated first, in one transaction, so a Discord failure
 * midway leaves stale channels rather than a game that still believes in a
 * country nobody is in.
 */
export async function disbandCountry(
  db: Database,
  guild: Guild,
  state: CountryState,
): Promise<void> {
  const released = deactivateCountry(db, guild.id, state.code);

  const channelIds = [
    state.channelId,
    ...released.map(territory => territory.channelId),
  ].filter((id): id is string => id !== null);

  for (const channelId of channelIds) {
    await guild.channels
      .delete(channelId, `Conquest: ${state.name} disbanded`)
      .catch(() => undefined);
  }
  if (state.roleId) {
    await guild.roles
      .delete(state.roleId, `Conquest: ${state.name} disbanded`)
      .catch(() => undefined);
  }
}

/**
 * Turns a conquered country's channel into a read-only archive the winners
 * can browse, and renames it with a surrender marker.
 */
export async function archiveCountryChannel(
  guild: Guild,
  channel: TextChannel,
  country: CountryData,
  winnerRoleId: string,
): Promise<void> {
  const conquestId = (guild.members.me ?? (await guild.members.fetchMe())).id;
  await channel.edit({
    name: defeatedChannelName(country),
    permissionOverwrites: archiveOverwrites(
      guild.roles.everyone.id,
      winnerRoleId,
      conquestId,
    ),
    reason: `Conquest: ${country.name} conquered`,
  });
}

/**
 * Hands an archive to a new owner, as when a conqueror is itself conquered
 * and its spoils change hands.
 */
export async function reassignArchive(
  guild: Guild,
  channel: TextChannel,
  winnerRoleId: string,
): Promise<void> {
  const conquestId = (guild.members.me ?? (await guild.members.fetchMe())).id;
  await channel.edit({
    permissionOverwrites: archiveOverwrites(
      guild.roles.everyone.id,
      winnerRoleId,
      conquestId,
    ),
    reason: 'Conquest: archive changed hands',
  });
}

/** Puts a player in a country by giving them its role. */
export async function grantCountryRole(
  member: GuildMember,
  roleId: string,
  reason: string,
): Promise<void> {
  await member.roles.add(roleId, reason);
}

/** Takes a player out of a country by removing its role. */
export async function revokeCountryRole(
  member: GuildMember,
  roleId: string,
  reason: string,
): Promise<void> {
  await member.roles.remove(roleId, reason);
}
