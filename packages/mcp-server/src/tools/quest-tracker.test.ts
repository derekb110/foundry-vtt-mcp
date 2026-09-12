/**
 * quest-tracker tool schema and forwarding tests.
 *
 * Every write these tools make happens inside Foundry, so what is testable here is the schema the
 * model is given and that the arguments reach the module's query unchanged. `correction` is worth
 * holding to both: the module refuses a non-forward status without it, and a tool that quietly
 * dropped the flag would look to the model like the module refusing a move it had declared.
 */

import { describe, it, expect, vi } from 'vitest';
import { QuestTrackerTools } from './quest-tracker.js';

function makeTools() {
  const query = vi.fn(async () => ({ uuid: 'JournalEntry.abc', name: 'The Hollow Ledger' }));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new QuestTrackerTools({ foundryClient, logger });
  return { tools, query };
}

function definition(name: string) {
  const { tools } = makeTools();
  const def = tools.getToolDefinitions().find(d => d.name === name);
  if (!def) throw new Error(`no tool definition for ${name}`);
  return def as any;
}

describe('quest-update correction', () => {
  it('advertises correction as a boolean on quest-update', () => {
    const correction = definition('quest-update').inputSchema.properties.correction;
    expect(correction?.type).toBe('boolean');
  });

  it('tells the model to set correction only when the GM asks', () => {
    const { description } = definition('quest-update').inputSchema.properties.correction;
    expect(description).toMatch(/asks/i);
    expect(description).toMatch(/never on your own/i);
  });

  it('does not offer correction on quest-create, which has no status to undo', () => {
    expect(definition('quest-create').inputSchema.properties.correction).toBeUndefined();
  });

  it('forwards correction unchanged to the module query', async () => {
    const { tools, query } = makeTools();
    await tools.handleToolCall('quest-update', {
      uuid: 'JournalEntry.abc',
      status: 'lead',
      correction: true,
    });
    expect(query).toHaveBeenCalledWith('quest-tracker.updateQuest', {
      uuid: 'JournalEntry.abc',
      status: 'lead',
      correction: true,
    });
  });

  it('sends no correction key when the caller did not set one', async () => {
    const { tools, query } = makeTools();
    await tools.handleToolCall('quest-update', { uuid: 'JournalEntry.abc', status: 'active' });
    const [, payload] = query.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.hasOwn(payload, 'correction')).toBe(false);
  });
});
