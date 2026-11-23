// Whether a mod's layout block is on screen. A copy stays alive while its block is hidden (another
// stack child, a hidden column), and so do its timers and watches: polling mods check this and skip
// their work until the block shows again.
// Copied into each deployed mod folder by `just herdr-mods`.

/** True when `tree` (herdr's `layout()`) shows a block of `mod`: neither the block nor an ancestor is
 *  hidden, and every stack on the way shows that child (its `active`, else its first child).
 *  `match` picks blocks by their props, for a mod with several kinds of copy.
 *  Also true when the tree has no such block (a pane mod or an overlay, which the layout doesn't
 *  describe) or can't be read: those copies keep working as before. */
export function shownIn(tree, mod, match = () => true) {
  if (!tree || typeof tree !== "object") return true;
  let found = false;
  const walk = (node, visible) => {
    if (!node || typeof node !== "object") return false;
    const here = visible && node.hidden !== true;
    if (node.content?.mod === mod && match(node.content.props)) {
      found = true;
      if (here) return true;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const active = node.type === "stack" ? node.active ?? children[0]?.id : undefined;
    return children.some((child) => walk(child, here && (active === undefined || child?.id === active)));
  };
  return walk(tree, true) || !found;
}
