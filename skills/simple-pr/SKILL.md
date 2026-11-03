---
name: simple-pr
description: Bitbucket PR creation and lookup with the `simple-pr` CLI, from a Jira key or branch name. Use before the Bitbucket API or a browser when asked to open or find a Bitbucket PR ("PR 날려줘", "dev에 PR 만들어줘", "PROJ-123 PR 찾아줘"). Not for GitHub.
---

# simple-pr

`simple-pr --help`, `simple-pr bitbucket find --help`, and `simple-pr bitbucket create --help` are the reference for matching rules, title rules, output, and exit status.

## Open a PR

1. Push the source branch. Bitbucket sees pushed branches only.
2. Set the repository. The configured default may be another repository, so prefix every command with `BITBUCKET_REPO_SLUG=<repo>`, taking `<repo>` from `git remote get-url origin`.
3. Check for an existing PR: `simple-pr bitbucket find --from <branch> --all`. Each line ends with its state and destination branch. Skip creation when an OPEN PR already targets the destination.
4. Preview: `simple-pr bitbucket create --from <branch> --to <branch> --dry-run`. Done when the printed source branch, destination branch, and title all match the request. Matching is by keyword, so pass full branch names when you know them. Add `--title "<title>"` when the generated title does not describe the change.
5. Run the same command without `--dry-run`. Done when it exits 0 and prints the PR link.

## Find a PR

Run `simple-pr bitbucket find --from <key-or-branch>`. Add `--all` for every match and `--to <text>` to filter by destination. Only branch names are searched, so a key that appears only in commit messages will not match.

## Failures

- `command not found`: report it. The install is `just install` in a checkout of https://github.com/rjcnd105/hj-agent-tools, on macOS arm64.
- `Env <NAME> missing`: report the variable name. Credentials live in `~/.config/simple-pr/.env`. Never print or read that file.
