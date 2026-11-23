// Shared per-mod config resolver (~/.herdr/<mod>, overridable via HERDR_MOD_<NAME>_DIR).
// Copied into each deployed mod folder as ./mod-config.js by `just herdr-mods`.

export function expandHome(value, homeDir) {
  if (typeof value !== "string" || !value) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return `${homeDir}/${value.slice(2)}`;
  return value;
}

export function normalizeDir(value, homeDir, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return fallback;
  const expanded = expandHome(trimmed, homeDir);
  const absolute = expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded)
    ? expanded
    : `${homeDir}/${expanded.replace(/^\.\/+/, "")}`;
  return absolute.replace(/\/+$/, "") || "/";
}

export const posInt = (value, fallback, min = 1) =>
  Number.isFinite(Number(value)) && Math.floor(Number(value)) >= min ? Math.floor(Number(value)) : fallback;

export const posNum = (value, fallback, min = 1) =>
  Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createModConfig({
  mod,
  envVars,
  file = "config.json",
  defaults = {},
  validate,
  home,
  exec,
  readTextFile,
  checking,
}) {
  const defaultDir = () => `${home()}/.herdr/${mod}`;
  let cachedDir = null;
  let dirPromise = null;
  const views = new Map();
  let watcher = null;
  let lastRaw = undefined;

  async function readEnv(name) {
    for (const cmd of ["/usr/bin/printenv", "printenv"]) {
      try {
        const out = await exec(cmd, [name], { timeout: 2000 });
        if (out?.code === 0) return out.stdout.trim() || null;
        if (out?.code === 1) return null;
      } catch {
        // Try fallback command name if /usr/bin/printenv is unavailable.
      }
    }
    return null;
  }

  async function resolveDir() {
    if (cachedDir) return cachedDir;
    const fallback = defaultDir();
    if (checking?.()) return fallback;
    if (!dirPromise) {
      dirPromise = (async () => {
        for (const name of envVars) {
          const value = await readEnv(name);
          if (value) {
            cachedDir = normalizeDir(value, home(), fallback);
            return cachedDir;
          }
        }
        cachedDir = fallback;
        return cachedDir;
      })();
    }
    return dirPromise;
  }

  async function resolvePath(name = file) {
    return `${await resolveDir()}/${name}`;
  }

  async function load() {
    const dir = await resolveDir();
    const path = `${dir}/${file}`;
    const text = await readTextFile(path);
    if (text === null) {
      const base = cloneValue(defaults);
      return { dir, path, raw: null, config: validate ? validate(base, defaults) : base, exists: false };
    }
    const parsed = JSON.parse(text);
    const config = validate ? validate(parsed, defaults) : { ...cloneValue(defaults), ...parsed };
    return { dir, path, raw: text, config, exists: true };
  }

  async function loadSafe() {
    try {
      return await load();
    } catch (error) {
      const dir = cachedDir ?? defaultDir();
      const base = cloneValue(defaults);
      console.error(`${mod}: failed to load ${dir}/${file}: ${error?.message ?? error}`);
      return { dir, path: `${dir}/${file}`, raw: undefined, config: validate ? validate(base, defaults) : base, exists: false, error };
    }
  }

  function stopWatcher() {
    if (!watcher) return;
    watcher.active = false;
    watcher.pending?.cancel?.();
    watcher = null;
  }

  // One watch loop per mod, owned by one mounted view. It parks instead of holding a watch or a
  // timer: when no block of the mod is shown (options.shown), when the folder can't be watched
  // (it doesn't exist yet, or no watch was free), and when the host reclaims the watch. wake()
  // restarts it from render, so a hidden mod costs nothing; a failed watch retries at most every
  // retryMs, a hidden one at once (after reloading what changed meanwhile).
  function run(state, cx) {
    state.parked = 0;
    cx.spawn(async () => {
      const { options } = state;
      let failed = false;
      try {
        let result = await reload(state);
        while (state.active && (options.shown?.() ?? true)) {
          state.pending = options.watchFolder(result.dir);
          const paths = await state.pending;
          if (!state.active) return;
          if (!paths?.length) { failed = true; break; }
          result = await reload(state);
        }
      } catch {
        failed = true;
      }
      state.pending = null;
      if (state.active) { state.parked = Date.now(); state.failed = failed; }
    });
  }

  async function reload(state) {
    const result = await loadSafe();
    if (state.active && result.raw !== lastRaw) {
      lastRaw = result.raw;
      state.options.onConfig?.(result);
      for (const { cx: viewCx, options: viewOpts } of views.values()) viewOpts.onChange?.(result, viewCx);
    }
    return result;
  }

  function startWatcher(owner, cx, options) {
    if (checking?.() || watcher) return;
    run(watcher = { owner, options, active: true, pending: null, parked: 0, failed: false }, cx);
  }

  function mount(view, cx, options) {
    if (checking?.()) return;
    views.set(view, { cx, options });
    if (!watcher) startWatcher(view, cx, options);
  }

  /** Call at the top of render: restarts a parked watch loop, run by this view from now on. */
  function wake(view, cx) {
    const state = watcher, mounted = views.get(view);
    if (!state?.parked || !mounted) return;
    if (state.failed && Date.now() - state.parked < (mounted.options.retryMs ?? 30000)) return;
    state.owner = view; state.options = mounted.options;
    run(state, cx);
  }

  function unmount(view) {
    views.delete(view);
    if (watcher?.owner !== view) return;
    stopWatcher();
    const next = views.entries().next();
    if (!next.done) {
      const [nextView, { cx, options }] = next.value;
      startWatcher(nextView, cx, options);
    }
  }

  return { resolveDir, resolvePath, load, loadSafe, mount, wake, unmount };
}
