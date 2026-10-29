<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Git: the owner commits (applies to every AI agent: Claude Code, Cursor, others)

- **Never run `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, `git stash` or `git tag`.** Vansh (the owner) does all commits, merges and pushes himself.
- You may run read-only git commands (`status`, `diff`, `log`, `show`, `branch`) and `git switch -c` only when a plan tells you to create a branch.
- When a step is done: leave the changes uncommitted, run the checks, and end with a short **"Ready to commit"** list: the files changed and a suggested commit message (for example `feat(email): … [R1.4]`). Then stop and wait.
- Where a plan says "commit", read it as "prepare for the owner's commit" as above. Record "awaiting owner commit" in progress files instead of a commit hash.
