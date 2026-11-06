# Voice Context

Obsidian plugin in TypeScript. The repo is jj (`.jj/`), and tooling runs through `bun`.

## Commands

- `bun run typecheck` and `bun test` touch nothing outside the repo.
- `bun run deploy` bundles, then copies to `$VAULT`, the live vault. `build` and `check` deploy too.
- `bun run e2e` runs `scripts/e2e.ts` against the running Obsidian. It stubs `controller.llm` and `controller.transcribeAudio` and uses `controller.abort` at runtime, so those names are a contract.

Never read `.env`. It holds `VAULT`.

## Driving Obsidian

CLI: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`, with `plugin:reload id=voice-context`, `dev:errors`, and `eval code=`.

- `require('obsidian')` fails inside `eval`. Reach everything through `app`.
- Settings open in a popout. Use `app.setting.win` and `app.setting.modalEl`, since the main `document` does not contain them.
- Notes created from the shell are not indexed in time. Create test files through the vault API.
- A reading view in a background leaf stays stale until `app.workspace.setActiveLeaf(leaf,{focus:false})` and `leaf.view.previewMode.rerender(true)`.

## Evidence

Failures log to the console with the `[voice-context]` prefix and show a Notice, so an empty `dev:errors` does not prove success. Assert on the resulting note text.

## Guardrails

- The API key field stays masked and unread: never read its `input.value`, and never screenshot while it is revealed.
- Test markers go in a test file you created, never in the user's open note.
