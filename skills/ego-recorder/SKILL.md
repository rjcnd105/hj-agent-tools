---
name: ego-recorder
description: Browser automation from an ego-rec recording captured in ego lite. Use when a pasted prompt names an `ego-rec` recording, or when asked to build, test, or run an automation from one ("이 녹화로 자동화 만들어줘", "녹화한 결제 돌려줘").
---

# ego-recorder

`ego-rec --help` and `ego-rec <command> --help` are the reference for commands, flags, and exit status.

## Build an automation

Recording files are large and scrubbed, so `ego-rec` is the only view of them.

1. Compile: `ego-rec compile <id> -o automations/<name>.mjs`. Done when the file exists.
2. Resolve each `TODO` in the script, and change nothing else. For detail on one step, use `ego-rec show <id> --step N`, adding `--net` for its requests. `ego-rec show <id> --shot N` prints a screenshot path. Done when no `TODO` remains.
3. Verify: `ego-rec test automations/<name>.mjs`. It stops before the payment step, so it never charges. Done when it exits 0.

Secrets resolve at runtime, so the script holds only input keys. If a value is missing, the run opens a form in ego lite for the user. Stay out of that form and report that the run is waiting for it.

## Run an automation

`ego-rec run automations/<name>.mjs` makes the real payment, so run it only when the user asks for that run. Pass changed values with `--param name=value`.

Exit 3 means the payment click happened and its result is unknown. Ask the user to check the site. Add `--again` only after they confirm the payment did not go through. Exit 4 means an earlier run ended this way, and the same rule applies.

## Failures

- `command not found`: report it. The install is `just install` in a checkout of https://github.com/rjcnd105/hj-agent-tools, on macOS arm64.
- The popup shows `ego-rec install`, or the recording list is empty: report it. The extension loads from `tools/ego-recorder/extension/dist` at `chrome://extensions`, and only the user can do that.
