set shell := ["bash", "-euo", "pipefail", "-c"]

plugin := "hj-agent-tools"
github := "rjcnd105/hj-agent-tools"
pi_source := "git:github.com/" + github
bin_dir := env("HOME") / ".local/bin"
# Agents with no plugin system that reads this repo. They get a symlink per skill.
link_dirs := env("HOME") / ".cursor/skills " + env("HOME") / ".gemini/skills " + env("HOME") / ".config/opencode/skills"

# Build the tools and register the plugin with every agent
install: build register link hc-team herdr-mods

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
    just hc-team
    just herdr-mods

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
    cargo build --release --manifest-path external/chrome-extensions/ego-recorder/Cargo.toml
    install -m 755 external/chrome-extensions/ego-recorder/target/release/ego-rec "{{bin_dir}}/ego-rec.tmp"
    mv -f "{{bin_dir}}/ego-rec.tmp" "{{bin_dir}}/ego-rec"
    "{{bin_dir}}/ego-rec" install
    cd external/chrome-extensions/ego-recorder/extension && bun install --frozen-lockfile && bun run build

# Exercise ego-recorder in the running ego lite against a local mock shop
e2e-ego-recorder: build
    node external/chrome-extensions/ego-recorder/e2e/run.mjs

# Install the hc-team CLI wrapper and seed missing presets/routes into HERDR_MOD_HJ_TEAM_DIR (~/.herdr/hj-team)
hc-team:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{bin_dir}}"
    chmod +x "$PWD/skills/hc-team/scripts/hc-team.mjs"
    NODE_BIN="$(command -v node)"
    cat > "{{bin_dir}}/hc-team.tmp" <<EOF
    #!/usr/bin/env bash
    set -euo pipefail
    NODE_BIN="\$(command -v node 2>/dev/null || true)"
    if [ -z "\$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then NODE_BIN="$NODE_BIN"; fi
    if [ -z "\$NODE_BIN" ] && [ -x "\$HOME/.local/share/mise/shims/node" ]; then NODE_BIN="\$HOME/.local/share/mise/shims/node"; fi
    exec "\${NODE_BIN:-node}" "$PWD/skills/hc-team/scripts/hc-team.mjs" "\$@"
    EOF
    chmod 755 "{{bin_dir}}/hc-team.tmp"
    mv -f "{{bin_dir}}/hc-team.tmp" "{{bin_dir}}/hc-team"
    "{{bin_dir}}/hc-team" seed --from "$PWD/presets"

# Copy the Herdr mods (and the shared helpers in herdr/lib) into the app's home, which loads them live
herdr-mods:
    #!/usr/bin/env bash
    set -euo pipefail
    home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
    if [ ! -d "$home" ]; then echo "no Herdr app home at $home: mods skipped"; exit 0; fi
    for mod in herdr/hj-*/; do
      dest="$home/mods/$(basename "$mod")"
      mkdir -p "$dest"
      libs=()
      for lib in herdr/lib/*.js; do cp -f "$lib" "$dest/"; libs+=("--exclude=$(basename "$lib")"); done
      rsync -a --delete --exclude=gpui-kit.d.ts --exclude=jsconfig.json "${libs[@]}" "$mod" "$dest/"
    done

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
