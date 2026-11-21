# hj-agent-tools

Self-made CLI tools, and the skills that teach agents to use them. Works in Claude Code, Codex, Pi, Cursor, Gemini CLI, and OpenCode on macOS arm64.

External skills and agent settings stay in the dotfiles repository. This plugin holds only tools built here.

## Layout

- `tools/<name>/` is a `git subtree` copy of the tool's own repository. Edit the tool there and pull it here. Never edit it in this repository.
- `herdr/<mod>/` holds personal Herdr mods (`hj-agents`, `hj-changes`, `hj-files`, `hj-menu`, `hj-pane`, `hj-tabs`, `hj-team`) and `herdr/lib/mod-config.js` holds the shared per-mod config resolver.
- `external/<kind>/<name>/` holds tools that run inside another app, grouped by host, such as `external/chrome-extensions/` and `external/obsidian-plugins/`. They have no upstream and live here.
- `skills/<name>/SKILL.md` tells agents when and how to use the tool.
- `skills/<name>/scripts/` holds a dependency-free script that the skill runs in place, with no build or install step, such as `skills/input-replay/scripts/replay.mjs`.

## Commands

Requires `just`, `jj`, `cargo`, `bun`, and `node` (22+).

- `just install` builds the tools into `~/.local/bin` and registers the plugin with every agent.
- `just update` pulls the published plugin into every agent and rebuilds the tools.
- `just tool-pull simple-pr` pulls the tool's upstream changes. Then push and run `just update`.
- `just e2e-ego-recorder` exercises ego-recorder in the running ego lite against a local mock shop.
- `just herdr-mods` copies `herdr/hj-*/` (and `herdr/lib/mod-config.js`) into the Herdr app's home. `just install` runs it too.
- `just hc-team` links `~/.local/bin/hc-team` to `skills/hc-team/scripts/hc-team.mjs` and seeds missing presets from `presets/` into `$HERDR_MOD_HJ_TEAM_DIR` (or `$HC_TEAM_PRESETS_DIR`, defaulting to `~/.herdr/hj-team`). `just install` runs it too.

ego-recorder needs one manual step, because the browser reserves it for the user. In ego lite, turn on developer mode at `chrome://extensions` and load `external/chrome-extensions/ego-recorder/extension/dist` as an unpacked extension.

voice-context deploys into an Obsidian vault. In `external/obsidian-plugins/voice-context`, run `bun install`, then `VAULT=<vault path> bun run deploy`.

The Herdr mods show up once a layout names them. Each personal mod reads its config directory from `~/.herdr/<mod_name>/` by default and can be overridden individually with `HERDR_MOD_<NAME>_DIR` (e.g. `HERDR_MOD_HJ_MENU_DIR`, `HERDR_MOD_HJ_TEAM_DIR`). In `~/.config/herdr-app/layouts/<layout>.json`, a personal layout:

- `hj-pane` (`HERDR_MOD_HJ_PANE_DIR`, `~/.herdr/hj-pane/config.json`) as the pane header, in the block with `"tab": "active"`: `"pane": { "header": { "content": { "mod": "hj-pane" } }, "gap": 0, "radius": 0, "border": { "width": 0, "color": "border" }, "focus": { "width": 0, "color": "border" }, "lone": true }`. It shows each terminal's `hc` address. With that `border` and `focus` of no width, it draws one-pixel dividers between panes. Sub-agents that sit together share one blue frame that changes shade on focus; other panes get a quiet gray focus frame. Set `"terminal_padding": [2, 4]` at the layout root and no `padding` or `gap` around the tab block for panes that touch.
- `hj-tabs` (`HERDR_MOD_HJ_TABS_DIR`, `~/.herdr/hj-tabs/config.json`) in place of `tabs`, plus a second row below the tab bar: `{ "id": "hj-subtabs", "type": "block", "hidden": true, "size": { "px": 34 }, "content": { "mod": "hj-tabs", "props": { "row": "sub" } } }`. Every live sub-agent on this computer gets a pane in a sub-tab of its parent's tab, two side by side in each; the second row lists those sub-tabs after a fixed `super`. `herdr-app do terminal.park '{"terminal":"<t>"}'` takes one back out for good. When `panel-body` includes `teams`, `hj-tabs` also adds a `Teams` toggle beside `Files` and `Changes`.
- `hj-agents` (`HERDR_MOD_HJ_AGENTS_DIR`, `~/.herdr/hj-agents/config.json`) in place of `agents`. A click on a sub-agent focuses its pane (or peeks if parked). It polls `hc-team servers --json` to show live dev server URLs under each parent agent and sub-session. Add `{ "id": "servers", "type": "block", "hidden": true, "size": { "px": 30 }, "content": { "mod": "hj-agents", "props": { "view": "servers" } } }` after `agents` in `sidebar-lists` to show standalone shell and detached servers outside the Agents list.
- `hj-files` (`HERDR_MOD_HJ_FILES_DIR`, `~/.herdr/hj-files/config.json`) in place of `files` inside `panel-body.children`. Adds right-click `Open With ›` support for local files and folders via `hj-menu`.
- `hj-changes` (`HERDR_MOD_HJ_CHANGES_DIR`, `~/.herdr/hj-changes/config.json`) in place of `changes` inside `panel-body.children`. Tracks active Claude subagent worktrees and adds right-click `Open With ›` via `hj-menu`.
- `hj-team` (`HERDR_MOD_HJ_TEAM_DIR`, fallback `HC_TEAM_PRESETS_DIR`, `~/.herdr/hj-team/` presets + `_routes.json` + `_models.md` + `_config.json`) as a right-side panel child inside `panel-body.children`: `{ "id": "teams", "type": "block", "content": { "mod": "hj-team" } }`. It browses/edits JSON presets and `_routes.json` model routing, scaffolds project `docs/agent-presets/<id>/` overlays, launches multi-harness (`claude`, `codex`, `pi`, `agy`) sub-session squads, and monitors active runs live from `hc` labels.
- `hj-menu` (`HERDR_MOD_HJ_MENU_DIR`, `~/.herdr/hj-menu/editors.json`) is the shared `Open With ›` context menu for local files in the personal `Changes` and `Files` panels and local folders in `Files` on macOS. Its last item, `Config`, creates or opens `editors.json` in the resolved config directory in the default text editor. The top-level `editors` array lists `{ "label", "bundle" }` entries in menu order. Changes apply the next time you right-click and open the submenu; a missing or invalid file uses the Zed Preview and Cursor defaults.

Sub-session placement uses each terminal's `parent`, so it works regardless of how the terminal was started. The replacements for Herdr's bundled mods are based on herdr-app 0.1.16 and do not follow app updates.

Credentials stay outside this repository, in `~/.config/simple-pr/.env`.

## Add a tool

1. `git subtree add --prefix=tools/<name> --squash <url> main`
2. Add `skills/<name>/SKILL.md`.
3. Add its URL to `tool-pull` and its build step to `build` in the `justfile`.
