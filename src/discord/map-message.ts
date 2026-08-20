/**
 * The `/map` card: the rendered world, with the standings as its legend.
 */
import {
  AttachmentBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} from 'discord.js';
import type {
  ContainerBuilder,
  Guild,
  InteractionEditReplyOptions,
  MessageCreateOptions,
} from 'discord.js';
import type {Database} from '../db/index.js';
import {mapState} from '../map/index.js';
import type {MapRenderer} from '../map/index.js';
import {getGameLog} from './log.js';
import {ACCENT, container} from './ui.js';

/** File name the map is attached under, referenced by the gallery item. */
export const MAP_FILE_NAME = 'conquest-map.png';

/** Adds the rendered map to the top of a card. */
export function withMapImage(
  card: ContainerBuilder,
  description: string,
): ContainerBuilder {
  card.spliceComponents(
    0,
    0,
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder()
        .setURL(`attachment://${MAP_FILE_NAME}`)
        .setDescription(description),
    ),
  );
  return card;
}

/** Wraps the PNG as an attachment the gallery item can point at. */
export function mapAttachment(png: Buffer): AttachmentBuilder {
  return new AttachmentBuilder(png, {name: MAP_FILE_NAME});
}

/** Components V2 message options carrying a card and its map. */
export function mapMessage(
  card: ContainerBuilder,
  png: Buffer,
): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [card],
    files: [mapAttachment(png)],
  } as MessageCreateOptions;
}

/** The same, for editing a deferred reply. */
export function mapEditReply(
  card: ContainerBuilder,
  png: Buffer,
): InteractionEditReplyOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [card],
    files: [mapAttachment(png)],
  } as unknown as InteractionEditReplyOptions;
}

/**
 * Posts the world as it now stands to the game log, after something redrew it.
 *
 * The map is the clearest way to see what an empire has become, so it follows
 * every country changing hands — and never blocks the event that caused it.
 */
export async function postWorldMap(
  db: Database,
  guild: Guild,
  heading: string,
  description: string,
  map?: MapRenderer,
): Promise<void> {
  if (!map) return;
  try {
    const rendered = await map.render(mapState(db, guild.id));
    const log = await getGameLog(db, guild);
    await log?.send(
      mapMessage(
        withMapImage(container(ACCENT.attacker, heading), description),
        rendered.png,
      ),
    );
  } catch (error) {
    console.error(`Could not post the map for ${guild.id}:`, error);
  }
}
