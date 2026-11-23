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

/** A subagent's `agent-<id>.meta.json` → { path, label, name, running, agentId }, or undefined when the
 *  file can't be read yet (missing or half-written: read it again later). `path` is the worktree Claude
 *  made for it (`isolation: "worktree"`), else null: its prompt may still name one (promptWorktree).
 *  `label` is the whole name or description; the chip truncates it.
 *  A running subagent has no `finished` field yet. A team member never gets one and Claude records no
 *  state for it, so it is not shown as running. */
export function parseMeta(file, text) {
  let m;
  try { m = JSON.parse(text ?? ""); } catch { return undefined; }
  if (!m || typeof m !== "object") return undefined;
  const agentId = /^agent-(.+)\.meta\.json$/.exec(file)?.[1] ?? file;
  const name = typeof m.name === "string" && m.name ? m.name : null;
  const description = typeof m.description === "string" ? m.description.trim() : "";
  const path = typeof m.worktreePath === "string" && m.worktreePath ? m.worktreePath : null;
  return { path, label: name || description || agentId.slice(0, 8), name, running: m.taskKind !== "in_process_teammate" && m.finished !== true, agentId };
}

/** Each target with `short`: its label without the leading words it shares with another shown target.
 *  A parent names a batch of subagents alike ("Comment sicko PSR-1299", "Comment sicko PSR-1301"),
 *  often next to others ("ie-1309-diagnosis"), and the batch's words would fill its chips.
 *  At least one word stays; a label no other target starts like stays whole. */
export function shortLabels(targets) {
  const words = targets.map((t) => t.label.split(/\s+/).filter(Boolean));
  const common = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  return targets.map((t, i) => {
    const shared = Math.min(words[i].length - 1, Math.max(0, ...words.map((w, j) => (j === i ? 0 : common(words[i], w)))));
    return { ...t, short: words[i].slice(Math.max(0, shared)).join(" ") || t.label };
  });
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
