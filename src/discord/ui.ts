import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import type {
  InteractionReplyOptions,
  MessageCreateOptions,
  InteractionEditReplyOptions,
  MessageEditOptions,
} from 'discord.js';

/**
 * Accent colours for Conquest's containers. Every game message is Components
 * V2, so the accent bar is the only colour Conquest gets to use.
 */
export const ACCENT = {
  /** Neutral information: `/resources`, `/country`, `/help`. */
  neutral: 0x5865f2,
  /** Something succeeded. */
  success: 0x57f287,
  /** Something failed, or the user did something Conquest cannot do. */
  danger: 0xed4245,
  /** A warning the user should read but which did not block the action. */
  warning: 0xfee75c,
  /** Attacker-side messages: declarations, attack votes. */
  attacker: 0xe67e22,
  /** Defender-side messages: defence windows, defence votes. */
  defender: 0x3498db,
} as const;

export type Accent = (typeof ACCENT)[keyof typeof ACCENT];

/**
 * Builds a Components V2 container from markdown blocks, separated by
 * dividers. Empty blocks are dropped so callers can build sections
 * conditionally.
 */
export function container(
  accent: Accent,
  ...blocks: string[]
): ContainerBuilder {
  const built = new ContainerBuilder().setAccentColor(accent);
  const present = blocks.filter(block => block.trim().length > 0);
  present.forEach((block, index) => {
    if (index > 0) {
      built.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );
    }
    built.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
  });
  return built;
}

/**
 * Wraps containers as message options with the Components V2 flag set.
 *
 * The flag disables `content`, `embeds`, `poll`, and `stickers`; Conquest
 * never uses those, so every message is built this way.
 */
export function v2Message(
  ...components: ContainerBuilder[]
): MessageCreateOptions & MessageEditOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components,
  } as MessageCreateOptions & MessageEditOptions;
}

/** Same as {@link v2Message}, but only the invoking user sees the reply. */
export function ephemeral(
  ...components: ContainerBuilder[]
): InteractionReplyOptions {
  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components,
  } as InteractionReplyOptions;
}

/**
 * An ephemeral error card. Every message states what to do next, not just
 * what went wrong.
 *
 * @param problem what failed, as one sentence.
 * @param nextStep the action that fixes it.
 */
export function errorReply(
  problem: string,
  nextStep: string,
): InteractionReplyOptions {
  return ephemeral(container(ACCENT.danger, `### ${problem}`, nextStep));
}

/** Renders an epoch-millisecond timestamp as a live Discord relative time. */
export function relativeTime(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:R>`;
}

/** Renders an epoch-millisecond timestamp as a localised absolute time. */
export function absoluteTime(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:f>`;
}

/** Components V2 options for editing a deferred interaction reply. */
export function v2EditReply(
  ...components: ContainerBuilder[]
): InteractionEditReplyOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components,
  } as unknown as InteractionEditReplyOptions;
}
