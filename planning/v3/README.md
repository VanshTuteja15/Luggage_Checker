# planning/v3: next goal (start after V2 is done)

| File | What it is |
|---|---|
| `MASTER_PROMPT_V3.md` | The plan for Claude Code (brain): our own luggage search engine, AI search, better scraper |
| `AGENT_PROTOCOL.md` | How Claude Code and Cursor share the work without conflicts |
| `cursor-rules/luggagetracker-worker.mdc` | Cursor's standing rules; Claude copies it into `.cursor/rules/` in phase V3-0 |

## How to start (after `docs/PROGRESS_V2.md` shows Q0–Q10 done)

**1. One-time setup by you:**

- Write 30 real customer questions about luggage in `planning/v3/owner-queries.txt`, one per line. The parser is tested against them.
- Optional, for automatic hand-off to Cursor:
  - install the Cursor CLI in PowerShell with `irm 'https://cursor.com/install?win32=true' | iex`;
  - create an API key in Cursor's settings;
  - set it for your user with `setx CURSOR_API_KEY "<key>"`, then open a new terminal. Never put it in a file.

**2. In Claude Code** (in `D:\luggage-watch-main`):

```
/goal Read planning/v3/MASTER_PROMPT_V3.md and follow it. Resume from docs/PROGRESS_V3.md if it exists.
```

**3. In Cursor** (open `D:\luggage-watch-ui` once Claude has created it), when Claude hands you a task:

```
Read docs/agents/tasks/T-###.md and AGENTS.md. Do exactly that task. Edit only the allowed files. Run the acceptance checks, fill the Worker report, set Status: review. Don't commit: I'll commit myself.
```
