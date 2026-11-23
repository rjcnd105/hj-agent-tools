// Syntax colour for diff lines, from Lezer parsers that run in the mod's own engine. herdr/lezer
// bundles them into ./lezer (`just herdr-lezer`), one module per language: a language's parser
// loads with the first diff shown in it, so a review of Markdown never loads the Rust grammar.

// JSX only where the extension says so: the dialect costs about half again as much to parse.
const js = { module: "javascript" }, jsx = { module: "javascript", config: { dialect: "jsx" } };
const ts = { module: "javascript", config: { dialect: "ts" } };
const tsx = { module: "javascript", config: { dialect: "ts jsx" } };
const md = { module: "markdown", gfm: true };
const c = { module: "cpp" }, css = { module: "css" }, html = { module: "html" }, json = { module: "json" };
const py = { module: "python" }, xml = { module: "xml" }, yaml = { module: "yaml" };
const LANGS = {
  js, mjs: js, cjs: js, jsx, ts, mts: ts, cts: ts, tsx,
  json, css, less: css, scss: { module: "sass" }, sass: { module: "sass", config: { dialect: "indented" } },
  html, htm: html, vue: html, svelte: html, xml, svg: xml, plist: xml,
  md, markdown: md, mdx: md, yml: yaml, yaml, py, pyi: py, rs: { module: "rust" }, go: { module: "go" },
  c, h: c, cc: c, cpp: c, cxx: c, hpp: c, hh: c, java: { module: "java" },
};

/** How `path` is highlighted, from its extension, or null. */
export function languageOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase(), dot = name.lastIndexOf(".");
  return dot > 0 ? LANGS[name.slice(dot + 1)] ?? null : null;
}

const loaded = new Map();
/** For a language from `languageOf`, its parser loaded once: `(text) => (to) => spans`, a parse of
 *  `text` that each call takes on to `to`, giving the [from, to, key] spans over the part since the
 *  call before. Each step stops the parse at `to` and the next reuses what it built, so parsing a
 *  text step by step costs about what one parse does, and colours it the same. Keys are the
 *  semantic colours the bundled files mod uses: keyword, string, comment, function, type, number,
 *  constant. */
export function spanner(lang) {
  if (!loaded.has(lang)) loaded.set(lang, load(lang).catch((e) => { loaded.delete(lang); throw e; }));
  return loaded.get(lang);
}

let highlighter = null;
async function load(lang) {
  const [mod, hl, { TreeFragment }] = await Promise.all([import(`./lezer/${lang.module}.js`), import("./lezer/highlight.js"), import("./lezer/common.js")]);
  highlighter ??= keys(hl);
  const parser = lang.gfm ? mod.parser.configure([mod.GFM]) : lang.config ? mod.parser.configure(lang.config) : mod.parser;
  return (text) => {
    let fragments = [], done = 0;
    return (to) => {
      const parse = parser.startParse(text, fragments), partial = to < text.length;
      if (partial) parse.stopAt(to);
      let tree;
      while (!(tree = parse.advance()));
      fragments = TreeFragment.addTree(tree, fragments, partial);
      const spans = [];
      // A node inside a styled one (a Markdown heading's "#") gets both classes, innermost last.
      hl.highlightTree(tree, highlighter, (from, upto, cls) => spans.push([from, upto, cls.slice(cls.lastIndexOf(" ") + 1)]), done, to);
      done = to;
      return spans;
    };
  };
}

// The more specific tag wins: `null` is a keyword to Lezer, a constant here.
function keys({ tagHighlighter, tags: t }) {
  return tagHighlighter([
    { tag: [t.keyword, t.heading], class: "keyword" },
    { tag: [t.string, t.regexp, t.url, t.monospace], class: "string" },
    { tag: [t.comment, t.meta, t.quote], class: "comment" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.attributeName, t.link], class: "function" },
    { tag: [t.typeName, t.className, t.namespace], class: "type" },
    { tag: t.number, class: "number" },
    { tag: [t.bool, t.null, t.atom, t.unit, t.escape, t.color, t.constant(t.variableName)], class: "constant" },
  ]);
}
