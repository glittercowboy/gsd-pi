import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import type { SdkAgentEvent } from '@gsd-build/rpc-client';
import type { PendingBlocker, FormattedEvent } from './types.js';
import type { RpcExtensionUIRequest } from '@gsd-build/rpc-client';
import {
  formatToolStart,
  formatToolEnd,
  formatMessage,
  formatBlocker,
  formatCompletion,
  formatError,
  formatCostUpdate,
  formatSessionStarted,
  formatTaskTransition,
  formatGenericEvent,
  formatEvent,
} from './event-formatter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function embedColor(fe: FormattedEvent): number | null {
  return fe.embed?.data.color ?? null;
}

function embedTitle(fe: FormattedEvent): string | undefined {
  return fe.embed?.data.title;
}

function embedDescription(fe: FormattedEvent): string | undefined {
  return fe.embed?.data.description;
}

// ---------------------------------------------------------------------------
// formatToolStart
// ---------------------------------------------------------------------------

describe('formatToolStart', () => {
  it('produces grey embed with tool name', () => {
    const result = formatToolStart({ type: 'tool_execution_start', name: 'read_file' });
    assert.ok(result.content.includes('read_file'));
    assert.equal(embedColor(result), 0x95a5a6); // grey
    assert.ok(embedTitle(result)?.includes('read_file'));
  });

  it('handles missing name gracefully', () => {
    const result = formatToolStart({ type: 'tool_execution_start' });
    assert.ok(result.content.includes('unknown'));
  });

  it('includes input in description when present', () => {
    const result = formatToolStart({ type: 'tool_execution_start', name: 'bash', input: 'ls -la' });
    assert.ok(embedDescription(result)?.includes('ls -la'));
  });
});

// ---------------------------------------------------------------------------
// formatToolEnd
// ---------------------------------------------------------------------------

describe('formatToolEnd', () => {
  it('shows success icon for normal completion', () => {
    const result = formatToolEnd({ type: 'tool_execution_end', name: 'read_file', output: 'done' });
    assert.ok(result.content.includes('✅'));
    assert.equal(embedColor(result), 0x95a5a6); // grey
  });

  it('shows error icon and red color for errored tool', () => {
    const result = formatToolEnd({ type: 'tool_execution_end', name: 'bash', isError: true });
    assert.ok(result.content.includes('❌'));
    assert.equal(embedColor(result), 0xe74c3c); // red
  });

  it('includes duration when present', () => {
    const result = formatToolEnd({ type: 'tool_execution_end', name: 'bash', duration: 3500 });
    assert.ok(result.embed?.data.footer?.text?.includes('3.5s'));
  });
});

// ---------------------------------------------------------------------------
// formatMessage
// ---------------------------------------------------------------------------

describe('formatMessage', () => {
  it('extracts text from content blocks', () => {
    const result = formatMessage({
      type: 'message',
      content: [{ type: 'text', text: 'Hello world' }],
    });
    assert.ok(embedDescription(result)?.includes('Hello world'));
    assert.equal(embedColor(result), 0x3498db); // blue
  });

  it('falls back to message field when content is a string', () => {
    const result = formatMessage({ type: 'message', message: 'plain text' });
    assert.ok(embedDescription(result)?.includes('plain text'));
  });

  it('handles empty content blocks', () => {
    const result = formatMessage({ type: 'message', content: [] });
    assert.ok(result.content.includes('empty message'));
    assert.equal(result.embed, undefined);
  });

  it('handles null content gracefully', () => {
    const result = formatMessage({ type: 'message' });
    assert.ok(result.content.includes('empty message'));
  });
});

// ---------------------------------------------------------------------------
// formatBlocker — select
// ---------------------------------------------------------------------------

describe('formatBlocker', () => {
  it('produces ActionRow with numbered buttons for select', () => {
    const blocker: PendingBlocker = {
      id: 'req-1',
      method: 'select',
      message: 'Choose an option',
      event: {
        type: 'extension_ui_request',
        id: 'req-1',
        method: 'select',
        title: 'Choose',
        options: ['Option A', 'Option B', 'Option C'],
      },
    };

    const result = formatBlocker(blocker, '12345');
    assert.ok(result.content.includes('<@12345>'));
    assert.equal(embedColor(result), 0xf1c40f); // yellow
    assert.ok(result.components);
    assert.ok(result.components!.length > 0);

    // Check buttons
    const row = result.components![0];
    const buttons = row.components;
    assert.equal(buttons.length, 3);
  });

  it('handles empty options array for select', () => {
    const blocker: PendingBlocker = {
      id: 'req-2',
      method: 'select',
      message: 'Pick one',
      event: {
        type: 'extension_ui_request',
        id: 'req-2',
        method: 'select',
        title: 'Pick',
        options: [],
      },
    };

    const result = formatBlocker(blocker, '12345');
    // No components when no options
    assert.equal(result.components, undefined);
    // Embed should show 'No options'
    const fields = result.embed?.data.fields;
    assert.ok(fields?.some((f) => f.value.includes('No options')));
  });

  it('produces Yes/No buttons for confirm', () => {
    const blocker: PendingBlocker = {
      id: 'req-3',
      method: 'confirm',
      message: 'Are you sure?',
      event: {
        type: 'extension_ui_request',
        id: 'req-3',
        method: 'confirm',
        title: 'Confirm',
        message: 'This will delete everything',
      },
    };

    const result = formatBlocker(blocker, '99999');
    assert.ok(result.components);
    assert.equal(result.components!.length, 1);
    const buttons = result.components![0].components;
    assert.equal(buttons.length, 2);
  });

  it('produces text instructions for input method', () => {
    const blocker: PendingBlocker = {
      id: 'req-4',
      method: 'input',
      message: 'Enter your name',
      event: {
        type: 'extension_ui_request',
        id: 'req-4',
        method: 'input',
        title: 'Name',
        placeholder: 'John Doe',
      },
    };

    const result = formatBlocker(blocker, '12345');
    // No interactive buttons for input — text instructions only
    assert.equal(result.components, undefined);
    const fields = result.embed?.data.fields;
    assert.ok(fields?.some((f) => f.value.includes('Reply in this channel')));
  });

  it('produces text instructions for editor method', () => {
    const blocker: PendingBlocker = {
      id: 'req-5',
      method: 'editor',
      message: 'Edit the config',
      event: {
        type: 'extension_ui_request',
        id: 'req-5',
        method: 'editor',
        title: 'Config',
        prefill: 'key: value',
      },
    };

    const result = formatBlocker(blocker, '12345');
    assert.equal(result.components, undefined);
    const fields = result.embed?.data.fields;
    assert.ok(fields?.some((f) => f.value.includes('Reply in this channel')));
    assert.ok(fields?.some((f) => f.value.includes('key: value')));
  });
});

// ---------------------------------------------------------------------------
// formatCompletion
// ---------------------------------------------------------------------------

describe('formatCompletion', () => {
  it('shows green for completed', () => {
    const result = formatCompletion({ type: 'execution_complete', status: 'completed' });
    assert.equal(embedColor(result), 0x2ecc71); // green
    assert.ok(result.content.includes('🏁'));
  });

  it('shows red for error status', () => {
    const result = formatCompletion({
      type: 'execution_complete',
      status: 'error',
      reason: 'Out of tokens',
    });
    assert.equal(embedColor(result), 0xe74c3c); // red
    assert.ok(embedDescription(result)?.includes('Out of tokens'));
  });

  it('includes stats when present', () => {
    const result = formatCompletion({
      type: 'execution_complete',
      status: 'completed',
      stats: { cost: 0.42, tokens: { total: 10000 } },
    });
    const fields = result.embed?.data.fields;
    assert.ok(fields?.some((f) => f.value.includes('$0.42')));
    assert.ok(fields?.some((f) => f.value.includes('10,000')));
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe('formatError', () => {
  it('includes session ID and error message', () => {
    const result = formatError('sess-abc', 'Connection refused');
    assert.equal(embedColor(result), 0xe74c3c); // red
    assert.ok(embedDescription(result)?.includes('Connection refused'));
    assert.ok(result.embed?.data.footer?.text?.includes('sess-abc'));
  });
});

// ---------------------------------------------------------------------------
// formatCostUpdate
// ---------------------------------------------------------------------------

describe('formatCostUpdate', () => {
  it('formats cumulative cost', () => {
    const result = formatCostUpdate({
      type: 'cost_update',
      cumulativeCost: 1.23,
      tokens: { input: 5000, output: 2000 },
    });
    assert.ok(result.content.includes('$1.23'));
    assert.equal(embedColor(result), 0x3498db); // blue
  });

  it('handles zero cost', () => {
    const result = formatCostUpdate({
      type: 'cost_update',
      cumulativeCost: 0,
      tokens: { input: 0, output: 0 },
    });
    assert.ok(result.content.includes('$0.0000'));
  });
});

// ---------------------------------------------------------------------------
// formatSessionStarted
// ---------------------------------------------------------------------------

describe('formatSessionStarted', () => {
  it('includes project name', () => {
    const result = formatSessionStarted('my-project');
    assert.ok(result.content.includes('my-project'));
    assert.ok(embedDescription(result)?.includes('my-project'));
    assert.equal(embedColor(result), 0x3498db); // blue
  });
});

// ---------------------------------------------------------------------------
// formatTaskTransition
// ---------------------------------------------------------------------------

describe('formatTaskTransition', () => {
  it('shows complete icon for completed tasks', () => {
    const result = formatTaskTransition({
      type: 'task_transition',
      taskId: 'T01',
      sliceId: 'S01',
      status: 'complete',
    });
    assert.ok(result.content.includes('✅'));
    assert.equal(embedColor(result), 0x2ecc71); // green
  });

  it('shows error icon for errored tasks', () => {
    const result = formatTaskTransition({
      type: 'task_transition',
      taskId: 'T02',
      status: 'error',
    });
    assert.ok(result.content.includes('❌'));
    assert.equal(embedColor(result), 0xe74c3c); // red
  });
});

// ---------------------------------------------------------------------------
// formatGenericEvent
// ---------------------------------------------------------------------------

describe('formatGenericEvent', () => {
  it('renders unknown event type as grey embed', () => {
    const result = formatGenericEvent({ type: 'some_custom_event', data: 'hello' });
    assert.equal(embedColor(result), 0x95a5a6); // grey
    assert.ok(embedTitle(result)?.includes('some_custom_event'));
  });

  it('handles events with no extra fields', () => {
    const result = formatGenericEvent({ type: 'bare_event' });
    assert.ok(result.content.includes('bare_event'));
  });
});

// ---------------------------------------------------------------------------
// formatEvent — dispatch
// ---------------------------------------------------------------------------

describe('formatEvent', () => {
  it('dispatches tool_execution_start', () => {
    const result = formatEvent({ type: 'tool_execution_start', name: 'read' });
    assert.ok(result.content.includes('🔧'));
  });

  it('dispatches execution_complete', () => {
    const result = formatEvent({ type: 'execution_complete', status: 'completed' });
    assert.ok(result.content.includes('🏁'));
  });

  it('falls back to generic for unknown types', () => {
    const result = formatEvent({ type: 'totally_unknown' });
    assert.ok(result.content.includes('📡'));
  });

  it('dispatches cost_update', () => {
    const result = formatEvent({ type: 'cost_update', cumulativeCost: 0.5 });
    assert.ok(result.content.includes('💰'));
  });

  it('dispatches message types', () => {
    for (const type of ['message_start', 'message_end', 'message']) {
      const result = formatEvent({ type, message: 'hi' });
      assert.ok(result.content.includes('💬'), `Failed for type: ${type}`);
    }
  });

  // Negative: missing type field
  it('handles event with missing type gracefully', () => {
    const result = formatEvent({} as SdkAgentEvent);
    assert.ok(result.content); // should not throw
  });

  // Negative: null fields
  it('handles event with null fields gracefully', () => {
    const result = formatEvent({ type: 'tool_execution_start', name: null } as unknown as SdkAgentEvent);
    assert.ok(result.content);
  });
});
