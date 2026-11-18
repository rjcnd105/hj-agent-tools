// Pure logic for the Changes panel's worktree targets: no herdr calls, so node tests load it as-is.

/** The focused session's own checkout. Worktree targets use their folder path as the id. */
export const MAIN = "main";

/** Claude Code's folder name under ~/.claude/projects for a session started in `cwd`. */
export const projectSlug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** `~/.claude/sessions/<pid>.json` → { sessionId, cwd }, or null. */
export function parseSession(text) {
  try {
    const s = JSON.parse(text ?? "");
    return typeof s?.sessionId === "string" && typeof s?.cwd === "string" ? { sessionId: s.sessionId, cwd: s.cwd } : null;
  } catch { return null; }
}

/** A subagent's `agent-<id>.meta.json` → { path, label, running, agentId }, or undefined when the file
 *  can't be read yet (missing or half-written: read it again later). `path` is the worktree Claude made
 *  for it (`isolation: "worktree"`), else null: its prompt may still name one (promptWorktree).
 *  A running subagent has no `finished` field yet. A team member never gets one and Claude records no
 *  state for it, so it is not shown as running. */
export function parseMeta(file, text) {
  let m;
  try { m = JSON.parse(text ?? ""); } catch { return undefined; }
  if (!m || typeof m !== "object") return undefined;
  const agentId = /^agent-(.+)\.meta\.json$/.exec(file)?.[1] ?? file;
  const description = typeof m.description === "string" ? m.description.trim() : "";
  const label = (typeof m.name === "string" && m.name) || (description.length > 24 ? `${description.slice(0, 23)}…` : description) || agentId.slice(0, 8);
  const path = typeof m.worktreePath === "string" && m.worktreePath ? m.worktreePath : null;
  return { path, label, running: m.taskKind !== "in_process_teammate" && m.finished !== true, agentId };
}

/** The one worktree a subagent's prompt names (a team member or subagent sent to work there), or null
 *  when it names none or several: a reviewer of many worktrees works in none of them.
 *  Longer paths go first, so naming `/repo.a-2` doesn't also name `/repo.a`. */
export function promptWorktree(prompt, paths) {
  if (!prompt) return null;
  let text = prompt;
  const named = [];
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const parts = text.split(path);
    // `/repo.a` inside `/repo.ab` is not a mention.
    if (parts.slice(1).some((after) => !/^[\p{L}\p{N}_-]/u.test(after))) named.push(path);
    text = parts.join("\0");
  }
  return named.length === 1 ? named[0] : null;
}

/** `git worktree list --porcelain` → Map(path → { branch }), without prunable (deleted) entries. */
export function parseWorktreeList(text) {
  const map = new Map();
  for (const block of (text ?? "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    map.set(path, { branch });
  }
  return map;
}

/** Metas (newest first) that still have a live git worktree, one per folder. */
export function worktreeTargets(metas, worktrees) {
  const seen = new Set(), targets = [];
  for (const meta of metas) {
    if (!meta || seen.has(meta.path) || !worktrees.has(meta.path)) continue;
    seen.add(meta.path);
    targets.push({ ...meta, branch: worktrees.get(meta.path).branch, rank: targets.length });
  }
  return targets;
}

/** Every live worktree target with its change count (null: unknown), running first, then newest. */
export function visibleTargets(targets, counts) {
  return targets
    .map((t) => ({ ...t, count: counts[t.path] ?? null }))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.rank - b.rank);
}

/** The user's pick while it is still shown, else the first worktree with something to see
 *  (running, or with changes), else MAIN. */
export function pickTarget(visible, remembered) {
  if (remembered === MAIN) return MAIN;
  if (remembered && visible.some((t) => t.path === remembered)) return remembered;
  return visible.find((t) => t.running || t.count > 0)?.path ?? MAIN;
}

/** Entries in `git status --porcelain=v1 -z --no-renames` output. */
export const countEntries = (stdout) => stdout.split("\0").filter(Boolean).length;
