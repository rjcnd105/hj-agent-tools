# `hc-team` Shared Contracts (v1)

All lanes (`lane-cli`, `lane-servers`, `lane-panel`, `lane-skill`) MUST conform strictly to this contract.

---

## 1. Preset JSON Schema (v1)

Location:
- Seed presets in repo: `presets/<id>.json`
- User global store: `process.env.HERDR_MOD_HJ_TEAM_DIR || process.env.HC_TEAM_PRESETS_DIR || path.join(os.homedir(), ".herdr", "hj-team")` (default `~/.herdr/hj-team`, folder-linked via `nix-dots` `files/workspace/.herdr`)
- Project overlay folder (relative to git root, or `--cwd` if not a git repo): `docs/agent-presets/<id>/`
  - `preset.json` (partial overlay)
  - `shared.md` (shared project context pointer)
  - `roles/<role-id>.md` (per-role project context pointer)
  - `tools/` (project-local executable helper scripts)

Design principle:
- Agent-agnostic multi-harness workflow: a single preset freely mixes `claude`, `codex`, `pi`, `agy` (Antigravity), or any interactive CLI by role so each role uses its optimal model, thinking/effort level, skills, and tools while communicating uniformly through `hc-team`.

### Schema Fields

```json
{
  "schemaVersion": 1,
  "id": "web-feature-squad",
  "name": "Web Feature Squad",
  "description": "Frontend 구현, Web QA(ego-browser/ego-rec/input-replay), 적대적 리뷰를 병렬 서브 세션으로 수행",
  "servers": [
    {
      "id": "web",
      "command": ["bun", "dev"],
      "cwd": "."
    }
  ],
  "roles": [
    {
      "id": "dev",
      "title": "Frontend Developer",
      "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "high"],
      "default": true,
      "readOnly": false,
      "skills": [],
      "owns": ["src/**"],
      "talksTo": ["web-qa", "reviewer"],
      "checkpoints": ["typecheck 통과", "관련 단위 테스트 통과"],
      "instructions": "할당된 기능을 구현하고 단위 테스트를 통과시킨 뒤 hc-team send로 web-qa와 reviewer에 알린다."
    }
  ]
}
```

### Validation Rules (JSON Pointer path + message on error)

- Root must be an object; unknown top-level keys rejected.
- `schemaVersion`: integer `1` (required).
- `id`: string matching `/^[a-z0-9][a-z0-9-]{0,31}$/` (required).
- `name`: non-empty string, max 80 chars (required).
- `description`: string, max 400 chars (default `""`).
- `servers`: optional array of objects `{ id, command, cwd? }` (default `[]`):
  - `id`: `/^[a-z0-9][a-z0-9_-]{0,15}$/`, unique within `servers`.
  - `command`: non-empty array of non-empty strings.
  - `cwd`: optional relative path string without `..` segments (default `"."`).
- `roles`: non-empty array of objects (required, max 12):
  - `id`: `/^[a-z0-9][a-z0-9_-]{0,23}$/`, unique within `roles`, must not be `"parent"`.
  - `title`: non-empty string, max 60 chars (required).
  - Exactly ONE of `route` or `command` (`oneOf`):
    - `route`: string matching `/^[a-z0-9][a-z0-9-]{0,31}$/` referencing a key in `<presetsDir>/_routes.json`. Unknown route fails validation at `/roles/<i>/route` listing available route names.
    - `command`: non-empty array of non-empty strings (literal escape hatch).
  - `default`: boolean (default `true`).
  - `readOnly`: boolean (default `false`).
  - `scalable`: boolean (default `false`). When `true`, launch accepts `--roles <id>=<N>` (`1..10`) to fan out `<id>-1..N` instances.
  - `worktree`: boolean (default `false`). When `true`, launch creates an isolated `jj workspace` or `git worktree` per launched role instance under `~/.local/state/hc-team/runs/<runId>/worktrees/<instanceId>`.
  - `ownServer`: boolean (default `false`). When `true` and `--with-servers` is active, launch starts `preset.servers` inside each role instance's `cwd` with a distinct allocated free port (`PORT`, `HC_TEAM_PORT`, and `{port}` substitution).
  - `skills`: optional array of non-empty strings (default `[]`). (Launch resolves installed `SKILL.md` paths when found.)
  - `tools`: optional array of non-empty strings (default `[]`). (Preferred CLIs, scripts, or playbooks injected into the brief to prevent trial-and-error.)
  - `owns`: optional array of non-empty strings (default `[]`). (Brief scope hints.)
  - `talksTo`: optional array of role IDs; each entry must match a `role.id` in the same preset and not itself (default `[]`).
  - `checkpoints`: optional array of non-empty strings (default `[]`).
  - `instructions`: non-empty string (required).

### Model Routing File (`<presetsDir>/_routes.json`) & Profiles (`<presetsDir>/_models.md`)

- `_routes.json` lives in `<presetsDir>` (leading `_` keeps it out of preset ID listing).
- Schema:
  ```json
  {
    "schemaVersion": 1,
    "reviewed": "2026-11-21",
    "routes": {
      "implement": { "command": ["pi", "..."], "why": "..." }
    }
  }
  ```
- Route keys match `/^[a-z0-9][a-z0-9-]{0,31}$/`; each entry has non-empty `command: string[]` and optional `why: string`.
- `hc-team routes [--json]`: returns `{ routesPath, reviewed, routes, usage: { <routeName>: ["<preset>.<role>", ...] }, literalRoles: ["<preset>.<role>", ...] }`.
- `hc-team routes save (--json <str> | --file <path> | --stdin) [--expected-sha <sha>]`: validates and writes `_routes.json` atomically.
- `hc-team preset list` / `preset get --merged`: resolves each role's `route` into `command` (preserving `route` name; if unresolved, sets `routeError: "unknown route: <name>"` instead of crashing the whole list). `preset list --json` also returns `routesReviewed`, `routes`, `routesSha`, `errors: [{ id, path, message }]`, and each item includes `globalSha` (sha256 of raw global file for conflict checks).

### Overlay Merge (`docs/agent-presets/<id>/preset.json`)

- Top-level `name`, `description`: overlay replaces if present.
- `servers`: merged by `id`; overlay entry replaces matching `id` or appends if new; `{ "id": "x", "remove": true }` removes server `x`.
- `roles`: merged by `id`; overlay entry shallow-merges fields onto matching role (arrays `skills`, `owns`, `talksTo`, `checkpoints`, `command` replace rather than concat); if overlay sets `command`, remove `route`; if overlay sets `route`, remove `command`; `{ "id": "x", "remove": true }` removes role `x`; new `id` appends a role.
- Post-merge preset is re-validated before launch.

---

## 2. `hc` Labels & Run State Layout

Runtime directory: `~/.local/state/hc-team/runs/<runId>/`
- `<runId>`: 6-char lowercase alphanumeric (e.g., `a7f3c2`) or `YYYYMMDD-<6hex>` — wait: terminal names MUST be `<= 32` chars (`<run6>-<roleId>` where `roleId <= 23` chars -> `6 + 1 + 23 = 30 <= 32`). So `runId` is 6 lowercase `[a-z0-9]` chars (e.g., `k4m9x2`).
- Files inside `~/.local/state/hc-team/runs/<runId>/`:
  - `preset.json`: merged preset snapshot at launch time (immutable).
  - `briefs/<roleId>.md`: full rendered brief for each launched role.
  - `events.jsonl`: append-only JSONL (`{ ts, from, to, kind, summary, artifact? }`).
  - `artifacts/`: optional directory where roles can place compact report files.

Labels written by `hc-team launch` on every spawned child terminal:
- `hc.team.run=<runId>`
- `hc.team.preset=<presetId>`
- `hc.team.role=<roleId>` (for roles) or `hc.team.server=<serverId>` (for servers)
- `hc.team.parent=<parentAddress>` (omitted when launched with `--no-parent`)
- `hc.team.cwd=<projectRoot>`

Label written by `hc-team send` on the sender terminal ONLY:
- `hc.team.last=<kind>|<to>|<summary up to 120 chars>` (single-line, `|` in summary replaced with `/`)

NOTE: `hc-team` NEVER writes `herdr.space`, `herdr.tab`, or `hj.sub` labels (`hj-tabs` owns pane placement).

---

## 3. CLI Contract (`hc-team`, installed at `~/.local/bin/hc-team` -> `skills/hc-team/scripts/hc-team.mjs`)

All commands support `--json`. Validation/operational errors exit non-zero and print concise error text (or `{ "error": { "message": "...", "issues": [{ "path": "...", "message": "..." }] } }` when `--json`).

### 3.1 Presets & Schema
- `hc-team schema` — prints JSON Schema v1 document to stdout.
- `hc-team seed [--from <dir>]` — copies missing built-in presets into the resolved presets dir (`HERDR_MOD_HJ_TEAM_DIR`, `HC_TEAM_PRESETS_DIR`, or `~/.herdr/hj-team`) without overwriting existing files.
- `hc-team preset list [--cwd <dir>] [--json]`
  - `--json` returns:
    ```json
    {
      "presetsDir": "~/.herdr/hj-team",
      "projectRoot": "/path/to/app",
      "presets": [
        {
          "id": "web-feature-squad",
          "name": "Web Feature Squad",
          "description": "...",
          "roleCount": 4,
          "defaultRoles": ["dev", "web-qa", "reviewer"],
          "hasOverlay": true,
          "overlayDir": "/path/to/app/docs/agent-presets/web-feature-squad",
          "preset": { ...mergedOrGlobalPreset }
        }
      ]
    }
    ```
    Note: each item includes `globalPreset` (raw global JSON for editing) and `preset` (merged with project overlay if present).
- `hc-team preset get <id> [--cwd <dir>] [--merged] [--json]`
- `hc-team preset validate [--file <path> | --json <str> | --stdin]`
- `hc-team preset save (--json <str> | --file <path> | --stdin) [--update]`
  - Refuses to overwrite an existing preset ID unless `--update` is passed.
  - Writes atomically via `.tmp-<pid>-<rand>` + `rename`.
- `hc-team preset delete <id> [--json]`

### 3.2 Project Overlay
- `hc-team init-project <presetId> [--cwd <dir>] [--json]`
  - Resolves project root via `git rev-parse --show-toplevel` (fallback `--cwd` / `process.cwd()`).
  - Creates `docs/agent-presets/<presetId>/` with `preset.json`, `shared.md`, `roles/<roleId>.md`, `tools/README.md`.
  - Never overwrites existing files (idempotent). Returns `{ "overlayDir": "...", "created": [...], "skipped": [...] }`.
  - For any role whose `id` includes `qa` or whose `skills` includes `ego-browser`/`ego-recorder`/`input-replay`, generates a rich Web QA template in `roles/<roleId>.md` covering: base URLs & dev server command, login/test account pointers (no secrets), key user journeys, `ego-rec` recordings inventory, `input-replay` target selectors/gestures/viewports, and known flaky areas + `hc-team servers --run` usage.

### 3.3 Orchestration
- `hc-team launch <presetId> [--cwd <dir>] [--parent <addr> | --no-parent] [--roles a,b] [--task "<text>"] [--with-servers] [--run <existingRunId>] [--dry-run] [--json]`
  - `--parent`: defaults to `$HC_TERMINAL_ID` if set, else `--no-parent`.
  - `--run <existingRunId>`: launches additional/replacement roles into an existing run.
  - Automatically ensures `--no-daemon` for `codex` commands and resolves executable basename via `PATH`, then the user's login-shell `PATH` (when `HOME` is not sandboxed), then standard user/system bin fallbacks (`~/.local/bin`, `~/.cache/.bun/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, `~/.nix-profile/bin`, `~/.local/share/mise/shims`, `/opt/homebrew/bin`, `/usr/local/bin`).
  - When a role exits before readiness, captures the last non-empty lines via `hc read` into `plan.reason` so launch failures surface exact diagnostics.
  - Launches servers first (if `--with-servers`), waits up to 15s (non-fatal) for a listening socket attributed to each server terminal via `servers` scanner.
  - Launches selected roles in parallel (`hc run --bg --json`), waits for initial readiness (`hc wait`), sends the 1-line brief trigger `Read <briefPath>. Task: <task>` via `hc send`.
  - Returns JSON:
    ```json
    {
      "runId": "k4m9x2",
      "presetId": "web-feature-squad",
      "projectRoot": "/path/to/app",
      "parent": "t114",
      "runDir": "~/.local/state/hc-team/runs/k4m9x2",
      "servers": [{ "id": "web", "address": "t201", "name": "k4m9x2-web", "ready": true, "urls": ["http://localhost:3000"] }],
      "roles": [{ "id": "dev", "address": "t202", "name": "k4m9x2-dev", "sent": true, "reason": null, "briefPath": "..." }]
    }
    ```
  - Never rolls back partially succeeded launches; reports per-role `sent` and `reason`.
- `hc-team send <to> "<summary>" [--kind handoff|result|review|blocked|ask] [--artifact <path>] [--run <id>] [--from <role>] [--json]`
  - Infers `--run` and `--from` from `$HC_TERMINAL_ID` labels when omitted.
  - `<to>` is `"parent"` or a `<roleId>` in the same run.
  - If `<to>` is not in sender's `talksTo` (and not `"parent"`), logs warning to stderr but still delivers.
  - Updates sender's `hc.team.last` label, appends to `events.jsonl` (best-effort), delivers `[<kind>] <summary>` (+ `(artifact: <path>)`) via `hc send <targetAddr>`.
  - If `<to> === "parent"` and run has no parent (`--no-parent`), records label + event and succeeds without `hc send`.
- `hc-team status [runId] [--json]`
  - Reads live terminals via `hc connect` `terminal.list` filtered by `hc.team.run`, merges latest `events.jsonl` entries.
  - Default output: compact 1 line per role; `--json`: structured array of runs.
- `hc-team stop <runId> [--json]`
  - Finds all live terminals with label `hc.team.run=<runId>`, runs `hc kill` + `hc rm` on each, returns stopped addresses.

### 3.4 Live Server Scanner (`hc-team servers`)
- `hc-team servers [--run <runId>] [--spaces '<json-array-of-space-folders>'] [--json]`
- Pure attribution function exported from `skills/hc-team/scripts/hc-team.mjs` (or `./servers.mjs` imported by it) so unit tests verify it directly on `tests/fixtures/servers-snapshot.json`:
  - `parsePs(psText)` using `ps -axo pid=,ppid=,args=`
  - `parseLsofListen(lsofText)` using `lsof +c 0 -nP -iTCP -sTCP:LISTEN -F pcn` (ignores unknown field prefixes, deduplicates `(pid, port)`)
  - `attributeListeners(terminals, psMap, listeners)`:
    - Skips remote terminals (`address.includes("/")`)
    - Rule (a): drops ports `>= 49152`
    - Traces `pid -> ppid` up to first matching `hc` terminal `pid`
    - Rule (b): within each terminal, drops listeners whose ancestor PID (below the terminal PID) is also a listener in that same terminal
    - Returns `{ byTerminal, unattributed }`
  - `probeTls(port, timeoutMs = 300)` with `(pid, port)` disk cache at `~/.local/state/hc-team/tls-cache.json` (TTL 10m):
    - `tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false })`
    - Extracts first `DNS:` entry in `subjectaltname` that is not `localhost` and has no `*`
    - Formats URL: omits `:443` for `https` and `:80` for `http`
    - `hj.url` / `hj.urls` terminal labels take precedence over probed URLs
  - Detached (`unattributed`) listeners: 1 batched `lsof -a -d cwd -p <pids> -Fpn` call; matches cwd against live terminal/space folders if provided.
  - `--json` output shape (consumed by `hj-agents`):
    ```json
    {
      "byTerminal": {
        "t6m": [
          { "url": "https://productservice-local.systemiic.com:4431", "port": 4431, "protocol": "https", "host": "productservice-local.systemiic.com", "pid": 60470, "comm": "next-server" }
        ],
        "t4z": [
          { "url": "https://productservice-local.systemiic.com", "port": 443, "protocol": "https", "host": "productservice-local.systemiic.com", "pid": 49441, "comm": "next-server" }
        ]
      },
      "detached": [
        { "url": "http://localhost:8000", "port": 8000, "protocol": "http", "host": "localhost", "pid": 16873, "comm": "python3.14", "cwd": "/path/to/app" }
      ],
      "updatedAt": 1795250000000
    }
    ```
  - Entries per terminal are sorted by `port` ascending and deduplicated by `url`.

---

## 4. Herdr Mod Contracts

### 4.1 `hj-agents` (`herdr/hj-agents/`)
- Pure helper module `model.js` (zero `"herdr"` / `"gpui-kit"` imports) tested in `tests/herdr-mods/hj-agents.test.mjs`.
- Polls `exec("hc-team", ["servers", "--json"], { timeout: 5000 })` every 12s (throttled immediate refresh ≥2s when agent/terminal state changes), skipping when `checking()`, `props()?.sortMenu`, `narrow()`, or `window()?.active === false`.
- Only calls `cx.notify()` when JSON string actually changed. Backoff to 60s on failure (e.g. `hc-team` not installed), keeping last good snapshot or empty.
- Module-scoped snapshot & in-flight guard shared across copies.
- Renders server rows (`id: srv-${addr}-${port}`):
  - Directly under parent agents that own servers
  - Nested under each sub-session (`subRow`) that owns servers (one extra indent level)
  - In a `Shell Servers` section (or inside matching space in grouped mode) for non-agent live shells (`fish`, `zsh`, program children without agent status) that own servers, plus `Detached` servers whose `cwd` matches a live space folder
  - Max 3 URLs shown per owner by default + clickable `+N more` expander; fold counts (`subs.length`) count sub-sessions only (not server rows).
  - Row click opens URL (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows); small terminal icon button focuses owner terminal (`pane.focus` if in `panes()`, else `terminal.peek`).

### 4.2 `hj-team` & `hj-tabs` (`herdr/hj-team/`, `herdr/hj-tabs/`)
- `hj-team/mod.json`: `{ "place": "none", "title": "Agent Team Presets" }`.
- `hj-tabs`: renders `Teams` panel button whenever `find(root, "teams")` exists in layout, and passes `[...new Set([...enabled, ...(hasTeams ? ["teams"] : [])])]` to `syncPanel`.
- `hj-team/model.js` (pure JS, zero Herdr imports) tested in `tests/herdr-mods/hj-team.test.mjs`.
- `hj-team/main.js`:
  - Guards all `exec` and `watchFolder` with `checking()` and dialog-role check (`props()?.dialog`).
  - `watchFolder(this.presetsDir || home() + "/.herdr/hj-team")` using the `presetsDir` returned by `hc-team preset list --json` (so `HERDR_MOD_HJ_TEAM_DIR` / `HC_TEAM_PRESETS_DIR` are automatically respected) with catch + 30s fallback timer; reloads immediately when watch starts.
  - Two tabs: `Presets` and `Runs`.
  - `Presets`: 2-line scrollable vertical preset list (default 3 visible rows, configurable via `_config.json`'s `visiblePresetRows`, sorted by `hasOverlay` → `lastUsed` → name), `Models` button in header (editing `_routes.json` with `--expected-sha` and `_models.md` with focused-agent sync), Launch Bar (task `InputState` passed via `--task=<text>`, explicit Parent picker defaulting to active space's `program.agent` or `none`, role toggles, `with servers` toggle, `Launch` button with `timeout: 240000` and busy/context guard), `Init docs/` button, `Edit JSON` / `+ New` / `Delete` actions.
  - Edit/New dialog (`openOverlay({ mod: "hj-team", kind: "dialog", modal: true, width: 640, height: 560, props: { dialog: "edit", preset, isNew, globalSha } })`): uses `EditorState.new({ language: "json", value })` + `Editor`, validates & saves via `exec("hc-team", ["preset", "save", "--json", text, ...(isNew ? [] : ["--update", "--expected-id", origId, "--expected-sha", origSha])])`, displays JSON-path validation errors inline, sets `setShared("hj-team.select", savedId)` on success.
  - `Runs`: groups local `terminals()` by `labels["hc.team.run"]` LIVE (zero polling/exec!), displays each role's status + `labels["hc.team.last"]` summary, click focuses (`pane.focus` or `terminal.peek`), `Stop` button opens confirm dialog (`dialog: "confirm-stop"`) before calling `exec("hc-team", ["stop", runId], { timeout: 60000 })`.
