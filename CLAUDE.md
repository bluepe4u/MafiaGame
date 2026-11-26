# Anytable — notes for agents

The README describes the app (games, deploy, storage, structure). Run `npm test` (Node's built-in
runner, no build step) before you commit. The code needs Node 22.5+ (`node:sqlite`).

## Tasks for the owner and the project

The owner keeps one task list. When your work turns up something that should outlive your session,
record it there instead of leaving it only in your final message:

- **Owner** tasks: things only the owner can do — a decision, a key or account, a payment, a DNS or
  server change, a manual check on a device, merging or deleting branches.
- **Project** tasks: real follow-up work you found but didn't do (a bug, an outdated or vulnerable
  dependency, an expired TODO, a missing test).

Not for: what you're about to do anyway, what you finished, guesses, or one-line nits.

### Where to record them

1. **TaskHub** — if the `mcp__taskhub__*` tools are available (the owner's Mac), use them:
   - First `list_tasks` with `repo: "bluepe4u/MafiaGame"` (and a `query`) so you don't add a
     duplicate; update the existing task instead.
   - `add_task` with `project: "Dev"`, `repo: "bluepe4u/MafiaGame"`, `status: "inbox"`, a `branch`
     when it's tied to one, and `priority` 3 high / 2 medium / 1 low.
   - Title: a short imperative ("Upgrade nodemailer to 10.x"). Notes start with `Owner:` or
     `Project:`, then why it matters, where (file:line, command), and what "done" looks like. Use a
     `checklist` for steps. Write dates as absolute dates.
   - When you finish a task that's on the list, `complete_tasks` it.
2. **GitHub issues** — anywhere else (another machine, a cloud session, CI), when the TaskHub
   tools aren't there. Use `gh` on `bluepe4u/MafiaGame`:
   - Search first: `gh issue list -R bluepe4u/MafiaGame --search "<words>" --state open`; comment
     on an existing issue rather than opening a second one.
   - `gh issue create -R bluepe4u/MafiaGame --title "<imperative>" --label <owner|project>
     [--label bug|enhancement|security]`, body in the same shape as the TaskHub notes, ending with
     `Found by an agent on <machine/session>, <YYYY-MM-DD>.`
   - Close the issue (`gh issue close <n> -c "<what fixed it>"`) when your change fixes it, or put
     `Fixes #<n>` in the PR.
   - On the owner's Mac, open GitHub issues for open project tasks too only if asked; TaskHub is
     the list there.

**The repository is public.** Issues are visible to anyone: never put secrets, keys, server
addresses beyond the public domain, personal data, or exploitable detail of an unfixed
vulnerability in one. For a security problem write a vague issue ("Upgrade a vulnerable
dependency") or, if it's serious, leave it for the owner in your final message. TaskHub is private.

Be respectful of the owner's time: one task per thing, written so it can be acted on without
re-reading your session; no nagging duplicates; don't escalate priorities to get attention.
