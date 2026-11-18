# hc-team preset schema v1

[Shared contracts](contracts.md) define the wire format. Run `hc-team schema` for the machine-readable schema or pipe a complete preset to `hc-team preset validate --stdin`. Validation failures point to the field with a JSON Pointer and a message.

## Preset fields

| Field | Required | Type and constraints | Default |
| --- | --- | --- | --- |
| `schemaVersion` | Yes | Integer `1`. | — |
| `id` | Yes | String matching `/^[a-z0-9][a-z0-9-]{0,31}$/`. | — |
| `name` | Yes | Non-empty string, at most 80 characters. | — |
| `description` | No | String, at most 400 characters. | `""` |
| `servers` | No | Array of server objects. | `[]` |
| `roles` | Yes | Array of 1–12 role objects. | — |

The root must be an object. Unknown top-level keys are rejected. Built-in seeds live in `presets/<id>.json`. The global user store resolves to `HC_TEAM_PRESETS_DIR` when set and non-empty, otherwise `~/.agents/presets` (folder-linked from `files/workspace/.agents/presets` in `nix-dots`). Each preset is stored as `<id>.json`.

### Server fields

| Field | Required | Type and constraints | Default |
| --- | --- | --- | --- |
| `id` | Yes | String matching `/^[a-z0-9][a-z0-9_-]{0,15}$/`; unique among servers. | — |
| `command` | Yes | Non-empty array of non-empty strings. | — |
| `cwd` | No | Relative path string without `..` segments. | `"."` |

### Role fields

| Field | Required | Type and constraints | Default |
| --- | --- | --- | --- |
| `id` | Yes | String matching `/^[a-z0-9][a-z0-9_-]{0,23}$/`; unique among roles and not `"parent"`. | — |
| `title` | Yes | Non-empty string, at most 60 characters. | — |
| `route` | One of `route` or `command` | String matching `/^[a-z0-9][a-z0-9-]{0,31}$/`; names a key in `<presetsDir>/_routes.json`. | — |
| `command` | One of `route` or `command` | Non-empty array of non-empty strings; literal argv escape hatch. | — |
| `default` | No | Boolean; whether the role is selected when no explicit role list is given. | `true` |
| `readOnly` | No | Boolean; instructs the role to work read-only. | `false` |
| `skills` | No | Array of non-empty strings. Skill existence is not checked. | `[]` |
| `owns` | No | Array of non-empty strings specifying the role's scope. | `[]` |
| `talksTo` | No | Array of role IDs in the same preset, excluding the sender's own ID. | `[]` |
| `checkpoints` | No | Array of non-empty strings specifying observable checks. | `[]` |
| `instructions` | Yes | Non-empty string. | — |

Each stored role must set exactly one of `route` and `command` (`oneOf`). For any argv, use an executable basename and one JSON string per argument, including any model and effort flags. Launch resolves the executable to an absolute path and ensures `--no-daemon` for `codex`. For token discipline, keep 2–3 default-enabled roles, with optional specialists set to `"default": false`. The 2–3 role guideline is not a schema limit. `owns`, `readOnly`, `skills`, and `checkpoints` are brief directives, not sandbox enforcement. `talksTo` is routing guidance; `parent` remains a special send target, not a role ID.

## Model routing file

`<presetsDir>/_routes.json` is a companion file, not a preset. Its Schema v1 object has `schemaVersion: 1`, a `reviewed` date string (`YYYY-MM-DD`), and a `routes` object keyed by route name (same pattern as `role.route`). Each route has a `command` (non-empty array of non-empty strings) and an optional `why` string.

```json
{
  "schemaVersion": 1,
  "reviewed": "2026-11-21",
  "routes": {
    "implement": { "command": ["pi"], "why": "Use the locally configured implementation model." }
  }
}
```

Preset save and validation reject an unknown route at `/roles/<i>/route` and list available names. In the resolved views from `hc-team preset list` and `hc-team preset get <id> --merged`, a routed role keeps its `route` and gains a resolved `command` (or a `routeError` if unknown). Use the raw preset for editing; the resolved view is not the stored schema.

See [Shared contracts §1](contracts.md#1-preset-json-schema-v1) for the `hc-team routes [--json]` output and `hc-team routes save` flags. `<presetsDir>/_models.md` records the evidence behind assignments; it is not parsed as configuration.

## Project overlay

The overlay folder is `docs/agent-presets/<id>/` relative to the Git root, or the specified working directory outside Git. `shared.md` and `roles/<role-id>.md` provide project context; `tools/` holds project-local executable helpers. Field overrides go in the partial `preset.json`:

- `name` and `description` replace the global values if present.
- `servers` merge by ID. A matching entry replaces the whole server; a new entry appends it. `{"id":"x","remove":true}` removes server `x`.
- `roles` merge by ID. A matching entry shallow-merges its fields; a new entry appends a role. Within a role, `command`, `skills`, `owns`, `talksTo`, and `checkpoints` replace their arrays rather than concatenating them. Use `[]` to clear an optional array. `{"id":"x","remove":true}` removes role `x`; `"default": false` keeps it available for explicit selection.
- An overlay role may set `route` or `command`, never both. Setting `route` removes the inherited `command`; setting `command` removes the inherited `route`. Setting neither leaves the base selection intact.
- The merged preset is revalidated before launch. Remove references to deleted roles from other roles' `talksTo` arrays in the same overlay. A newly appended role or a replaced server still needs all required fields.

## Complete examples

These examples use route names from the built-in `presets/_routes.json`.

### Implementation and review (shared routes)

```json
{
  "schemaVersion": 1,
  "id": "implementation-review",
  "name": "Implementation and Review",
  "description": "언제: 코드 변경을 구현하고 독립 리뷰를 받을 때. 기본: 개발, 리뷰.",
  "roles": [
    {
      "id": "dev",
      "title": "Developer",
      "route": "implement",
      "owns": ["src/**", "tests/**"],
      "talksTo": ["reviewer"],
      "checkpoints": ["The focused tests exit 0."],
      "instructions": "Implement the task within your owned paths and send the reviewer the diff and focused test output."
    },
    {
      "id": "reviewer",
      "title": "Reviewer",
      "route": "deep-review",
      "readOnly": true,
      "instructions": "Inspect the diff and test evidence. Report findings with file paths and line numbers."
    }
  ]
}
```

### Web QA squad (literal command for an optional role)

The accessibility specialist pins its own Codex argv so its read-only sandbox does not depend on a shared route.

```json
{
  "schemaVersion": 1,
  "id": "web-feature-squad",
  "name": "Web Feature Squad",
  "description": "언제: 웹 기능을 구현하고 브라우저에서 검증할 때. 기본: 개발, Web QA, 코드 리뷰. 선택: 접근성 점검. 서버: bun dev.",
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
      "route": "implement",
      "default": true,
      "readOnly": false,
      "skills": [],
      "owns": ["src/**"],
      "talksTo": ["web-qa", "reviewer"],
      "checkpoints": ["typecheck 통과", "관련 단위 테스트 통과"],
      "instructions": "할당된 기능을 구현하고 단위 테스트를 통과시킨 뒤 hc-team send로 web-qa와 reviewer에 알린다."
    },
    {
      "id": "web-qa",
      "title": "Web QA",
      "route": "browser-qa",
      "default": true,
      "readOnly": true,
      "skills": ["ego-browser", "ego-recorder", "input-replay"],
      "talksTo": ["dev"],
      "checkpoints": [
        "The project overlay's required browser journeys pass.",
        "Gesture replay reports the expected final item with no missed input."
      ],
      "instructions": "Read the project QA overlay, discover the live server URL for this run, and report journey and gesture evidence."
    },
    {
      "id": "reviewer",
      "title": "Reviewer",
      "route": "deep-review",
      "default": true,
      "readOnly": true,
      "instructions": "Review the frontend diff for regressions and report findings with file paths and line numbers."
    },
    {
      "id": "a11y",
      "title": "Accessibility Specialist",
      "command": ["codex", "-s", "read-only"],
      "default": false,
      "readOnly": true,
      "checkpoints": ["Keyboard focus reaches and leaves each new control in order."],
      "instructions": "Audit keyboard navigation and focus in the changed flows. Report the steps to reproduce each finding."
    }
  ]
}
```
