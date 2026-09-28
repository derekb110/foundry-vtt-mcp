# Spec — Chat read + session extraction

_For Claude Code. Written 2026-09-13 in the session that got self-hosting working. Feed this into the planning phase before writing code._

---

## 1. Context and boundaries

**The goal:** "Extract what happened in a session and push it to a journal." The journal half already works. The input half is blind — there are no chat tools and no chat query handler anywhere in the stack.

**The stack, as of today:**

- `~/foundry-vtt-mcp` — fork of `adambdooley/foundry-vtt-mcp`. Branch `feat/quest-tracker-tools`, merged to upstream **v0.8.4**, pushed. `master` is a pristine upstream mirror; the fork is 4 commits on top.
- The MCP server is registered with the Claude desktop app and runs locally. The Foundry module dials **out** to `ws://localhost:31415`.
- Worlds on the Forge run **dnd5e 5.3.3 / Foundry 14.365**. Local `tester` runs **6.0.1 / 14.367** — _not_ a valid stand-in for system-sensitive behaviour.

**Out of scope.** Combat automation, dice rolling, effects, roll tables, world time, table control. Deliberately declined — this stack is an authoring tool, not a table-running tool. Do not add them.

---

## 2. The architecture constraint — read this before designing anything

The bridge module relays **any** query name to `CONFIG.queries[name]`. It does **not** restrict to its own namespace. This is why the six quest/faction tools work with zero changes to the bridge module — `quest-tracker` registers its own handlers and the server just forwards.

The bridge module's `packages/foundry-module/src/queries.ts` registers a **fixed, hand-written** set of handlers: characters, actors, compendium, journals, ownership, player rolls, scenes. **There is no chat handler.** A server-side tool alone therefore cannot reach chat — there is nothing on the other end to forward to.

**Do NOT add the handler to the bridge module.** That means building and shipping a forked _module_ into every world including the Forge, and maintaining it against upstream. ADR-0005 deliberately kept this fork **server-side only**, and that decision is what made today's v0.8.4 merge cost zero conflicts. Preserve it.

**Instead: register the handler from a Foundry module Derek controls.** Put it in a small new module rather than `quest-tracker` — chat reading is not quest tracking, and `quest-tracker` should stay coherent. The module needs to do nothing but register query handlers.

Mirror `packages/mcp-server/src/tools/quest-tracker.ts` for the server side. It is the reference implementation: a `QUERY_PREFIX`, a tool-name → query-name table, and a `forward()` that calls `foundryClient.query(...)`. Roughly 40 lines of real logic.

---

## 3. Phase 1 — chat read

Independently shippable. Done when Claude can read a session's messages out of a live world.

### 3.1 Verify the data shape FIRST

Do not trust the field names below. Foundry v12–v14 renamed several `ChatMessage` fields, and 0.8.4 had to repair scene backgrounds because **v14 moved them off `Scene` onto a `Level` document**. Assume nothing.

Run this in the GM browser console of a world with real messages, and design against what it actually prints:

```js
const m = game.messages.contents.at(-1);
console.log({
  keys: Object.keys(m),
  author: m.author?.name ?? m.user?.name,
  speaker: m.speaker,
  timestamp: m.timestamp,
  whisper: m.whisper,
  blind: m.blind,
  style: m.style ?? m.type,
  rolls: m.rolls?.length,
  content: m.content?.slice(0, 200),
});
```

Known migration points to handle defensively: `user` → `author`, `type` → `style` (and `CONST.CHAT_MESSAGE_TYPES` → `CHAT_MESSAGE_STYLES`).

### 3.2 The Foundry handler

Register `CONFIG.queries['<ns>.listChatMessages']`.

Arguments:

| Arg               | Purpose                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `since` / `until` | epoch ms window. The primary selector — a session is a time range.                          |
| `limit`, `cursor` | pagination. A long session is thousands of messages; do not return them all in one payload. |
| `includeWhispers` | default **false**.                                                                          |
| `includeRolls`    | default **false**. Roll messages are mostly noise for a recap and expensive in tokens.      |

Returns per message: id, timestamp, author name, speaker alias, content as **plain text** (strip HTML — enrichers produce heavy markup), whisper flag, roll flag.

**Strip HTML in the handler, inside Foundry, not on the server.** Foundry has the document and the enrichers; the server has a string. Raw `content` on a busy message can be several kilobytes of markup for one line of speech.

### 3.3 The server forwarder

`chat-list` in a new `packages/mcp-server/src/tools/chat.ts`, wired into `backend.ts` at the same four insertion points the quest tools use: import, instantiation, tool-definitions spread, `case` block. Keep the diff to those four places — that shape is why upstream merges cleanly.

### 3.4 Acceptance

- `chat-list` with a time window returns the messages from that window, in order, as readable text.
- Whispers excluded unless asked for.
- A session's worth of messages paginates without a timeout.
- Verified against a **Forge** world, not just local — the Forge is the real target and runs a different system version.

---

## 4. Phase 2 — session extraction to journal

Consumes phase 1. No new Foundry handlers.

Read a session's messages, produce a recap, write it through the journal tools that already exist (`create-quest-journal`, `update-quest-journal`, `replace-journal-page`, `list-journals`, `search-journals`).

Design questions to settle in planning, not in code:

- Where does a recap live — the party journal, a per-session entry, or appended to a standing page? Campaign convention already exists: _"Where We Stand"_ is rewritten after each session rather than replaced with a new per-session journal.
- Does the recap get written automatically or proposed for review first? Given campaign canon is involved, default to **proposed**.
- How is a "session" delimited? Wall-clock window is simplest and probably sufficient.

---

## 5. Side fix — error passthrough

Small, do it early, it will save time during the build.

For an identical disconnected state, `get-world-info` returns a precise _"Foundry VTT module not connected"_ while `quest-list` returns a generic _"⚙️ An unexpected error occurred"_. `tools/quest-tracker.ts` catches the underlying error and re-wraps it, losing the cause. This cost real debugging time today — it looked like the v0.8.4 merge had broken the quest tools when the connection was simply down.

Let the underlying error through. Apply the same rule to the new chat tool from the start.

---

## 6. Build and test loop

```
npm run build:server        # tsc; no install needed unless deps changed
```

Then **quit Claude fully (Cmd+Q), relaunch, and reload the Foundry browser tab.**

That last step is not optional and is the single most common source of confusion:

1. The server is the **listener**; the Foundry module is the **dialer**. Restart the server and the module must be told — its 30s auto-reconnect heartbeat does not reliably notice a half-open socket.
2. Trust the Foundry notification **"🔗 MCP Bridge connected successfully"**. Do **not** trust the console's `State: connected` — that is just `ws.onopen` and fires even when the server never registered the client.
3. If tool calls return _"module not connected"_ while `lsof -i :31415` shows an ESTABLISHED connection, there are **two `index.js` clients sharing one backend**. Fix:
   ```
   pkill -f 'foundry-vtt-mcp/packages/mcp-server'
   lsof -i :31415 -n -P        # must print nothing
   ```
   then relaunch and reload. Upstream added a fix for this (`5adb581`) and **reverted it** (`fcf6b6f`) before 0.8.4 — it is not fixed in the version you are on.

---

## 7. Upstream merges

```
git fetch upstream --tags
git checkout master && git merge --ff-only v0.8.x && git push origin master
git checkout feat/quest-tracker-tools && git merge v0.8.x
npm run build:server
```

v0.8.4 merged with zero conflicts and no new dependencies. Keep the fork server-side only and additive at known insertion points and it stays that cheap.

---

## 8. Worth considering

ADR-0005: _"A generic 'call a module query' tool is the natural upstream contribution that would remove the fork entirely."_

If a `foundry-query` tool taking an arbitrary query name existed upstream, neither the quest tools nor this chat tool would need a server fork at all — only the Foundry-side handlers, which live in Derek's own modules anyway. Before building `chat-list` as a bespoke tool, consider whether building the generic tool instead is the same work with a better ending.
