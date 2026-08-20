/**
 * The Discord half of one country becoming part of another.
 *
 * Conquest and merging leave the world in the same shape, so they leave
 * Discord in the same shape too: the absorbed country's people take the
 * absorbing country's role, its channel becomes a read-only archive the new
 * owner can browse, every archive it held changes hands, and its own role is
 * deleted last — until then it is what lets its people read the archive.
 *
 * The database transaction has already committed by the time any of this runs;
 * each step is attempted on its own and a failure leaves stale Discord state
 * rather than a game that disagrees with itself.
 */
import {ChannelType} from 'discord.js';
import type {Guild} from 'discord.js';
import {findCountry} from '../data/countries.js';
import {setCountryChannel} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {
  archiveCountryChannel,
  grantCountryRole,
  reassignArchive,
  revokeCountryRole,
} from './country-lifecycle.js';

/** One country passing into another's hands, however it got there. */
export interface Absorption {
  /** The country that has stopped standing on its own. */
  absorbedCode: string;
  /** Players who must now wear the absorbing country's role. */
  transferredPlayers: readonly string[];
  /** Countries that changed hands, the absorbed country included. */
  capturedTerritories: readonly CountryState[];
  /** The absorbed country's role, deleted once nobody needs it. */
  absorbedRoleId: string | null;
  /** The absorbed country's channel, which becomes the archive. */
  absorbedChannelId: string | null;
  /** The absorbing country's role, which takes over the archives. */
  absorberRoleId: string | null;
}

/**
 * Moves roles, archives channels, and hands over territory.
 *
 * @param reason what Discord's audit log should say this was.
 */
export async function applyAbsorption(
  db: Database,
  guild: Guild,
  absorption: Absorption,
  reason: string,
): Promise<void> {
  const {absorbedCode, absorberRoleId} = absorption;

  if (absorberRoleId) {
    for (const userId of absorption.transferredPlayers) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      await grantCountryRole(member, absorberRoleId, reason).catch(
        () => undefined,
      );
      if (absorption.absorbedRoleId) {
        await revokeCountryRole(
          member,
          absorption.absorbedRoleId,
          reason,
        ).catch(() => undefined);
      }
    }
  }

  const absorbed = findCountry(absorbedCode);
  if (absorption.absorbedChannelId && absorberRoleId && absorbed) {
    const channel = await guild.channels
      .fetch(absorption.absorbedChannelId)
      .catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await archiveCountryChannel(
        guild,
        channel,
        absorbed,
        absorberRoleId,
      ).catch(() => undefined);
      setCountryChannel(db, guild.id, absorbedCode, channel.id);
    }
  }

  // Everything the absorbed country had taken changes hands with it.
  for (const territory of absorption.capturedTerritories) {
    if (territory.code === absorbedCode) continue;
    if (!territory.channelId || !absorberRoleId) continue;
    const channel = await guild.channels
      .fetch(territory.channelId)
      .catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await reassignArchive(guild, channel, absorberRoleId).catch(
        () => undefined,
      );
    }
  }

  // Its role goes last: until now it was what let its people read the archive.
  if (absorption.absorbedRoleId) {
    await guild.roles
      .delete(absorption.absorbedRoleId, reason)
      .catch(() => undefined);
  }
}
