# hj-agent-tools

Self-made CLI tools, and the skills that teach agents to use them. Works in Claude Code, Codex, Pi, Cursor, Gemini CLI, and OpenCode on macOS arm64.

External skills and agent settings stay in the dotfiles repository. This plugin holds only tools built here.

## Layout

- `tools/<name>/` is a `git subtree` copy of the tool's own repository. Edit the tool there and pull it here. Never edit it in this repository.
- `external/<kind>/<name>/` holds tools that run inside another app, grouped by host, such as `external/chrome-extensions/`. They have no upstream and live here.
- `skills/<name>/SKILL.md` tells agents when and how to use the tool.

## Commands

Requires `just`, `jj`, `cargo`, and `bun`.

- `just install` builds the tools into `~/.local/bin` and registers the plugin with every agent.
- `just update` pulls the published plugin into every agent and rebuilds the tools.
- `just tool-pull simple-pr` pulls the tool's upstream changes. Then push and run `just update`.
- `just e2e-ego-recorder` exercises ego-recorder in the running ego lite against a local mock shop.

ego-recorder needs one manual step, because the browser reserves it for the user. In ego lite, turn on developer mode at `chrome://extensions` and load `external/chrome-extensions/ego-recorder/extension/dist` as an unpacked extension.

Credentials stay outside this repository, in `~/.config/simple-pr/.env`.

## Add a tool

1. `git subtree add --prefix=tools/<name> --squash <url> main`
2. Add `skills/<name>/SKILL.md`.
3. Add its URL to `tool-pull` and its build step to `build` in the `justfile`.
