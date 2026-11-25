---
name: hc-team
description: Create or edit multi-harness team presets ("프리셋 만들어줘"), initialize project overlays ("프로젝트 docs 프리셋 초기화해줘"), launch a preset squad ("팀 프리셋 실행해줘"), or refresh shared model routing ("새 모델 나왔어", "모델 라우팅 갱신해줘") with hc-team.
---

# hc-team

A single preset can mix `claude`, `codex`, `pi`, `agy` (Antigravity), and other interactive CLIs. Pick the agent, model, reasoning effort, skills, and tools per role; all roles coordinate through the same `hc-team` commands.

Use [hc-po](../hc-po/SKILL.md) for PO decisions: lane ownership, checkpoint judgment, review, landing, and when to close a lane. Creating or editing a preset does not launch it.

## Create or edit a preset

Prefer `route` for new roles. `<presetsDir>/_routes.json` maps capability needs such as `plan`, `implement`, `deep-review`, `investigate`, `browser-qa`, and `design-review` to full harness argv, including model and effort flags. Name routes for the work, not the model: one edit to the route updates all roles that reference it. Use a literal `command` instead for a role that needs its own argv. Run `hc-team routes` to see the mappings, which preset roles use them, and which roles use literal commands.

For the two-line preset switcher, write a short Korean `description` that opens directly with when to choose the preset (no `언제:` prefix), followed by `기본: ...`, and optionally `선택: ...` and `서버: ...`.

1. Turn the request into a role list. For each role, identify the outcome, model route or literal command, skills, concrete `tools` (preferred CLIs/scripts so the role avoids trial-and-error), writable paths or read-only scope, same-preset `talksTo` targets, and observable checkpoints. Keep global presets strictly project-, branch-, brand-, and session-memory-agnostic: never hardcode repository names, ticket prefixes, branch names, brand tone, or repo-specific scripts/paths in global presets. Put all project-specific conventions, commands, and domain context in the project's `docs/agent-presets/<id>/` overlay instead. For each dev server, identify its command and relative working directory (or leave `servers` to the project overlay).
2. Read [Schema v1](references/schema.md) for fields, limits, and full examples. Write one JSON object. Keep 2–3 roles enabled by default; set `"default": false` on extra specialists. Use argv arrays such as `["bun", "dev"]`, not shell strings. Store executable names, not absolute binary paths: launch resolves them and adds `--no-daemon` to `codex` if needed. `owns`, `readOnly`, `skills`, `tools`, and `checkpoints` guide the brief (`hc-team launch` also resolves `skills` to installed `SKILL.md` paths, links `<presetsDir>/_tools.md` if present, and lists scripts in `docs/agent-presets/<id>/tools/`); they do not enforce a sandbox.
3. For a new ID, pipe the JSON to `hc-team preset save --stdin` (or pass it as the value of `--json`). If the ID exists, pick a new ID or use the edit flow only when the user asked to update it.
4. For an edit, read the global preset with `hc-team preset get <id> --json` (omit `--merged`). Patch the requested fields, keeping the ID and unrelated fields, then pipe the full JSON to `hc-team preset save --stdin --update`. The explicit `--update` is required for overwrites. For a project-only change, edit the overlay instead.
5. Fix validation errors at the reported JSON Pointer. Verify the saved ID and default roles with `hc-team preset list --cwd <repo> --json`: check the resolved `presetsDir`, compare `globalPreset` with the save, and check `preset` for the effective project values.

## Configure this machine

Global presets and `_routes.json` live in `~/.herdr/hj-team/` (synced across machines) and must stay machine-independent (executable basenames only, never machine-specific paths). Per-machine binary paths and env vars live in `~/.config/hc-team/machine.json` (overridable via `HC_TEAM_MACHINE_CONFIG`), which is NOT synced across computers.

When setting up a new computer or fixing executable/env launch errors ("이 컴퓨터 hc-team 세팅해줘"):

1. Run `hc-team machine show --json` to inspect every executable referenced by `_routes.json` and global presets (`claude`, `codex`, `pi`, `agy`, `hc`, etc.).
2. Verify where each agent CLI is actually installed on this computer. Prefer direct binary paths over shims (`mise/shims`, `asdf/shims`) when available so non-login GUI launches do not break on shell-only env vars.
3. If non-login GUI sub-sessions on this computer require specific environment variables, put them in `env` inside `machine.json`.
4. Save via `hc-team machine save --stdin` (or `hc-team machine detect --write`), then verify under minimal `PATH`: `PATH=/usr/bin:/bin hc-team launch <preset> --dry-run --json`.

## Refresh model routing

For “새 모델 나왔어” or “모델 라우팅 갱신해줘”, use the `presetsDir` returned by `hc-team preset list --json`. Its `_models.md` is a human-readable record of model strengths, weaknesses, invocation, evidence, and local observations; `_routes.json` controls launches.

1. Check which models and flags are actually available locally with `pi --list-models`, `agy models`, and the relevant CLI `--help`. Never guess from memory.
2. Search the web for dated community feedback and benchmarks; compare them with the observation log in `<presetsDir>/_models.md`.
3. Update the relevant `<presetsDir>/_models.md` entries and their `확인:` dates.
4. Propose a `route: before -> after` table. List the affected preset roles from `hc-team routes` and get the user’s go-ahead before saving.
5. Set `reviewed` to today and pipe the full updated routing JSON to `hc-team routes save --stdin`.
6. Smoke-check one affected preset with `hc-team launch <id> --dry-run`; confirm the selected role resolves to the intended argv.

## Initialize a project overlay

Run `hc-team init-project <preset> --cwd <repo> --json`. Under the Git root (or the specified directory if outside Git) it creates `docs/agent-presets/<preset>/` with:

- `preset.json`: partial overrides. Read the [merge rules](references/schema.md#project-overlay) before editing.
- `shared.md`: project context all roles need.
- `roles/<role>.md`: role-specific context, commands, and expected evidence.
- `tools/README.md`: a place to document project-local helpers stored in `tools/`.

The command leaves existing files intact and reports `created` and `skipped`. After filling the files, inspect the effective configuration with `hc-team preset get <preset> --cwd <repo> --merged --json`.

### Web QA overlay

`init-project` seeds a richer role file when the role ID contains `qa` or its skills include `ego-browser`, `ego-recorder`, or `input-replay`. In `roles/web-qa.md` (or the selected QA role's file), record:

| Section | Include |
| --- | --- |
| Environment | Base URLs by environment, expected server ID, and dev server command. For the current run, discover the live URL with `hc-team servers --run <runId>` instead of waiting for a handoff. If no URL appears, check server status before testing. |
| Login | A pointer to the test account or fixture and how to sign in. Keep credentials and tokens out of the overlay and reports. |
| Journeys | A starting route, steps, expected outcomes, and known flaky areas. Identify the evidence to capture per journey. |
| Browser checks | Use `ego-browser` for navigation and visible-state checks; name the key elements, error states, and screenshots to capture. Read that skill before driving the browser. |
| Recordings | List `ego-rec` recording IDs, covered journeys, and automation paths. Follow `ego-recorder`; verify a prepared script with `ego-rec test <automation.mjs>`. |
| Gestures | For each carousel, horizontal scroller, or snap target, record its route, CSS selector, gesture (wheel, trackpad flick, or swipe), viewport/device, and expected active item or scroll position. Use `scripts/replay.mjs` from the installed `input-replay` skill to measure the outcome. |

Keep at most one active `web-qa` role per machine, including across runs. The shared ego browser's tabs and CDP controls can collide. Check existing runs before starting QA. While another role is using the shared browser, use `--roles` to select only roles that can work without it.

## Launch and coordinate a run

1. Preview the selection with `hc-team launch <preset> --cwd <repo> --roles dev,web-qa --dry-run --json`. Omit `--roles` to use default-enabled roles; use IDs from that preset. Choose an agent terminal with `--parent <addr>` or use `--no-parent` when the operator will monitor the run. By default the parent is `$HC_TERMINAL_ID` if set, otherwise none.
2. When asked to run the squad, launch with `hc-team launch <preset> --cwd <repo> --roles dev,web-qa --task "Implement and verify the requested feature" --with-servers --json`. Omit `--with-servers` if no server needs starting. Servers start first; a readiness timeout is non-fatal. Every selected role (count >= 1) spawns immediately as a **resident session**, receives a brief path, and stays alive for follow-up tasks until the team is disbanded (`hc-team stop <runId>`) or its parent session closes (roles launch with `--parent` and without `--outlive-parent`, so `hc` ends them automatically when the parent closes). Do not `hc kill`/`hc rm` resident roles between tasks or spawn ad-hoc sub-sessions for roles already active in the run; reuse them via `hc-team send`. For dependent work, name the expected handoff in the receiving role’s instructions. Keep the returned `runId` and check each role's `sent` and `reason`. Partial success is not rolled back.
3. From a role, send a compact handoff with `hc-team send web-qa "Feature ready for QA" --kind handoff` or report evidence with `hc-team send parent "Login journey passed" --kind result --artifact <path>`. The sender's labels supply the run and role; use `--run <id>` and `--from <role>` when inference is unavailable. `talksTo` guides routing: unlisted same-run recipients trigger a warning but still receive the message. Without a parent, sending to `parent` records the event without delivering it.
4. Inspect progress with `hc-team status <runId>` and live URLs with `hc-team servers --run <runId>`. To add or replace a role, use `hc-team launch <preset> --cwd <repo> --run <runId> --roles web-qa --task "Verify the feature" --json`. Target only the role you need; leave successful roles running.
5. Keep resident roles alive across tasks until the user disbands the team (or the parent session closes). When disbanding, `hc-team stop <runId>` kills and removes all live terminals labeled for that run, including its servers.

See §3 of the [shared contracts](references/contracts.md) for exact command signatures and JSON output.
