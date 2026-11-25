# hj-agent-tools

Self-made CLI tools, and the skills that teach agents to use them. Works in Claude Code, Codex, Pi, Cursor, Gemini CLI, and OpenCode on macOS arm64.

External skills and agent settings stay in the dotfiles repository. This plugin holds only tools built here.

## Layout

- `tools/<name>/` is a `git subtree` copy of the tool's own repository. Edit the tool there and pull it here. Never edit it in this repository.
- `crates/<name>/` holds self-contained Rust CLI tools that live directly in this repository, such as `crates/last30/`.
- `herdr/<mod>/` holds personal Herdr mods (`hj-agents`, `hj-changes`, `hj-files`, `hj-menu`, `hj-pane`, `hj-review`, `hj-tabs`, `hj-team`). `herdr/lib/mod-config.js` holds the shared per-mod config resolver, and `herdr/lib/shown.js` tells a mod whether its layout block is on screen.
- `external/<kind>/<name>/` holds tools that run inside another app, grouped by host, such as `external/chrome-extensions/` and `external/obsidian-plugins/`. They have no upstream and live here.
- `skills/<name>/SKILL.md` tells agents when and how to use the tool.
- `skills/<name>/scripts/` holds a dependency-free script that the skill runs in place, with no build or install step, such as `skills/input-replay/scripts/replay.mjs`.

## Commands

Requires `just`, `jj`, `cargo`, `bun`, and `node` (22+).

- `just install` builds the tools into `~/.local/bin` and registers the plugin with every agent.
- `just update` pulls the published plugin into every agent and rebuilds the tools.
- `just tool-pull simple-pr` pulls the tool's upstream changes. Then push and run `just update`.
- `just e2e-ego-recorder` exercises ego-recorder in the running ego lite against a local mock shop.
- `just herdr-mods` copies `herdr/hj-*/` (and `herdr/lib/mod-config.js` and `herdr/lib/shown.js`) into the Herdr app's home. `just install` runs it too.
- `just hc-team` installs `~/.local/bin/hc-team` pointing to `skills/hc-team/scripts/hc-team.mjs`. Each user owns their own `~/.herdr/hj-team/` presets, `_routes.json`, `_models.md`, and optional `_tools.md` playbook (use the empty-state onboarding button in `hj-team` or run `hc-team seed` explicitly to copy starter examples from `presets/`). `just install` runs it too.

ego-recorder needs one manual step, because the browser reserves it for the user. In ego lite, turn on developer mode at `chrome://extensions` and load `external/chrome-extensions/ego-recorder/extension/dist` as an unpacked extension.

voice-context deploys into an Obsidian vault. In `external/obsidian-plugins/voice-context`, run `bun install`, then `VAULT=<vault path> bun run deploy`.

The Herdr mods show up once a layout names them. Each personal mod reads its config directory from `~/.herdr/<mod_name>/` by default and can be overridden individually with `HERDR_MOD_<NAME>_DIR` (e.g. `HERDR_MOD_HJ_MENU_DIR`, `HERDR_MOD_HJ_TEAM_DIR`; for GUI Herdr, set these in the GUI/`launchd` environment so the app and CLI agree). Per-machine `hc-team` executable paths and env vars live separately in `~/.config/hc-team/machine.json` (`HC_TEAM_MACHINE_CONFIG`, not synced across machines). In `~/.config/herdr-app/layouts/<layout>.json`, a personal layout:

- `hj-pane` (`HERDR_MOD_HJ_PANE_DIR`, `~/.herdr/hj-pane/config.json`) as the pane header, in the block with `"tab": "active"`: `"pane": { "header": { "content": { "mod": "hj-pane" } }, "gap": 0, "radius": 0, "border": { "width": 0, "color": "border" }, "focus": { "width": 0, "color": "border" }, "lone": true }`. It shows each terminal's `hc` address. With that `border` and `focus` of no width, it draws one-pixel dividers between panes. Sub-agents that sit together share one blue frame that changes shade on focus; other panes get a quiet gray focus frame. Set `"terminal_padding": [2, 4]` at the layout root and no `padding` or `gap` around the tab block for panes that touch.
- `hj-tabs` (`HERDR_MOD_HJ_TABS_DIR`, `~/.herdr/hj-tabs/config.json`) in place of `tabs`, plus a second row below the tab bar: `{ "id": "hj-subtabs", "type": "block", "hidden": true, "size": { "px": 34 }, "content": { "mod": "hj-tabs", "props": { "row": "sub" } } }`. Every live sub-agent on this computer gets a pane in a sub-tab of its parent's tab, two side by side in each; the second row lists those sub-tabs after a fixed `super`. `herdr-app do terminal.park '{"terminal":"<t>"}'` takes one back out for good. When `panel-body` includes `teams`, `hj-tabs` also adds a `Teams` toggle beside `Files` and `Changes`.
- `hj-agents` (`HERDR_MOD_HJ_AGENTS_DIR`, `~/.herdr/hj-agents/config.json`) in place of `agents`. A click on a sub-agent focuses its pane (or peeks if parked). It polls `hc-team servers --json` to show live dev server URLs under each parent agent and sub-session. Add `{ "id": "servers", "type": "block", "hidden": true, "size": { "px": 30 }, "content": { "mod": "hj-agents", "props": { "view": "servers" } } }` after `agents` in `sidebar-lists` to show standalone shell and detached servers outside the Agents list.
- `hj-files` (`HERDR_MOD_HJ_FILES_DIR`, `~/.herdr/hj-files/config.json`) in place of `files` inside `panel-body.children`. Adds right-click `Open With ›` support for local files and folders via `hj-menu`.
- `hj-changes` (`HERDR_MOD_HJ_CHANGES_DIR`, `~/.herdr/hj-changes/config.json`) in place of `changes` inside `panel-body.children`. Tracks active Claude subagent worktrees and adds right-click `Open With ›` via `hj-menu`. The header's review icon opens `hj-review` on the changes shown; a right-click on a worktree chip offers `Review` above `Open With ›`. `config.json` can name other mods with `menuMod` and `reviewMod`.
- `hj-team` (`HERDR_MOD_HJ_TEAM_DIR`, fallback `HC_TEAM_PRESETS_DIR`, `~/.herdr/hj-team/` presets + `_routes.json` + `_models.md` + `_config.json`) as a right-side panel child inside `panel-body.children`: `{ "id": "teams", "type": "block", "content": { "mod": "hj-team" } }`. It browses/edits JSON presets and `_routes.json` model routing, scaffolds project `docs/agent-presets/<id>/` overlays, launches multi-harness (`claude`, `codex`, `pi`, `agy`) sub-session squads, and monitors active runs live from `hc` labels.
- `hj-menu` (`HERDR_MOD_HJ_MENU_DIR`, `~/.herdr/hj-menu/editors.json`) is the shared `Open With ›` context menu for local files in the personal `Changes` and `Files` panels and local folders in `Files` on macOS. Its last item, `Config`, creates or opens `editors.json` in the resolved config directory in the default text editor. The top-level `editors` array lists `{ "label", "bundle" }` entries in menu order. Changes apply the next time you right-click and open the submenu; a missing or invalid file uses the Zed Preview and Cursor defaults. A caller can put its own items above `Open With ›` with `props.actions` (`[{ label, icon?, overlay }]`); choosing one opens that overlay spec.
- `hj-review` (`HERDR_MOD_HJ_REVIEW_DIR`, `~/.herdr/hj-review/config.json`) needs no layout entry: `hj-changes` opens it as a window. It reviews a diff with no PR. Every changed file's diff scrolls as one list under its own header, coloured by Lezer grammars; the file list marks the file at the top, a click there brings that file's header to the top, and ↑/↓ jump between files. For the session's own checkout it shows the uncommitted changes since `HEAD`; for a subagent worktree, everything since the merge-base with the parent checkout, committed or not. Click a line to comment on it, drag or shift-click for a range, and ⌘-click to add or drop single lines. ⌘↩ adds the comment, and ⌘↩ in the general note sends the review. `Send review` types the numbered comments into the agent's terminal: a Claude session is matched by its session id, and another agent by the process that ran when the window opened. Worktree reviews go to the parent session with a note to relay them to the subagent. `Copy` puts the same text on the clipboard. Sent comments stay, dimmed, until `Clear sent`; editing one sends it again. Drafts last until Herdr reloads the mod. The gear left of the close button sets the code font size (`codeFontSize`, 9–24), line height (`codeLineHeight`, 1.2–2.4 times the size) and font (`codeFontFamily`, a name from the machine's fonts; unset follows the app font). They apply at once and are saved to `config.json`; a hand edit applies to the next window.

A mod copy stays alive while its block is hidden, so the polling mods (`hj-agents`, `hj-changes`, `hj-files`, `hj-tabs`, `hj-team`) check `shown.js` and hold no timers or folder watches until their block shows again.

Sub-session placement uses each terminal's `parent`, so it works regardless of how the terminal was started. The replacements for Herdr's bundled mods are based on herdr-app 0.1.16 and do not follow app updates.

Credentials stay outside this repository, in `~/.config/simple-pr/.env`.

## Add a tool

1. `git subtree add --prefix=tools/<name> --squash <url> main`
2. Add `skills/<name>/SKILL.md`.
3. Add its URL to `tool-pull` and its build step to `build` in the `justfile`.
