# Agent protocol: Claude Code (brain) + Cursor (worker)

This protocol lets two AI agents work on one codebase without stepping on each other. It applies to V3 and later. The owner (Vansh) can always override it.

## 1. Roles

| | Claude Code: **brain / lead** | Cursor: **worker** |
|---|---|---|
| Owns | Architecture, contracts, engine (`src/lib/engine/**`, `src/lib/contracts/**`), worker (`worker/**`), database (`supabase/**`), scripts and eval (`scripts/**`), API routes (`src/app/api/**`), security, merges | UI pages and components (`src/app/**/page.tsx` except protected files, `src/components/**`, styles), UI tests, small well-specified tasks Claude assigns |
| Does | Plans phases, writes task specs, builds engine-critical code, reviews every Cursor change, runs all gates, tells the owner what is ready to commit/merge | Implements exactly the task spec, runs the task's checks, writes a report, never merges |
| Never | Lets a task go unreviewed; edits files locked by an open Cursor task | Edits files outside its task's allow-list; changes contracts, API routes, migrations, engine or protected files; merges; pushes |

Protected for both, always:

- `src/app/tracked/page.tsx`
- `src/app/api/track/route.ts`
- `src/lib/db/products.ts`
- `.env*`
- `.github/`

## 2. How the agents talk (files in the repo)

```
docs/agents/
  BOARD.md          # one table: every task, owner, status, branch, locked files
  LOG.md            # append-only, one line per event (who, when, what)
  CONTRACTS.md      # human summary of src/lib/contracts/*.ts (types are the source of truth)
  tasks/T-001.md    # one file per task (template below)
```

- **Claude → Cursor:** a task file plus a row on `BOARD.md` (status `ready`).
- **Cursor → Claude:** the "Worker report" section of the same task file (status `review`).
- **Claude → Cursor (changes needed):** the "Review" section (status `changes`).
- **Done:** Claude merges and sets the status to `done`.
- Questions either way go in the task file under "Questions", and the task is set to `blocked`. Nobody guesses on a contract question.

### Task file template (`docs/agents/tasks/T-###.md`)

```markdown
# T-### <title>
Status: ready | in-progress | review | changes | blocked | done
Owner: cursor | claude
Branch: v3/ui-T###      Base: v3/integration @ <commit>
Requirement IDs: S3.3, S7

## Goal (one paragraph, user-visible outcome)

## Context to read first (files, contracts, screenshots)

## Allowed files (lock list; edit nothing else)
- src/components/search/Autocomplete.tsx (new)
- src/app/search/page.tsx

## Contract (types/endpoints to use; do not change them)
- GET /api/search/suggest?q= → SuggestResponse (src/lib/contracts/search.ts)

## Requirements (numbered, testable)

## Acceptance checks (exact commands + manual steps)
- npx tsc --noEmit ; npm run lint ; npx next build ; npm test -- <file>
- Manual: 375 px and 1280 px, keyboard only, dark mode

## Out of scope

## Questions (worker writes; set Status: blocked)

## Worker report (worker fills)
- What changed (files), screenshots/notes, checks run with results, known gaps

## Review (Claude fills)
- Verdict: approve | changes (numbered list)
```

## 3. Branches and folders (no clashes)

- `v3/integration` is the only branch Claude merges into. It is created from `feat/client-ready` once V2 is done.
- Claude works in `D:\luggage-watch-main` on `v3/engine-*` branches.
- **Cursor works in a separate git worktree** so both can run at the same time. Claude sets it up in V3-0:

  ```
  git worktree add ../luggage-watch-ui v3/integration
  ```

  Open `D:\luggage-watch-ui` in Cursor. For each task: `git switch -c v3/ui-T### v3/integration`.
- A file listed under "Allowed files" of a task in `in-progress` / `review` / `changes` is **locked** to that task's owner. Claude checks `BOARD.md` before editing any UI file.
- **Only the owner commits, merges and pushes.** After Claude approves a task, it tells the owner: "T-### approved: commit these files on v3/ui-T### with message …, then merge into v3/integration". No agent runs `git commit/merge/push`. No force-push and no history rewrite, ever (the Lovable-connected repo).

## 4. Two ways to hand a task to Cursor

**A. Automatic (Claude runs Cursor's CLI).** Requires the owner to install the Cursor CLI and set `CURSOR_API_KEY` in the shell environment (never in a file). Claude runs, in the worktree:

```
agent -p --force --output-format json "Read docs/agents/tasks/T-###.md and AGENTS.md. Do exactly that task on branch v3/ui-T###. Edit only the allowed files. Run the acceptance checks. Fill the Worker report. Set Status: review. Do not commit; leave changes for the owner."
```

Then Claude reads the report, reviews the diff and runs the checks itself. If the CLI isn't available, use B.

**B. Manual (the owner relays).**
1. Claude prints a one-line prompt.
2. The owner pastes it into Cursor's Agent chat (in the `luggage-watch-ui` window).
3. When Cursor finishes, the owner tells Claude "T-### ready for review".

## 5. Review checklist (Claude, for every Cursor task)

1. The diff touches only the allowed files.
2. The contracts are unchanged.
3. There's no mock or placeholder data, and no button that does nothing.
4. There are no graphs or charts. Every price shows its label and time, and the UI uses plain English.
5. It works at 375 px and 1280 px, by keyboard only, with focus rings, `aria-live` for streaming and AA contrast.
6. Loading, empty and error states are present.
7. `tsc`, `lint`, `build` and the related tests pass when Claude runs them, not only when Cursor says so.
8. A short manual run on the dev DB (real indexed data).

Verdict goes in the task file. At most 3 review rounds; after that Claude finishes the task itself.

## 6. Task sizing for Cursor

- **One screen or one component family per task.** About ½–2 hours of human-equivalent work.
- The contract and data must already exist on `v3/integration` before the task is `ready`. Cursor never waits on an unbuilt API.
- **UI work goes to Cursor:** autocomplete UI, filter chips, answer card, suggestions sections, quick-check page, Store status tables, responsive polish, accessibility fixes, UI tests.
- **Claude keeps:**
  - parser, matcher, ranking, scraper, adapters, scheduler;
  - migrations, security, eval;
  - anything that decides which price is shown;
  - anything touching money or limits;
  - every merge.

## 7. Cursor's standing rules

These live in `.cursor/rules/`, copied from `planning/v3/cursor-rules/` in V3-0. Cursor also reads `AGENTS.md`.
