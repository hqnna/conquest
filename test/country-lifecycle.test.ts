import {describe, expect, it} from 'vitest';
import {PermissionFlagsBits} from 'discord.js';
import {
  archiveOverwrites,
  countryChannelOverwrites,
} from '../src/game/country-lifecycle.js';

describe('countryChannelOverwrites', () => {
  const [everyone, countryRole, conquest] = countryChannelOverwrites(
    'everyone',
    'role-fr',
    'bot',
  );

  it('hides a country channel from the rest of the server', () => {
    expect(everyone.id).toBe('everyone');
    expect(everyone.deny).toEqual([PermissionFlagsBits.ViewChannel]);
  });

  it('gives the country role the run of its own channel', () => {
    expect(countryRole.id).toBe('role-fr');
    expect(countryRole.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(countryRole.allow).toContain(PermissionFlagsBits.SendMessages);
  });

  it('grants access by role only, never per user', () => {
    for (const overwrite of [everyone, countryRole, conquest]) {
      expect(typeof overwrite.id).toBe('string');
    }
    expect(countryChannelOverwrites('everyone', 'role-fr', 'bot')).toHaveLength(
      3,
    );
  });

  it('leaves Conquest able to post there', () => {
    expect(conquest.id).toBe('bot');
    expect(conquest.allow).toContain(PermissionFlagsBits.SendMessages);
  });
});

describe('archiveOverwrites', () => {
  const [everyone, winner] = archiveOverwrites('everyone', 'role-de', 'bot');

  it('keeps the archive hidden from the server at large', () => {
    expect(everyone.deny).toEqual([PermissionFlagsBits.ViewChannel]);
  });

  it('lets the conquerors read the history they took', () => {
    expect(winner.id).toBe('role-de');
    expect(winner.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(winner.allow).toContain(PermissionFlagsBits.ReadMessageHistory);
  });

  it('makes it read-only, threads included', () => {
    expect(winner.deny).toContain(PermissionFlagsBits.SendMessages);
    expect(winner.deny).toContain(PermissionFlagsBits.CreatePublicThreads);
    expect(winner.deny).toContain(PermissionFlagsBits.CreatePrivateThreads);
    expect(winner.deny).toContain(PermissionFlagsBits.SendMessagesInThreads);
  });
});
