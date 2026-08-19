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
  InteractionEditReplyOptions,
  MessageCreateOptions,
} from 'discord.js';

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
