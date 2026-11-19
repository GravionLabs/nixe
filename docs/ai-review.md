# Reviewing changes of an agent

Nixe is the inbox for changes that an agent (for example Claude Code) makes in your vault. The agent
never writes to the branch you work on. It works on its own branch, and Nixe lists that branch until
you have merged it.

## Convention

- **Branch prefix.** The agent names every branch with the prefix `claude/`, for example
  `claude/tidy-inbox`. Nixe lists the local and the remote branches with this prefix that are ahead of
  the branch you have checked out. Change the prefix in Settings > Git (*Review branch prefix*); an
  empty prefix turns the review off.
- **One topic per branch.** One branch holds one piece of work (clean up the inbox, add tags to the
  reading notes). You review and merge it as a whole, so a small branch is easy to judge.
- **Small commits with a clear message.** Nixe shows the commit messages of the branch next to its
  author and date.
- **Push the branch.** On another device the branch arrives with the next sync (it fetches `origin`);
  the status bar then shows `n branches to review`.

## In Nixe

1. The status bar shows the number of branches waiting. A click opens the Git view.
2. The *Review* section lists each branch with its author, date, commit messages and the number of
   changed notes.
3. Opening a branch lists its notes. The changes are measured against the merge base, so what you
   changed on your own branch in the meantime does not show up as a change of the agent.
4. A note shows the line diff (*Source*) or both versions side by side (*Rendered*).
5. To accept the work, merge the branch with Git (`git merge claude/tidy-inbox`, or a pull request).
   Once it is merged, or deleted, it is no longer ahead and leaves the list.

## Snippet for `CLAUDE.md` of the vault

```markdown
## Working in this vault

- Never commit to the branch the user works on. Create a branch named `claude/<topic>` for your work
  (`git switch -c claude/<topic>`) and commit there.
- One topic per branch. Start a new branch for an unrelated change.
- Commit small steps with a message that says what changed and why.
- Push the branch (`git push -u origin claude/<topic>`) when you are done. Do not merge it; the user
  reviews the notes in Nixe and merges.
- Do not delete or rename notes unless the task says so.
```
