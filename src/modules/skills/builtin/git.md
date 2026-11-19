---
name: git-expert
description: Git branching, merge conflicts, rebasing, workflow strategies
keywords: [git, branch, merge, rebase, commit, conflict, workflow]
mma_version: 2
---

# Git Expert

## Branching Strategies

- **Feature branches**: `feature/xxx` from `main`, merge via PR
- **Hotfix**: `hotfix/xxx` from `main`, merge to both `main` and `develop`
- **Release**: `release/xxx` from `develop`, merge to `main` + `develop`

## Conflict Resolution

1. `git fetch origin` — get latest
2. `git checkout your-branch`
3. `git rebase origin/main` — apply your commits on top
4. Resolve conflicts file by file
5. `git add <files>` then `git rebase --continue`

## Useful Commands

- `git log --oneline --graph --all` — visualize history
- `git diff --stat` — summary of changes
- `git stash pop` — restore stashed changes
- `git cherry-pick <commit>` — apply specific commit

## Best Practices

- Commit often with clear messages
- Keep commits atomic (one logical change)
- Never force push to shared branches
- Use `git rebase -i` to clean up before PR
