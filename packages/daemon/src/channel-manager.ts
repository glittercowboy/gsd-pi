/**
 * ChannelManager — manages per-project Discord text channels under a
 * 'GSD Projects' category, with archive support.
 *
 * Pure helper `sanitizeChannelName` exported separately for testability.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type CategoryChannel,
  type TextChannel,
  type GuildBasedChannel,
} from 'discord.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORY_NAME = 'GSD Projects';
const ARCHIVE_CATEGORY_NAME = 'GSD Archive';
const CHANNEL_PREFIX = 'gsd-';
const MAX_CHANNEL_NAME_LENGTH = 100; // Discord's limit

// ---------------------------------------------------------------------------
// Pure helpers — exported for testability
// ---------------------------------------------------------------------------

/**
 * Sanitize a project directory path into a valid Discord channel name.
 *
 * - Takes the basename of the path
 * - Lowercases
 * - Replaces non-alphanumeric (except hyphens) with hyphens
 * - Collapses consecutive hyphens
 * - Trims leading/trailing hyphens
 * - Prefixes with 'gsd-'
 * - Caps total length at 100 chars (Discord limit)
 *
 * Returns 'gsd-unnamed' for empty/whitespace-only inputs.
 */
export function sanitizeChannelName(projectDir: string): string {
  // Extract basename — handle both forward and back slashes
  const parts = projectDir.replace(/\\/g, '/').split('/');
  let basename = parts[parts.length - 1] ?? '';

  // Trim whitespace
  basename = basename.trim();

  // Fallback for empty basename
  if (!basename) {
    return 'gsd-unnamed';
  }

  // Lowercase
  let name = basename.toLowerCase();

  // Replace non-alphanumeric (except hyphens) with hyphens
  name = name.replace(/[^a-z0-9-]/g, '-');

  // Collapse consecutive hyphens
  name = name.replace(/-{2,}/g, '-');

  // Trim leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, '');

  // Fallback if nothing remains after sanitization
  if (!name) {
    return 'gsd-unnamed';
  }

  // Prefix
  const prefixed = `${CHANNEL_PREFIX}${name}`;

  // Cap at max length
  if (prefixed.length > MAX_CHANNEL_NAME_LENGTH) {
    // Truncate and remove any trailing hyphen from the cut
    return prefixed.slice(0, MAX_CHANNEL_NAME_LENGTH).replace(/-+$/, '');
  }

  return prefixed;
}

// ---------------------------------------------------------------------------
// ChannelManager class
// ---------------------------------------------------------------------------

export interface ChannelManagerOptions {
  guild: Guild;
  logger: Logger;
  categoryName?: string;
}

export class ChannelManager {
  private readonly guild: Guild;
  private readonly logger: Logger;
  private readonly categoryName: string;

  private categoryCache: CategoryChannel | null = null;
  private archiveCategoryCache: CategoryChannel | null = null;

  constructor(opts: ChannelManagerOptions) {
    this.guild = opts.guild;
    this.logger = opts.logger;
    this.categoryName = opts.categoryName ?? DEFAULT_CATEGORY_NAME;
  }

  /**
   * Find or create the project category channel.
   * Caches the result — subsequent calls return the cached category.
   */
  async resolveCategory(): Promise<CategoryChannel> {
    if (this.categoryCache) {
      return this.categoryCache;
    }

    const existing = this.findCategoryByName(this.categoryName);
    if (existing) {
      this.categoryCache = existing;
      this.logger.debug('category resolved from cache', { name: this.categoryName, id: existing.id });
      return existing;
    }

    // Create the category
    const created = await this.guild.channels.create({
      name: this.categoryName,
      type: ChannelType.GuildCategory,
    });

    this.categoryCache = created as CategoryChannel;
    this.logger.info('category created', { name: this.categoryName, id: created.id });
    return this.categoryCache;
  }

  /**
   * Create a text channel for a project under the GSD Projects category.
   * Channel name is derived from the project directory path.
   */
  async createProjectChannel(projectDir: string): Promise<TextChannel> {
    const name = sanitizeChannelName(projectDir);
    const category = await this.resolveCategory();

    const channel = await this.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
    });

    this.logger.info('project channel created', {
      name,
      channelId: channel.id,
      categoryId: category.id,
      projectDir,
    });

    return channel as TextChannel;
  }

  /**
   * Archive a channel by moving it to the 'GSD Archive' category and
   * setting permission overwrite to deny ViewChannel for @everyone.
   */
  async archiveChannel(channelId: string): Promise<void> {
    const archive = await this.resolveArchiveCategory();

    const channel = this.guild.channels.cache.get(channelId);
    if (!channel) {
      this.logger.warn('archive target not found', { channelId });
      return;
    }

    if (!('edit' in channel) || typeof channel.edit !== 'function') {
      this.logger.warn('archive target is not editable', { channelId, type: channel.type });
      return;
    }

    await channel.edit({
      parent: archive.id,
      permissionOverwrites: [
        {
          id: this.guild.id, // @everyone role ID matches guild ID
          deny: [PermissionFlagsBits.ViewChannel],
        },
      ],
    });

    this.logger.info('channel archived', { channelId, archiveCategoryId: archive.id });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findCategoryByName(name: string): CategoryChannel | null {
    const match = this.guild.channels.cache.find(
      (ch: GuildBasedChannel) => ch.type === ChannelType.GuildCategory && ch.name === name,
    );
    return (match as CategoryChannel) ?? null;
  }

  private async resolveArchiveCategory(): Promise<CategoryChannel> {
    if (this.archiveCategoryCache) {
      return this.archiveCategoryCache;
    }

    const existing = this.findCategoryByName(ARCHIVE_CATEGORY_NAME);
    if (existing) {
      this.archiveCategoryCache = existing;
      return existing;
    }

    const created = await this.guild.channels.create({
      name: ARCHIVE_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });

    this.archiveCategoryCache = created as CategoryChannel;
    this.logger.info('archive category created', { name: ARCHIVE_CATEGORY_NAME, id: created.id });
    return this.archiveCategoryCache;
  }
}
