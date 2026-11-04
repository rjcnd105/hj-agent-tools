set shell := ["bash", "-euo", "pipefail", "-c"]

plugin := "hj-agent-tools"
github := "rjcnd105/hj-agent-tools"
pi_source := "git:github.com/" + github
bin_dir := env("HOME") / ".local/bin"
# Agents with no plugin system that reads this repo. They get a symlink per skill.
link_dirs := env("HOME") / ".cursor/skills " + env("HOME") / ".gemini/skills " + env("HOME") / ".config/opencode/skills"

# Build the tools and register the plugin with every agent
install: build register link

# Pull the published plugin into every agent and rebuild the tools
update:
    jj git fetch
    jj new main@origin
    just build
    claude plugin marketplace update {{plugin}}
    claude plugin update {{plugin}}@{{plugin}}
    codex plugin marketplace upgrade {{plugin}}
    pi update {{pi_source}}
    just link

# Pull upstream changes for one tool: just tool-pull simple-pr
tool-pull name:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{name}}" in
      simple-pr) url=https://github.com/rjcnd105/simple-cli-jira-pr-tool ;;
      *) echo "unknown tool: {{name}}" >&2; exit 2 ;;
    esac
    git checkout main
    git subtree pull --prefix="tools/{{name}}" --squash "$url" main
    jj status

build:
    cargo build --release --manifest-path tools/simple-pr/Cargo.toml
    mkdir -p "{{bin_dir}}"
    install -m 755 tools/simple-pr/target/release/simple-pr "{{bin_dir}}/simple-pr.tmp"
    mv -f "{{bin_dir}}/simple-pr.tmp" "{{bin_dir}}/simple-pr"
    cargo build --release --manifest-path tools/ego-recorder/Cargo.toml
    install -m 755 tools/ego-recorder/target/release/ego-rec "{{bin_dir}}/ego-rec.tmp"
    mv -f "{{bin_dir}}/ego-rec.tmp" "{{bin_dir}}/ego-rec"
    "{{bin_dir}}/ego-rec" install
    cd tools/ego-recorder/extension && bun install --frozen-lockfile && bun run build

# Exercise ego-recorder in the running ego lite against a local mock shop
e2e-ego-recorder: build
    node tools/ego-recorder/e2e/run.mjs

register:
    claude plugin marketplace add {{github}}
    claude plugin install {{plugin}}@{{plugin}}
    codex plugin marketplace add {{github}}
    codex plugin add {{plugin}}@{{plugin}}
    pi install {{pi_source}}

link:
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in {{link_dirs}}; do
      mkdir -p "$dir"
      for skill in "$PWD"/skills/*/; do
        ln -sfn "${skill%/}" "$dir/$(basename "$skill")"
      done
    done
