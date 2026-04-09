/**
 * Slash command definitions, guild-scoped registration, and status formatting.
 *
 * Commands are registered per-guild (not globally) for instant availability.
 * Registration failures are non-fatal — the bot continues without slash commands.
 */

import {
  SlashCommandBuilder,
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { ManagedSession } from './types.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

/**
 * Build the array of slash command JSON payloads for guild registration.
 */
export function buildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName('gsd-status')
      .setDescription('Show status of all active GSD sessions')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('gsd-start')
      .setDescription('Start a new GSD session')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('gsd-stop')
      .setDescription('Stop a running GSD session')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('gsd-verbose')
      .setDescription('Set event verbosity level for this channel')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('Verbosity level')
          .setRequired(false)
          .addChoices(
            { name: 'default', value: 'default' },
            { name: 'verbose', value: 'verbose' },
            { name: 'quiet', value: 'quiet' },
          ),
      )
      .toJSON(),
  ];
}

// ---------------------------------------------------------------------------
// Guild-scoped registration
// ---------------------------------------------------------------------------

/**
 * Register slash commands for a specific guild via PUT.
 * Non-fatal: logs errors and returns false on failure.
 */
export async function registerGuildCommands(
  rest: REST,
  clientId: string,
  guildId: string,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
  logger?: Logger,
): Promise<boolean> {
  try {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );
    logger?.info('commands registered', { count: commands.length, guildId });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn('command registration failed', {
      guildId,
      error: message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status formatting
// ---------------------------------------------------------------------------

/**
 * Format session list for /gsd-status reply.
 * Shows projectName, status, duration, and cost for each session.
 * Returns 'No active sessions.' if the array is empty.
 */
export function formatSessionStatus(sessions: ManagedSession[]): string {
  if (sessions.length === 0) {
    return 'No active sessions.';
  }

  const lines = sessions.map((s) => {
    const durationMs = Date.now() - s.startTime;
    const durationMin = Math.floor(durationMs / 60_000);
    const cost = s.cost.totalCost.toFixed(4);
    return `• **${s.projectName}** — ${s.status} (${durationMin}m, $${cost})`;
  });

  return lines.join('\n');
}
