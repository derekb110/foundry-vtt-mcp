# Issue tracker: GitHub

Tickets for this repo live as GitHub issues on the fork, **`derekb110/foundry-vtt-mcp`**. Use the `gh` CLI for all operations. Specs stay in the repo as `docs/specs/<TOPIC>_SPEC.md`, and each ticket's body links back to its spec.

**Always target the fork, never upstream.** `upstream` is Adam Dooley's `adambdooley/foundry-vtt-mcp`, and `gh` on a fork can fall back to the parent. `gh repo set-default derekb110/foundry-vtt-mcp` is set in this clone; pass `-R derekb110/foundry-vtt-mcp` anyway when running from anywhere else. When an issue body mentions an upstream issue or PR, write it as `adambdooley/foundry-vtt-mcp#N`. A bare `#N` links to the fork.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc or `--body-file -` for multi-line bodies. Start the body with `Spec: \`docs/specs/<TOPIC>\_SPEC.md\` §N`.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

For a spec, create or update `docs/specs/<TOPIC>_SPEC.md` in the repo. For a ticket, create a GitHub issue on the fork.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. Example: the chat handler effort, map #6 with children #7–#12.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api --method POST repos/derekb110/foundry-vtt-mcp/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`), with `Part of #<map>` at the top of the body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/derekb110/foundry-vtt-mcp/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/derekb110/foundry-vtt-mcp/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open sub-issues (`gh api repos/derekb110/foundry-vtt-mcp/issues/<map>/sub_issues`), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
