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

describe('quest giver links', () => {
  it('advertises an actor end and a faction end, each nullable, on both quest tools', () => {
    for (const tool of ['quest-create', 'quest-update']) {
      const giver = definition(tool).inputSchema.properties.giver;
      expect(giver.additionalProperties).toBe(false);
      expect(Object.keys(giver.properties).sort()).toEqual(
        ['actorName', 'actorUuid', 'factionName', 'factionUuid', 'label'].sort()
      );
      for (const end of ['actorUuid', 'actorName', 'factionUuid', 'factionName']) {
        expect(giver.properties[end].type).toEqual(['string', 'null']);
      }
    }
  });

  it('tells the model that naming only the actor keeps the faction, and null clears', () => {
    const { description } = definition('quest-update').inputSchema.properties.giver;
    expect(description).toMatch(/keeps the faction/i);
    expect(description).toMatch(/null clears/i);
    expect(description).toMatch(/never a compendium/i);
  });

  it('forwards a giver unchanged, a null end included', async () => {
    const { tools, query } = makeTools();
    const giver = { actorName: 'Lord Rhyne', factionUuid: null };
    await tools.handleToolCall('quest-update', { name: 'The Hollow Ledger', giver });
    expect(query).toHaveBeenCalledWith('quest-tracker.updateQuest', {
      name: 'The Hollow Ledger',
      giver: { actorName: 'Lord Rhyne', factionUuid: null },
    });
  });
});

describe('stage actors', () => {
  const actorsOf = (tool: string) =>
    definition(tool).inputSchema.properties.stages.items.properties.actors;

  it('lets a Stage carry actors on quest-create and quest-update', () => {
    for (const tool of ['quest-create', 'quest-update']) {
      const actors = actorsOf(tool);
      expect(actors?.type).toBe('array');
      expect(Object.keys(actors.items.properties).sort()).toEqual(
        ['actorName', 'actorUuid', 'label', 'reveal', 'role'].sort()
      );
      expect(actors.items.additionalProperties).toBe(false);
    }
  });

  it("offers the module's five roles and three reveal states, and says reveal defaults to hidden", () => {
    const { role, reveal } = actorsOf('quest-create').items.properties;
    expect(role.enum).toEqual(['meet', 'defeat', 'protect', 'find', 'other']);
    expect(reveal.enum).toEqual(['hidden', 'unknown', 'named']);
    expect(reveal.description).toMatch(/default: hidden/i);
  });

  it('tells the model the actor has to be a world actor, named once', () => {
    const { description } = actorsOf('quest-create');
    expect(description).toMatch(/world/i);
    expect(description).toMatch(/never both/i);
  });

  it('forwards stage actors unchanged to the module query', async () => {
    const { tools, query } = makeTools();
    const args = {
      name: 'The Warded Chapel',
      stages: [
        {
          title: 'Raise the ward',
          actors: [
            { actorName: 'Brother Aldous', role: 'protect', reveal: 'named' },
            { actorUuid: 'Actor.x1y2z3', role: 'defeat' },
          ],
        },
      ],
    };
    await tools.handleToolCall('quest-create', args);
    expect(query).toHaveBeenCalledWith('quest-tracker.createQuest', args);
  });
});
