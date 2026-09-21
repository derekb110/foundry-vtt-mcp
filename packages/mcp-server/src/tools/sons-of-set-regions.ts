import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

/**
 * Tools for the Sons of Set Regions module (https://github.com/derekb110/sons-of-set-regions).
 *
 * Same shape as sons-of-set-bridge.ts: the Foundry-side bridge relays any query name to
 * `CONFIG.queries[name]`, the module registers handlers under the `sons-of-set.` prefix, and this
 * file only declares the tools that forward to them. Nothing in `packages/foundry-module` changes.
 *
 * The module validates shapes, converts coordinate frames, and checks that every behavior type is
 * registered; `system` blocks pass through verbatim. Errors are rethrown untouched — the module's
 * refusal names exactly what it rejected.
 */

export interface SonsOfSetRegionToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const QUERY_PREFIX = 'sons-of-set.';

/** Literal copy of `BRIDGE_QUERIES` in the module's `scripts/module.mjs`, minus the prefix. */
const TOOL_QUERIES = {
  'scene-info': 'sceneInfo',
  'region-list': 'regionList',
  'region-create': 'regionCreate',
  'region-update': 'regionUpdate',
  'region-delete': 'regionDelete',
  'behavior-toggle': 'behaviorToggle',
} as const;

const SCENE_ID = {
  type: 'string',
  description:
    'Scene id, "Scene.<id>" uuid, or exact scene name. Omit for the scene the GM is viewing (falls back to the active scene).',
} as const;

const UNITS = {
  type: 'string',
  enum: ['px', 'grid'],
  description:
    'Unit for every x/y/width/height/radius/radiusX/radiusY/points value in shapes. "px" (default) is raw canvas pixels; "grid" multiplies by the scene grid size, so 1 = one square.',
} as const;

const ORIGIN = {
  type: 'string',
  enum: ['canvas', 'scene'],
  description:
    'Where (0,0) is. "canvas" (default) is the padded canvas origin, as Foundry stores shapes. "scene" is the top-left of the map art (sceneRect from scene-info) — pair it with units:"grid" to place shapes in map squares.',
} as const;

const SHAPE_SCHEMA = {
  type: 'object',
  description:
    'One region shape. rectangle: x,y (top-left), width, height, rotation? · circle: x,y (center), radius · ellipse: x,y (center), radiusX, radiusY, rotation? · polygon: points as a flat [x0,y0,x1,y1,...] list. hole:true subtracts the shape from the ones before it.',
  properties: {
    type: { type: 'string', enum: ['rectangle', 'circle', 'ellipse', 'polygon'] },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    radius: { type: 'number' },
    radiusX: { type: 'number' },
    radiusY: { type: 'number' },
    rotation: { type: 'number', description: 'Degrees. rectangle and ellipse only.' },
    points: { type: 'array', items: { type: 'number' } },
    hole: { type: 'boolean' },
  },
  required: ['type'],
  additionalProperties: false,
} as const;

const BEHAVIOR_SCHEMA = {
  type: 'object',
  description:
    "A RegionBehavior, passed to Foundry verbatim. type must be a registered behavior type (core v14: displayScrollingText, modifyMovementCost, applyActiveEffect, toggleBehavior, teleportToken, executeScript, executeMacro, pauseGame, suppressWeather, adjustDarknessLevel, changeLevel, defineSurface — scene-info with schema:true lists the live set with every system field). Field names inside system are the caller's responsibility; check them against scene-info schema:true first. Verified on 14.365: displayScrollingText fires on tokenAnimateIn (not tokenEnter) and its visibility is 0 GM / 1 Observer / 2 Anyone; modifyMovementCost.difficulties keys are walk/fly/swim/burrow on dnd5e; toggleBehavior runs its disable set then its enable set of behavior uuids; teleportToken takes a destinations set of region uuids.",
  properties: {
    _id: {
      type: 'string',
      description:
        'Only meaningful for region-update with behaviorMode "merge": updates that behavior in place.',
    },
    type: { type: 'string' },
    name: { type: 'string' },
    disabled: {
      type: 'boolean',
      description:
        'A disabled behavior stays on the region but does nothing until behavior-toggle enables it.',
    },
    system: { type: 'object', additionalProperties: true },
    flags: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
} as const;

const REGION_COMMON = {
  name: { type: 'string' },
  color: { type: 'string', description: 'Hex color, e.g. "#c0392b".' },
  shapes: {
    type: 'array',
    items: SHAPE_SCHEMA,
    description: 'At least one shape. Later shapes with hole:true cut out of earlier ones.',
  },
  behaviors: { type: 'array', items: BEHAVIOR_SCHEMA },
  elevation: {
    type: 'object',
    description:
      'Passed verbatim. Foundry 14.365 stores {bottom, top, topInclusive} in scene distance units; scene-info schema:true → schema.elevation confirms the shape on the connected version.',
    additionalProperties: true,
  },
  restriction: {
    type: 'object',
    description:
      'v14 region-level restriction, passed verbatim: {enabled, type: "light"|"darkness"|"sight"|"sound"|"move", priority}. type "move" blocks movement into the region without any behavior.',
    additionalProperties: true,
  },
  levels: {
    type: 'array',
    items: { type: 'string' },
    description:
      'v14 Scene Levels this region belongs to, by level id (see scene-info levels). Omit on scenes without levels.',
  },
  visibility: {
    type: 'number',
    description: 'CONST.REGION_VISIBILITY: 0 layer only (default), 1 gamemaster, 2 always.',
  },
  locked: { type: 'boolean' },
  flags: { type: 'object', additionalProperties: true },
} as const;

export class SonsOfSetRegionTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor(options: SonsOfSetRegionToolsOptions) {
    this.foundryClient = options.foundryClient;
    this.logger = options.logger.child({ component: 'SonsOfSetRegionTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'scene-info',
        description:
          'Sons of Set Regions module. Dimensions, grid, padding, sceneRect (where the map art sits on the padded canvas), v14 levels, a summary of every region and its behaviors (with uuids), and placeable counts for a scene. Pass schema:true to also dump the live Region and RegionBehavior schemas — every behavior type with its system field names, choices and events — which is how to verify field names before region-create. GM client only.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            schema: {
              type: 'boolean',
              description:
                'Include the Region/RegionBehavior schema dump. Default false; the dump is large.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'region-list',
        description:
          'Sons of Set Regions module. Every region on a scene. full:true (default) returns each region as Foundry stores it (toObject) plus uuids — shapes in canvas pixels, behaviors with their system blocks. full:false returns the same summary scene-info gives.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            full: { type: 'boolean', description: 'Default true.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'region-create',
        description:
          'Sons of Set Regions module. Create one or more Scene Regions, each with shapes and optional behaviors, in one call. Shapes are converted from units/origin into canvas pixels; behaviors go to Foundry verbatim after a type check. Returns each created region with its id, uuid, and behavior ids/uuids (needed for toggleBehavior targets: "Scene.<id>.Region.<id>.RegionBehavior.<id>").',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            units: UNITS,
            origin: ORIGIN,
            regions: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: REGION_COMMON,
                required: ['name', 'shapes'],
                additionalProperties: false,
              },
            },
          },
          required: ['regions'],
          additionalProperties: false,
        },
      },
      {
        name: 'region-update',
        description:
          'Sons of Set Regions module. Update existing regions. Each entry names its target by _id or by exact name and carries only the fields to change. shapes replaces the whole shape list. behaviors is applied by behaviorMode: "replace" (default) deletes the region\'s behaviors and creates the given ones; "append" adds them; "merge" updates entries that carry a behavior _id and creates the rest.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            units: UNITS,
            origin: ORIGIN,
            behaviorMode: {
              type: 'string',
              enum: ['replace', 'append', 'merge'],
              description: 'How a behaviors array is applied. Default replace.',
            },
            regions: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  _id: {
                    type: 'string',
                    description: 'The region to update. Preferred over name.',
                  },
                  ...REGION_COMMON,
                },
                additionalProperties: false,
              },
            },
          },
          required: ['regions'],
          additionalProperties: false,
        },
      },
      {
        name: 'region-delete',
        description:
          'Sons of Set Regions module. Delete regions by id and/or exact name. A name that matches several regions is refused. Returns the deleted ids and names.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            ids: { type: 'array', items: { type: 'string' } },
            names: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'behavior-toggle',
        description:
          'Sons of Set Regions module. Disable or enable behaviors on one region mid-session — flip the sluice, drop the collapsed causeway in, raise a rubble pile. region is an id or exact name; behavior narrows to one behavior by id or name, or to every behavior of a type; omit it to toggle all of them. disabled defaults to true, so pass disabled:false to switch something on.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: SCENE_ID,
            region: { type: 'string', description: 'Region id or exact name.' },
            behavior: {
              type: 'string',
              description: 'Behavior id, behavior name, or behavior type. Omit for all.',
            },
            disabled: { type: 'boolean', description: 'Default true.' },
          },
          required: ['region'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    const query = TOOL_QUERIES[name as keyof typeof TOOL_QUERIES];
    if (!query) throw new Error(`Unknown Sons of Set regions tool: ${name}`);
    this.logger.info(`Forwarding ${name} to ${QUERY_PREFIX}${query}`);
    // Errors pass through untouched: the module names exactly what it refused.
    return await this.foundryClient.query(`${QUERY_PREFIX}${query}`, args ?? {});
  }
}
