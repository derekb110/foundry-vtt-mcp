# Spec — Chat-message region behavior + wall tools

_Written 2026-09-25. A delta on the Sons of Set Regions tools (`claude_Region_Tools_Handoff_2026-09-20.md`). That handoff has shipped here: `4d9a175` (region tools), `8cc6703` (v14 field notes), `eaf34e0` (note-create / note-delete)._

---

## 1. Context and boundaries

Two repos are involved. Most of the work is in the module.

| Repo                                                                     | What changes                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `derekb110/sons-of-set-regions` (Foundry module, **not cloned locally**) | New `chatMessage` RegionBehavior type, four wall query handlers, `BRIDGE_QUERIES` entries, and `module.json`/`lang` additions |
| `~/foundry-vtt-mcp` (this fork)                                          | Four forwarder tools in `packages/mcp-server/src/tools/sons-of-set-regions.ts` and their tests. **Nothing else changes.**     |

The architecture rule from `CHAT_HANDLER_SPEC.md` §2 and ADR-0005 still holds: the bridge relays any query name to `CONFIG.queries[name]`, so every Foundry-side handler lives in the module and this fork stays server-side only. Do **not** touch `packages/foundry-module`.

Query names use the existing prefix **`sons-of-set.`**, not `sons-of-set-regions.`. The module id `sons-of-set-regions` is used only for the behavior type name and for flag scopes.

Target: Forge worlds on **Foundry 14.365 / dnd5e 5.3.3**. Local `tester` (14.367 / 6.0.1) is not a valid stand-in for field-name checks.

---

## 2. Part A — `sons-of-set-regions.chatMessage` RegionBehavior (module only)

### 2.1 Why

`displayScrollingText` scrolls past too fast at a seven-player table. A registered behavior type, used instead of an `executeScript` in each region, gives:

- a config sheet in the Region UI
- GM-only or owner-only whispers
- a once-per-token option
- a normal entry in `region-list` and `scene-info schema:true`, like any core behavior

The forwarder needs **no** change for this. `BEHAVIOR_SCHEMA` already passes `type`/`system` through verbatim, and the module's type check accepts anything in `CONFIG.RegionBehavior.dataModels`. Update the `BEHAVIOR_SCHEMA` description string to name the new type (§4.3).

### 2.2 Verify first

Check these in a v14 GM console before writing the class. The draft below was written against v13 docs:

```js
foundry.data.regionBehaviors.RegionBehaviorType._createEventsField; // signature
CONFIG.RegionBehavior.dataModels.displayScrollingText.LOCALIZATION_PREFIXES;
Object.values(CONST.REGION_EVENTS); // exact event strings
```

Earlier work found that `displayScrollingText` fires on `tokenAnimateIn`, not `tokenEnter` (see `BEHAVIOR_SCHEMA`). Before settling the event list, check which of enter / animate-in / move-in is the right trigger for "a token walked in".

### 2.3 `module.json`

```json
"documentTypes": { "RegionBehavior": { "chatMessage": {} } },
"languages": [{ "lang": "en", "name": "English", "path": "lang/en.json" }]
```

Foundry derives the full type name `sons-of-set-regions.chatMessage`. Add `lang/en.json` with `SOS.REGION.CHAT.FIELDS.<field>.label/hint`, or skip localization and live with raw field names on the sheet.

### 2.4 `scripts/chat-message-behavior.mjs` (draft)

```js
const { RegionBehaviorType } = foundry.data.regionBehaviors;
const { HTMLField, BooleanField, StringField } = foundry.data.fields;

export class ChatMessageRegionBehaviorType extends RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ['SOS.REGION.CHAT'];

  static defineSchema() {
    return {
      events: this._createEventsField({
        events: [
          CONST.REGION_EVENTS.TOKEN_ENTER,
          CONST.REGION_EVENTS.TOKEN_EXIT,
          CONST.REGION_EVENTS.TOKEN_MOVE_IN,
          CONST.REGION_EVENTS.TOKEN_MOVE_OUT,
          CONST.REGION_EVENTS.TOKEN_TURN_START,
          CONST.REGION_EVENTS.TOKEN_TURN_END,
          CONST.REGION_EVENTS.TOKEN_ROUND_START,
          CONST.REGION_EVENTS.TOKEN_ROUND_END,
        ],
      }),
      text: new HTMLField({ required: true, blank: false }),
      whisper: new StringField({
        required: true,
        initial: 'gm',
        choices: { gm: 'GM only', token: 'Token owner + GM', all: 'Everyone' },
      }),
      once: new BooleanField({ initial: false }), // once per token per behavior
      flavor: new StringField({ required: false, blank: true }), // chat card flavor line
    };
  }

  /** @override */
  async _handleRegionEvent(event) {
    if (!game.users.activeGM?.isSelf) return; // exactly one client sends
    const token = event.data?.token;
    if (this.once && token) {
      const key = `chatOnce.${this.parent.id}`;
      if (token.getFlag('sons-of-set-regions', key)) return;
      await token.setFlag('sons-of-set-regions', key, true);
    }
    const regionName = this.parent.region?.name ?? 'Region';
    const speaker = token
      ? ChatMessage.getSpeaker({ token })
      : ChatMessage.getSpeaker({ alias: regionName });
    const gmIds = ChatMessage.getWhisperRecipients('GM').map(u => u.id);
    let whisper;
    if (this.whisper === 'gm') whisper = gmIds;
    else if (this.whisper === 'token' && token?.actor) {
      const owners = game.users
        .filter(u => token.actor.testUserPermission(u, 'OWNER'))
        .map(u => u.id);
      whisper = [...new Set([...owners, ...gmIds])];
    }
    const content = this.text
      .replaceAll('{token}', token?.name ?? 'Someone')
      .replaceAll('{region}', this.parent.region?.name ?? '');
    await ChatMessage.create({ content, speaker, whisper, flavor: this.flavor || undefined });
  }
}
```

Changes from the 2026-09-25 delta draft:

- **`game.users.activeGM?.isSelf` replaces `game.user.isGM`.** With two GM seats open (the Forge tab plus a local tab), `isGM` sends every message twice.
- **The flag key is `chatOnce.<behaviorId>`.** Foundry treats dots in a flag key as a path, so the draft's `sos.chat.<id>` created a nested `sos.chat` object. Picking the nesting on purpose keeps it readable and makes a reset easy: delete `flags.sons-of-set-regions.chatOnce`.
- `whisper: "all"` leaves `whisper` undefined, so the message is public. That is intended.
- `{token}` and `{region}` are substituted in raw HTML. Token names are not escaped. That's fine for a GM-authored world, but noted here.

### 2.5 Register in `init` (`scripts/module.mjs`)

```js
import { ChatMessageRegionBehaviorType } from './chat-message-behavior.mjs';

Hooks.once('init', () => {
  CONFIG.RegionBehavior.dataModels['sons-of-set-regions.chatMessage'] =
    ChatMessageRegionBehaviorType;
  CONFIG.RegionBehavior.typeIcons['sons-of-set-regions.chatMessage'] = 'fa-solid fa-comment';
  // ...existing query registration...
});
```

### 2.6 Optional: `sons-of-set.chatOnceReset`

`{ sceneId, region?, behavior? }`. Clears `flags.sons-of-set-regions.chatOnce` on the scene's tokens, or only the key for the named behavior, so once-only cues fire again next session. If this is built, add it as a fifth forwarder (`chat-once-reset`). If it is skipped, the GM clears the flags by hand.

### 2.7 Payload shape

```json
{
  "name": "Chat: causeway",
  "type": "sons-of-set-regions.chatMessage",
  "disabled": false,
  "system": {
    "events": ["tokenTurnEnd"],
    "text": "Causeway shudders under {token} — DC 13 Dex if rubble was hurled this round.",
    "whisper": "all",
    "once": false,
    "flavor": "Sky Bastion"
  }
}
```

### 2.8 Bastion rollout (`bastion-regions.json`)

Keep scrolling text where a glance is enough: the climate regions and Rubble. Add `chatMessage` or swap to it where players must act on the text. Apply the changes with `region-update behaviorMode:"append"` (pairing) or `"merge"` (swapping).

| Region                | Text / event                                                                                                                                                                    | whisper | once |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---- |
| A-Causeway-Crumbling  | "Causeway shudders under {token} — DC 13 Dex if rubble was hurled this round." · `tokenTurnEnd`                                                                                 | all     | no   |
| A-Edge-Drop           | "{token} goes over the edge — 50 ft, 5d6, lands in the courtyard water." · `tokenMoveOut`                                                                                       | all     | no   |
| A-Horn / A-Winch      | fixture text · enter                                                                                                                                                            | gm      | no   |
| B-Sluice-Control      | "Sluice wheel — DC 15 Athletics to shift the courtyard water level."                                                                                                            | token   | no   |
| C-Water-Low / High    | swim text                                                                                                                                                                       | token   | yes  |
| C-Dock-Waterlogged    | "{token} steps onto the waterlogged dock — DC 12 Dex or it gives way." Replaces the `executeScript`. **This drops the Huge-size check.** Keep the script if that check matters. | gm      | no   |
| D-Unstable-Floor      | "Collapsed floor — DC 12 Dex for Medium or larger."                                                                                                                             | token   | yes  |
| D-Prisoners / C-Cargo | DM cue text                                                                                                                                                                     | gm      | yes  |

---

## 3. Part B — Wall tools (module handlers)

Reading already works through `scene-get` (relay) and `get-current-scene` (fork). Writing needs query handlers in the module, plus forwarders here.

### 3.1 Handlers

Add to the module's `handlers` and to `BRIDGE_QUERIES` as `sons-of-set.wallList`, `.wallCreate`, `.wallUpdate` and `.wallDelete`.

**Coordinate frames must match the region tools.** The delta draft multiplied by the grid size for `units:"grid"` but ignored `origin`. On a padded scene, grid coordinates then land offset by the padding, not on map squares. Reuse the module's existing units/origin conversion (the code region-create and note-create use) on each `x,y` pair of `c`:

```js
async wallList({ sceneId, units = "px", origin = "canvas" } = {}) {
  requireGM(); const s = resolveScene(sceneId);
  return { sceneId: s.id, grid: s.grid.size, sceneRect: /* as scene-info */,
           walls: s.walls.map(w => ({ ...w.toObject(), c: toCaller(w.c, s, units, origin) })) };
},
async wallCreate({ sceneId, units = "px", origin = "canvas", walls = [] } = {}) {
  requireGM(); const s = resolveScene(sceneId);
  const data = walls.map(w => ({ ...w, c: toCanvas(w.c, s, units, origin) }));
  const created = await s.createEmbeddedDocuments("Wall", data);
  return { sceneId: s.id, created: created.map(w => ({ id: w.id, c: w.c })) };
},
async wallUpdate({ sceneId, units = "px", origin = "canvas", walls = [] } = {}) {
  requireGM(); const s = resolveScene(sceneId);
  const data = walls.map(w => (w.c ? { ...w, c: toCanvas(w.c, s, units, origin) } : w)); // each needs _id
  const updated = await s.updateEmbeddedDocuments("Wall", data);
  return { sceneId: s.id, updated: updated.map(w => w.id) };
},
async wallDelete({ sceneId, ids = [], all = false } = {}) {
  requireGM(); const s = resolveScene(sceneId);
  const target = all ? s.walls.map(w => w.id) : ids;
  const deleted = await s.deleteEmbeddedDocuments("Wall", target);
  return { sceneId: s.id, deleted: deleted.map(w => w.id) };
}
```

`toCanvas`/`toCaller` stand for whatever the module already calls its conversion. Refuse an entry whose `c` is not four finite numbers, or a `wallUpdate` entry with no `_id`, and name the offending index in the error. That matches how the region handlers refuse bad input. Match `note-delete`: `all:true` must be explicit and an empty call deletes nothing.

### 3.2 Wall fields: verify against `CONST.WALL_*` on 14.365 before the first push

Expected values (v13/v14): `c: [x1,y1,x2,y2]` · `move` 0 none / 20 normal · `sight`, `light`, `sound` 0 none / 10 limited / 20 normal / 30 proximity / 40 reverse-proximity · `dir` 0 both / 1 left / 2 right · `door` 0 none / 1 door / 2 secret · `ds` 0 closed / 1 open / 2 locked · `threshold: {light, sight, sound, attenuation}`.

```js
({
  ...CONST.WALL_MOVEMENT_TYPES,
  ...CONST.WALL_SENSE_TYPES,
  dir: CONST.WALL_DIRECTIONS,
  door: CONST.WALL_DOOR_TYPES,
  ds: CONST.WALL_DOOR_STATES,
});
```

Also check that v14 Scene Levels do not add a required `levels` field on Wall. Regions gained one.

### 3.3 Bastion presets (grid units, `origin:"scene"`; re-fit after `scene-info`)

| Purpose                                                | Fields                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Invisible (causeway edges, dock edges, sluice banks)   | `move:20, sight:0, light:0, sound:0`                                                             |
| Terrain / half-cover (cargo crates, waterfall curtain) | `move:20, sight:10, light:10, sound:20`. Use `move:0` on crates if giants should step over them. |
| Door (gate, portcullis, cell)                          | `door:1, ds:2`                                                                                   |
| Secret door (collapsed D gaps)                         | `door:2, ds:0`                                                                                   |
| One-way (cell bars)                                    | `sight:20, dir:1` or `dir:2`. Test which side is "left" on the drawn segment.                    |

---

## 4. Part B — Forwarders (this repo)

### 4.1 `TOOL_QUERIES`

Add to `packages/mcp-server/src/tools/sons-of-set-regions.ts`. Keep this table a literal copy of the module's `BRIDGE_QUERIES`:

```ts
'wall-list': 'wallList',
'wall-create': 'wallCreate',
'wall-update': 'wallUpdate',
'wall-delete': 'wallDelete',
```

### 4.2 Tool definitions

Reuse `SCENE_ID`, `UNITS` and `ORIGIN`. Add a `WALL_SCHEMA` with `c` (array of 4 numbers, required on create), `move`, `sight`, `light`, `sound`, `dir`, `door`, `ds` (numbers, with the verified constants in each description), `threshold` (object, passthrough) and `flags`. Set `additionalProperties: true` so v14 fields pass through, as in `BEHAVIOR_SCHEMA`. `wall-update` entries require `_id`. `wall-delete` takes `ids` and `all`. Put the §3.3 presets in the `wall-create` description; that is where the model will look.

No change to `handleToolCall` or `backend.ts`. The tools are already spread from `getToolDefinitions()`, and routing is table-driven. Confirm this in `backend.ts` before assuming.

### 4.3 `BEHAVIOR_SCHEMA` description

Add `sons-of-set-regions.chatMessage` (system: `events`, `text`, `whisper` gm|token|all, `once`, `flavor`; `{token}`/`{region}` substituted) to the list of known types.

### 4.4 Tests

Extend `sons-of-set-regions.test.ts`: each new tool forwards to `sons-of-set.<query>` with args unchanged, and module errors pass through unwrapped. Match the existing cases.

---

## 5. Acceptance

- The `chatMessage` behavior appears in `scene-info schema:true` with the fields above, and its config sheet renders in the Region UI.
- Walking a token into a test region posts **one** message (not one per GM tab), whispered as configured, with `{token}`/`{region}` substituted. With `once:true` it does not fire again after a page reload.
- `wall-create` with `units:"grid", origin:"scene"` puts a wall exactly on a map grid line of a padded scene. `wall-list` with the same frame returns the same numbers.
- `wall-update` changes `ds` on a door. `wall-delete` removes by id and refuses an empty call.
- Verified on a **Forge** world (14.365), not just local.

Build loop: `npm run build:server`, then Cmd+Q Claude, relaunch it, and reload the Foundry tab (see `CHAT_HANDLER_SPEC.md` §6). The module side needs its own release/installation on the Forge before the forwarders have anything to call.

---

## 6. Operational note — relay connection

The chat side cannot reconnect the relay. The module dials out; nothing on Anthropic's end starts a connection. Suppose the Forge world is open with a GM seat and the relay still says "last connected N hours ago". Then that tab is on **WebSocket (Local Only)** and talking to this local fork. The last relay connection came from a different tab or setting. Check **Foundry MCP Bridge → Connection Type** in that tab: only Auto or WebRTC reach `foundry-mcp.com`.
