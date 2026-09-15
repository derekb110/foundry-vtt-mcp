import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';

/**
 * Tools for the Quest Tracker module (https://github.com/derekb110/quest-tracker).
 *
 * The Foundry-side bridge module relays any query name to `CONFIG.queries[name]`, so Quest Tracker
 * registers its own handlers under the `quest-tracker.` prefix and this file only declares the
 * tools that forward to them. Nothing here is modified in `packages/foundry-module`.
 *
 * Arguments are forwarded as given. The Foundry handler validates the whole payload before it
 * writes anything and refuses an unknown or forbidden field by name, so a second copy of the
 * schema here would only be a second thing to keep in step with the module.
 */

export interface QuestTrackerToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const QUERY_PREFIX = 'quest-tracker.';

/**
 * Which module query each tool forwards to.
 *
 * These are the names in `BRIDGE_QUERIES` in the module's `scripts/quest-ops.mjs`, minus the
 * prefix above. That list is the source of truth and this is a literal copy, because the server
 * cannot import from a Foundry module; a node test there holds the list and the prefix to the
 * table in the module's README. A query renamed there is renamed here.
 */
const TOOL_QUERIES = {
  'quest-create': 'createQuest',
  'quest-update': 'updateQuest',
  'faction-create': 'createFaction',
  'faction-update': 'updateFaction',
  'quest-list': 'listQuests',
  'quest-get': 'getQuest',
} as const;

/** HTML strings are what the module stores: these fields are rendered as written. */
const html = (description: string) => ({ type: 'string' as const, description });

const STATUS_VALUES = ['lead', 'active', 'resolved', 'failed', 'expired'] as const;

const GIVER_SCHEMA = {
  type: 'object',
  description:
    "The person, office, or faction the quest is issued on behalf of: a free-text label, a world Actor, a Faction, or both, the faction then being the actor's cover story. Name each link by its uuid or its name, never both. On quest-update only the keys you send change: naming just the actor keeps the faction already on the giver, and an end sent as null clears that link. When the giver already has a faction and you are changing the actor, ask the GM whether to keep it before you send null. Actors come from this world only, never a compendium or a token; a name that matches no actor or several is refused, so find the uuid with actor-list or actor-get. The faction is the one the party is told; the actor's real faction is never read from here.",
  properties: {
    label: {
      type: 'string',
      description: 'How the party would name them, e.g. "The harbourmaster\'s clerk".',
    },
    actorUuid: {
      type: ['string', 'null'],
      description: "A world actor's uuid, e.g. \"Actor.a1b2c3\". Preferred over actorName. null clears the actor.",
    },
    actorName: {
      type: ['string', 'null'],
      description:
        "A world actor's exact name, capitals included, if you do not have its uuid. Never send with actorUuid.",
    },
    factionUuid: {
      type: ['string', 'null'],
      description: "The faction entry's uuid. Preferred over factionName. null clears the faction.",
    },
    factionName: {
      type: ['string', 'null'],
      description:
        "The faction's exact name in the world, if you do not have its uuid. Never send with factionUuid.",
    },
  },
  additionalProperties: false,
} as const;

/** The module's `STAGE_ACTOR_ROLE` and `STAGE_ACTOR_REVEAL`, copied for the same reason the query names are. */
const STAGE_ACTOR_ROLES = ['meet', 'defeat', 'protect', 'find', 'other'] as const;
const STAGE_ACTOR_REVEALS = ['hidden', 'unknown', 'named'] as const;

const STAGE_ACTORS_SCHEMA = {
  type: 'array',
  description:
    "Who the Stage turns on, written with a Stage that is new to the quest. Name each actor by actorName or actorUuid, never both. It has to be one of the world's own actors — a compendium or token actor is refused — and a name that matches no actor or several is refused, so name a common name like \"Guard\" by uuid. The same actor twice on one Stage is refused. Every actor is looked up before anything is written, so one bad name fails the whole call. A Stage arrives hidden unless it is sent with revealed true, so no actor reaches a player until the Stage is revealed and the quest published.",
  items: {
    type: 'object',
    properties: {
      actorName: {
        type: 'string',
        description:
          "A world actor's exact name, capitals included, if you do not have its uuid. Never send with actorUuid.",
      },
      actorUuid: {
        type: 'string',
        description: 'The world actor\'s uuid, e.g. "Actor.abc123". Preferred when names repeat.',
      },
      role: {
        type: 'string',
        enum: STAGE_ACTOR_ROLES,
        description: 'What the Stage says the actor is there for. Default: meet.',
      },
      label: {
        type: 'string',
        description: 'The word printed when role is "other". Refused on any other role.',
      },
      reveal: {
        type: 'string',
        enum: STAGE_ACTOR_REVEALS,
        description:
          'What the party is handed of this actor once the GM reveals the Stage: hidden is nothing, unknown is "Unknown" with the role word, named is the name and portrait. Default: hidden.',
      },
    },
    additionalProperties: false,
  },
} as const;

const STAGE_CHANGES_SCHEMA = {
  type: 'array',
  description:
    "Changes to the actors on Stages the quest already has; a Stage's title, text and objectives are never changed here. Name each Stage by stageUuid, or by stageTitle when only one of the quest's Stages has that title — read the quest with quest-get for both — and name each Stage once. \"actors\" adds an actor the Stage does not carry, hidden unless you say otherwise, and changes an actor it does carry: only the fields you send change, so a role or a reveal can move without removing the actor. \"remove\" takes actors off; naming one the Stage does not carry is refused. Name each actor once per Stage change. \"revealed\" reveals or hides the Stage. Every Stage and actor is looked up before anything is written, so one bad title or name fails the whole call. A Stage the same call adds under \"stages\" cannot be changed here yet.",
  items: {
    type: 'object',
    properties: {
      stageUuid: {
        type: 'string',
        description: "The Stage page's uuid, as quest-get reports it. Preferred; never send with stageTitle.",
      },
      stageTitle: {
        type: 'string',
        description:
          "The Stage's exact title, capitals included, if only one of the quest's Stages has it. Never send with stageUuid.",
      },
      actors: {
        ...STAGE_ACTORS_SCHEMA,
        description:
          "Actors to add to the Stage or change on it, in a new Stage's actor shape. For an actor already on the Stage only the fields you send change; a new one defaults to role meet and reveal hidden. A label is refused unless the actor's role, sent or kept, is other.",
      },
      remove: {
        type: 'array',
        description: 'Actors to take off the Stage. Each has to be on it already.',
        items: {
          type: 'object',
          properties: {
            actorUuid: {
              type: 'string',
              description: 'The world actor\'s uuid, e.g. "Actor.abc123". Never send with actorName.',
            },
            actorName: {
              type: 'string',
              description:
                "A world actor's exact name, capitals included, if you do not have its uuid. Never send with actorUuid.",
            },
          },
          additionalProperties: false,
        },
      },
      revealed: {
        type: 'boolean',
        description:
          "true reveals the Stage to the party and false hides it again, the same as the GM's Reveal eye on the quest card; left out, the Stage stays as it is. It does not publish the quest, and an actor sent as hidden stays hidden.",
      },
    },
    additionalProperties: false,
  },
} as const;

const STAGES_SCHEMA = {
  type: 'array',
  description:
    "The quest's Stages in play order. Each becomes its own page so it can be revealed on its own; a new Stage arrives hidden unless it is sent with revealed true.",
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: "The Stage's name, which is also its page name." },
      html: html('The Stage in party voice, as HTML.'),
      actors: STAGE_ACTORS_SCHEMA,
      revealed: {
        type: 'boolean',
        description:
          "true makes the Stage arrive revealed, the same as the GM's Reveal eye on the quest card; left out or false, it arrives hidden. It does not publish the quest, so the party sees it once the GM publishes. A Stage skipped by title is skipped with its revealed; reveal a Stage the quest already has through stageChanges.",
      },
      objectives: {
        type: 'array',
        description:
          'Optional checklist. A bare string is an Objective the party can see; { text, hidden } is one they have not been told about yet.',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                text: { type: 'string' },
                hidden: {
                  type: 'boolean',
                  description: 'True for an Objective the party has not been told about.',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
} as const;

const FACTIONS_SCHEMA = {
  type: 'array',
  description:
    'Factions the quest is for, against, or merely tangled with. Name each by factionName or factionUuid, never both; the faction has to exist already.',
  items: {
    type: 'object',
    properties: {
      factionName: { type: 'string', description: "The faction's name in the world." },
      factionUuid: { type: 'string', description: "The faction entry's uuid, if you have it." },
      role: {
        type: 'string',
        enum: ['for', 'against', 'involved'],
        description: 'Default: involved.',
      },
      revealed: { type: 'boolean', description: 'Has the table been told? Default: false.' },
    },
    additionalProperties: false,
  },
} as const;

/** The LOG block fields, shared by quest-create and quest-update. */
const QUEST_FIELDS = {
  hub: { type: 'string', description: 'The settlement or base the quest is issued from.' },
  giver: GIVER_SCHEMA,
  objective: html('What the party is trying to do, in party voice. Player-facing.'),
  leads: html('The quest\'s own "Leads:" line with its confidence tiers. Player-facing.'),
  remains: html('The current "what remains" line. Player-facing.'),
  promised: html('The reward as the party was told it. Player-facing.'),
  actual: html('The reward the GM intends to pay, which may differ from Promised. GM-only.'),
  paidBy: { type: 'string', description: 'Who actually pays, and where. GM-only.' },
  resolution: html('The observable condition the GM counts as the quest being done. GM-only.'),
  purpose: html('What the quest is really for in the campaign. GM-only.'),
  followOn: html('What this quest opens when it narrows or resolves. GM-only.'),
  queued: {
    type: 'array',
    description:
      'Additions waiting on something happening in the fiction before they appear. GM-only.',
    items: {
      type: 'object',
      properties: {
        addition: { type: 'string', description: 'What gets added.' },
        trigger: { type: 'string', description: 'The in-fiction event that adds it.' },
      },
      additionalProperties: false,
    },
  },
  status: {
    type: 'string',
    enum: STATUS_VALUES,
    description:
      'Lead: the party knows about it but has not acted. Active: they have. Resolved: dead as a thread, whether or not something remains. Failed: they acted and lost — a Lead never fails. Expired: the clock passed its deadline.',
  },
  deadline: {
    type: 'object',
    description:
      'The phrase the party heard. Setting its date against the world clock is done in Foundry.',
    properties: {
      text: { type: 'string', description: 'e.g. "Before the next convoy leaves".' },
    },
    additionalProperties: false,
  },
  factions: FACTIONS_SCHEMA,
  stages: STAGES_SCHEMA,
} as const;

const FACTION_FIELDS = {
  kind: {
    type: 'string',
    description: 'A free label: organisation, people, cult, force, curse. Player-facing.',
  },
  description: html('What the faction is and what it wants. Player-facing.'),
  standing: html('Where the party sits with them, in prose. GM-only.'),
  gmNotes: html('What is actually going on. GM-only.'),
  relationships: {
    type: 'array',
    description:
      'What this faction is to others. Symmetric and stored once, so naming the same pair again changes that tie rather than adding a second, and on an update it changes only the fields you name. Name the far end by otherName or otherUuid, never both.',
    items: {
      type: 'object',
      properties: {
        otherName: { type: 'string', description: "The other faction's name in the world." },
        otherUuid: {
          type: 'string',
          description: "The other faction entry's uuid, if you have it.",
        },
        tier: {
          type: 'string',
          enum: ['allied', 'neutral', 'opposed'],
          description: 'On a create, default: neutral. On an update, left as it is unless named.',
        },
        gmNote: { type: 'string', description: 'What is really between them. GM-only.' },
        playerNote: { type: 'string', description: "The party's own line about it." },
        revealed: {
          type: 'boolean',
          description:
            'Has the table been told? On a create, default: false. On an update, left as it is unless named — do not send it to mean "no".',
        },
      },
      additionalProperties: false,
    },
  },
} as const;

export class QuestTrackerTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: QuestTrackerToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'QuestTrackerTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  /**
   * Get all tool definitions for MCP registration
   */
  getToolDefinitions() {
    return [
      {
        name: 'quest-create',
        description:
          "Create a Quest in the Quest Tracker module: a journal entry in the Quests folder with an overview page and one page per Stage. The field names are the campaign's LOG block names. The quest is created unpublished, and every Stage arrives hidden unless it is sent with revealed true — Publish is the GM's, at the table.",
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: "The quest's name, as the party would call the thread.",
            },
            ...QUEST_FIELDS,
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'quest-update',
        description:
          'Change a Quest that already exists. Name it by uuid, or by name if you do not have one, but never both at once — a payload carrying both is refused. A field you leave out stays as it is. Stages are append-only by title: a title the quest already has is left alone and reported back in "skipped". To add, change or remove actors on a Stage the quest already has, or to reveal or hide it, use "stageChanges", which never touches a Stage\'s title, text or objectives. Publish is the GM\'s. "factions" and "queued" add and change, and never remove: an entry already on the quest keeps every field you leave out, and one you do not mention stays; taking a faction link or a queued addition off a quest is done on the sheet in Foundry. Use "narrowing" after the party makes progress — it rewrites the what-remains line and appends the before-and-after to the GM-only history. A "status" that is not a forward move is refused unless the payload also carries "correction": true, which you send only when the GM has asked for the undo.',
        inputSchema: {
          type: 'object',
          properties: {
            uuid: {
              type: 'string',
              description: "The quest entry's uuid. Preferred over name; never send both.",
            },
            name: {
              type: 'string',
              description: "The quest's name, if you do not have its uuid. Never send both.",
            },
            ...QUEST_FIELDS,
            stageChanges: STAGE_CHANGES_SCHEMA,
            narrowing: {
              type: 'object',
              description:
                'A Narrowing: what the party took and what is still open. Appended to the GM history, never rewritten.',
              properties: {
                date: {
                  type: 'string',
                  description: "The in-world date, in the campaign's calendar.",
                },
                taken: { type: 'string', description: 'What the party settled.' },
                remains: {
                  type: 'string',
                  description: 'What is still open. Becomes the new what-remains line.',
                },
              },
              required: ['taken', 'remains'],
              additionalProperties: false,
            },
            correction: {
              type: 'boolean',
              description:
                "Declares that the status in this payload is a move the campaign's own order refuses — Resolved, Failed, or Expired back to Lead or Active, or Active back to Lead. Send it only when the GM asks you to undo or correct a status, and never on your own initiative: a status carried over from an earlier read is the likelier mistake, so without this flag the module refuses the move rather than put a finished quest back on the board for every player. Forward moves — Lead to Active, Active to Resolved, Failed, or Expired — never need it.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'faction-create',
        description:
          "Create a Faction in the Quest Tracker module: any named force with wants and relationships — an organisation, a people, a cult, a curse. Created unpublished; publishing it is the GM's.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: "The faction's name." },
            ...FACTION_FIELDS,
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'faction-update',
        description:
          'Change a Faction that already exists, and what it is to other factions. Name it by uuid, or by name if you do not have one, but never both at once — a payload carrying both is refused. A field you leave out stays as it is, and a relationship you do not name is left alone. A relationship you do name changes only the fields named: re-send a pair with just a tier and its notes and its revealed flag stay exactly as the GM left them.',
        inputSchema: {
          type: 'object',
          properties: {
            uuid: {
              type: 'string',
              description: "The faction entry's uuid. Preferred over name; never send both.",
            },
            name: {
              type: 'string',
              description: "The faction's name, if you do not have its uuid. Never send both.",
            },
            ...FACTION_FIELDS,
          },
          additionalProperties: false,
        },
      },
      {
        name: 'quest-list',
        description:
          'Every Quest in the world, one line each: uuid, name, status, hub, whether it is published, and how many Stages it has. Read this before changing a quest, to find the one you mean.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'quest-get',
        description:
          'One Quest whole, as the GM sees it: every overview field including the GM-only ones, and every Stage with its text, its Objectives, whether it has been revealed, and its actors, each with its reveal.',
        inputSchema: {
          type: 'object',
          properties: {
            uuid: { type: 'string', description: "The quest entry's uuid. Preferred over name." },
            name: { type: 'string', description: "The quest's name, if you do not have its uuid." },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  /**
   * Handle tool execution
   */
  async handleToolCall(name: string, args: any): Promise<any> {
    const query = TOOL_QUERIES[name as keyof typeof TOOL_QUERIES];
    if (!query) throw new Error(`Unknown quest tracker tool: ${name}`);
    return this.forward(name, query, args);
  }

  /**
   * Forward a tool call to the module's own query handler inside Foundry.
   *
   * The handler runs on the GM client this bridge is connected to and refuses on any other, so a
   * refusal here is usually that: the bridge is connected as a player.
   */
  private async forward(toolName: string, query: string, args: any): Promise<any> {
    try {
      this.logger.info(`Forwarding ${toolName} to ${QUERY_PREFIX}${query}`);
      return await this.foundryClient.query(`${QUERY_PREFIX}${query}`, args ?? {});
    } catch (error) {
      this.errorHandler.handleToolError(error, toolName, 'quest tracker');
    }
  }
}
