import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

/**
 * Tools for the Sons of Set Bridge module (https://github.com/derekb110/sons-of-set-bridge).
 *
 * Same shape as quest-tracker.ts: the Foundry-side bridge relays any query name to
 * `CONFIG.queries[name]`, the module registers handlers under the `sons-of-set.` prefix, and this
 * file only declares the tools that forward to them. Nothing in `packages/foundry-module` changes.
 *
 * The module validates every payload and refuses unknown fields by name, so errors are passed
 * through as-is rather than re-wrapped — a precise refusal from the module is the useful message.
 */

export interface SonsOfSetBridgeToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const QUERY_PREFIX = 'sons-of-set.';

/** Literal copy of `BRIDGE_QUERIES` in the module's `scripts/module.mjs`, minus the prefix. */
const TOOL_QUERIES = {
  'mej-sheet-create': 'mejCreateSheet',
  'mej-sheet-get': 'mejGetSheet',
  'mej-sheet-update': 'mejUpdateSheet',
  'mej-sheet-list': 'mejListSheets',
  'mej-relationship-set': 'mejSetRelationship',
  'mej-shop-stock': 'mejShopStock',
  'chat-list': 'chatList',
} as const;

const SHEET_TYPES = ['person', 'place', 'organization', 'shop', 'poi', 'event'] as const;

const FIELDS_SCHEMA = {
  type: 'object',
  description:
    'Header fields for the sheet type. person: role, location · organization: alignment, location · place: placetype, location · shop: shoptype, location · poi: location · event: location, date. A key the type does not have is refused.',
  additionalProperties: { type: 'string' },
} as const;

const ATTRIBUTES_SCHEMA = {
  type: 'object',
  description:
    "MEJ's detail attributes, string values. Person keys: race, ancestry, gender, age, eyes, skin, hair, life, profession, pronoun, voice, faction, height, weight, traits, ideals, bonds, flaws, longterm, shortterm. Some are hidden by default in MEJ's sheet settings (faction, profession, longterm, shortterm among them) — use those for GM-facing facts.",
  additionalProperties: { type: 'string' },
} as const;

const SHEET_CONTENT = {
  description: {
    type: 'string',
    description:
      'HTML. The sheet body. This is what players read once the sheet is published, so it carries only what the party could know: appearance, public role, what was said across the counter. Hidden roles, goals, tells and DCs go in gmNotes.',
  },
  fields: FIELDS_SCHEMA,
  attributes: ATTRIBUTES_SCHEMA,
  gmNotes: {
    type: 'string',
    description:
      "HTML. Written to the sheet's Notes tab under the GM the bridge is connected as — never visible to players. Hidden role, goals, tells, branches, what happens if the party accepts or refuses.",
  },
  actorUuid: {
    type: ['string', 'null'],
    description:
      'A world Actor uuid ("Actor.xxxx") to link as the sheet\'s actor. Person sheets only, in practice. null clears it.',
  },
  img: {
    type: 'string',
    description: "Portrait or image path. Defaults to the linked actor's image when one is given.",
  },
} as const;

const SHEET_REF = {
  uuid: {
    type: 'string',
    description: "The sheet entry's uuid. Preferred over name; never send both.",
  },
  name: {
    type: 'string',
    description: "The sheet's exact name, if you do not have its uuid. Never send both.",
  },
} as const;

export class SonsOfSetBridgeTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SonsOfSetBridgeToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger;
  }

  getToolDefinitions() {
    return [
      {
        name: 'mej-sheet-create',
        description:
          "Create a Monk's Enhanced Journal sheet — a person, place, organization, shop, poi or event — with its description, header fields, attributes, GM notes and an optional actor link. Created GM-only; publishing is the GM's. Refused if an entry with that name already exists (use mej-sheet-update). Quests are not handled here — use quest-create.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The sheet name (also the journal entry name).' },
            type: { type: 'string', enum: [...SHEET_TYPES], description: 'The MEJ sheet type.' },
            folderName: {
              type: 'string',
              description: 'Journal folder to put it in, created if absent. Omit for no folder.',
            },
            ...SHEET_CONTENT,
          },
          required: ['name', 'type'],
          additionalProperties: false,
        },
      },
      {
        name: 'mej-sheet-get',
        description:
          'One MEJ sheet whole, as the GM sees it: description, header fields, attributes, linked actor, GM notes, and every relationship with its labels, secret, revealed and hidden flags.',
        inputSchema: { type: 'object', properties: { ...SHEET_REF }, additionalProperties: false },
      },
      {
        name: 'mej-sheet-update',
        description:
          'Merge changes into an existing MEJ sheet. A field you leave out stays as it is; attributes merge key by key; description and gmNotes replace whole. newName renames the entry and its page.',
        inputSchema: {
          type: 'object',
          properties: {
            ...SHEET_REF,
            newName: { type: 'string', description: 'Rename the sheet.' },
            ...SHEET_CONTENT,
            shop: {
              type: 'object',
              description: 'Shop sheets only; refused elsewhere.',
              properties: {
                state: { type: 'string', enum: ['open', 'closed'] },
                purchasing: {
                  type: 'string',
                  enum: ['locked', 'free', 'confirm'],
                  description:
                    'How players buy: locked, free, or confirm (GM approves each request).',
                },
                selling: {
                  type: 'string',
                  enum: ['locked', 'free', 'confirm'],
                  description: 'How players sell to the shop.',
                },
                twentyfour: { type: 'boolean', description: '24-hour clock on the sheet.' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'mej-sheet-list',
        description:
          'Every MEJ sheet in the world (person, place, organization, shop, poi, event), one line each: uuid, name, type, folder, whether it is published, and how many relationships it has. Read this before creating or linking, to find the one you mean.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...SHEET_TYPES], description: 'Only this type.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'mej-relationship-set',
        description:
          'Link two MEJ sheets in both directions. relationship is the label shown on the from-sheet ("Proprietor"), reverse the label on the to-sheet ("Her employer"; defaults to relationship). secret and reverseSecret are the secret-relationship lines the GM can reveal later. hidden keeps the link off player views entirely. Re-sending a pair changes only the fields named. remove: true deletes the link both ways.',
        inputSchema: {
          type: 'object',
          properties: {
            fromUuid: { type: 'string' },
            fromName: { type: 'string' },
            toUuid: { type: 'string' },
            toName: { type: 'string' },
            relationship: { type: 'string' },
            reverse: { type: 'string' },
            secret: { type: 'string' },
            reverseSecret: { type: 'string' },
            hidden: { type: 'boolean' },
            remove: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'mej-shop-stock',
        description:
          'Stock an MEJ shop sheet: add items, change stock rows, remove them. add takes item uuids (world "Item.xxxx" or compendium "Compendium.pack.Item.xxxx"); price defaults from the item\'s system price and cost (what buyers pay) defaults to price. Adding an item already in stock bumps its quantity. update/remove address rows by the id mej-shop-stock returned or by exact item name. dnd5e spells are refused — stock a scroll item. Shop open/closed and purchasing mode live on mej-sheet-update\'s shop block.',
        inputSchema: {
          type: 'object',
          properties: {
            ...SHEET_REF,
            add: {
              type: 'array',
              description: 'Items to add to stock.',
              items: {
                type: 'object',
                properties: {
                  itemUuid: { type: 'string', description: 'World or compendium Item uuid.' },
                  quantity: { type: 'number', description: 'Default 1.' },
                  price: {
                    type: 'string',
                    description: '"25 gp". Default: the item\'s system price.',
                  },
                  cost: { type: 'string', description: 'What buyers pay. Default: price.' },
                  hide: { type: 'boolean', description: 'Hidden from players. Default false.' },
                  lock: { type: 'boolean', description: 'Not purchasable. Default false.' },
                },
                required: ['itemUuid'],
                additionalProperties: false,
              },
            },
            update: {
              type: 'array',
              description:
                'Stock rows to change. quantity also resets remaining unless remaining is sent too.',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'The stock row id. Preferred; never with itemName.',
                  },
                  itemName: {
                    type: 'string',
                    description: 'Exact item name, if unique in this shop.',
                  },
                  quantity: { type: 'number' },
                  remaining: {
                    type: 'number',
                    description: 'Stock left to sell, if different from quantity.',
                  },
                  price: { type: 'string' },
                  cost: { type: 'string' },
                  hide: { type: 'boolean' },
                  lock: { type: 'boolean' },
                },
                additionalProperties: false,
              },
            },
            remove: {
              type: 'array',
              description:
                'Stock rows to drop: row ids, exact item names, or { id } / { itemName } objects.',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: { id: { type: 'string' }, itemName: { type: 'string' } },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'chat-list',
        description:
          "Read the world's chat log: time, user, speaker alias, text (HTML stripped), rolls with formula and total, whisper flag. Newest last. Use since/until (ISO timestamps) to bound a session; limit defaults to 200, max 2000, and the result says whether it was truncated.",
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO timestamp; messages at or after it.' },
            until: { type: 'string', description: 'ISO timestamp; messages at or before it.' },
            limit: {
              type: 'number',
              description: 'Most recent N in range. Default 200, max 2000.',
            },
            includeWhispers: { type: 'boolean', description: 'Default true.' },
            includeRolls: { type: 'boolean', description: 'Default true.' },
            plainText: { type: 'boolean', description: 'Strip HTML from content. Default true.' },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    const query = TOOL_QUERIES[name as keyof typeof TOOL_QUERIES];
    if (!query) throw new Error(`Unknown Sons of Set bridge tool: ${name}`);
    this.logger.info(`Forwarding ${name} to ${QUERY_PREFIX}${query}`);
    // Errors pass through untouched: the module names exactly what it refused.
    return await this.foundryClient.query(`${QUERY_PREFIX}${query}`, args ?? {});
  }
}
