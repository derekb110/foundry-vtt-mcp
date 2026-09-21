/**
 * sons-of-set-regions tool schema and forwarding tests.
 *
 * Every write happens inside Foundry, so what is testable here is the schema the model is given
 * and that arguments reach the module's query unchanged. Coordinate conversion and behavior
 * validation live in the module and are exercised against a live world.
 */

import { describe, it, expect, vi } from 'vitest';
import { SonsOfSetRegionTools } from './sons-of-set-regions.js';

function makeTools() {
  const query = vi.fn(async () => ({ created: [] }));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new SonsOfSetRegionTools({ foundryClient, logger });
  return { tools, query };
}

const TOOLS = [
  'scene-info',
  'region-list',
  'region-create',
  'region-update',
  'region-delete',
  'behavior-toggle',
  'note-create',
  'note-delete',
];

describe('SonsOfSetRegionTools definitions', () => {
  it('declares exactly the eight region tools', () => {
    const { tools } = makeTools();
    expect(tools.getToolDefinitions().map(d => d.name)).toEqual(TOOLS);
  });

  it('requires regions on create and update, and region on toggle', () => {
    const { tools } = makeTools();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d as any]));
    expect(byName['region-create'].inputSchema.required).toEqual(['regions']);
    expect(byName['region-update'].inputSchema.required).toEqual(['regions']);
    expect(byName['behavior-toggle'].inputSchema.required).toEqual(['region']);
    expect(byName['note-create'].inputSchema.required).toEqual(['notes']);
    expect(byName['note-create'].inputSchema.properties.notes.items.required).toEqual(['journal']);
    expect(byName['note-delete'].inputSchema.required).toBeUndefined();
    expect(byName['region-create'].inputSchema.properties.regions.items.required).toEqual([
      'name',
      'shapes',
    ]);
  });

  it('offers grid units and a scene origin on create and update', () => {
    const { tools } = makeTools();
    for (const name of ['region-create', 'region-update']) {
      const def: any = tools.getToolDefinitions().find(d => d.name === name);
      expect(def.inputSchema.properties.units.enum).toEqual(['px', 'grid']);
      expect(def.inputSchema.properties.origin.enum).toEqual(['canvas', 'scene']);
    }
  });
});

describe('SonsOfSetRegionTools forwarding', () => {
  it('forwards each tool to its prefixed query with the arguments unchanged', async () => {
    const { tools, query } = makeTools();
    const args = {
      sceneId: 'abc',
      units: 'grid',
      origin: 'scene',
      regions: [
        { name: 'C-Water-High', shapes: [{ type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }] },
      ],
    };
    await tools.handleToolCall('region-create', args);
    expect(query).toHaveBeenCalledWith('sons-of-set.regionCreate', args);
    await tools.handleToolCall('behavior-toggle', { region: 'C-Water-High', disabled: false });
    expect(query).toHaveBeenLastCalledWith('sons-of-set.behaviorToggle', {
      region: 'C-Water-High',
      disabled: false,
    });
  });

  it('forwards note-create and note-delete to their prefixed queries unchanged', async () => {
    const { tools, query } = makeTools();
    const create = {
      sceneId: 'abc',
      replace: true,
      notes: [{ region: 'A-Alarm-Horn', journal: 'Hellfurnace Sky Bastion', text: 'horn' }],
    };
    await tools.handleToolCall('note-create', create);
    expect(query).toHaveBeenCalledWith('sons-of-set.noteCreate', create);
    await tools.handleToolCall('note-delete', { journals: ['Hellfurnace Sky Bastion'] });
    expect(query).toHaveBeenLastCalledWith('sons-of-set.noteDelete', {
      journals: ['Hellfurnace Sky Bastion'],
    });
  });

  it('sends an empty object when the model passes no arguments', async () => {
    const { tools, query } = makeTools();
    await tools.handleToolCall('scene-info', undefined);
    expect(query).toHaveBeenCalledWith('sons-of-set.sceneInfo', {});
  });

  it('refuses a tool it does not own instead of forwarding it', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleToolCall('region-explode', {})).rejects.toThrow(
      'Unknown Sons of Set regions tool'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('lets the module error through untouched', async () => {
    const { tools, query } = makeTools();
    query.mockRejectedValueOnce(
      new Error('sons-of-set-regions | this query runs on a Gamemaster client only.')
    );
    await expect(tools.handleToolCall('scene-info', {})).rejects.toThrow('Gamemaster client only');
  });
});
