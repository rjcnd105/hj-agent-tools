// Syntax colour for diff lines, running in the mod's own engine. Primary languages use incremental
// Lezer parsers (herdr/lezer → ./lezer/<lang>.js), loaded on first diff. Languages Lezer does not
// cover fall back to a single lazy-loaded @tanstack/highlight bundle (./lezer/fallback.js).

// JSX only where the extension says so: the dialect costs about half again as much to parse.
const js = { module: "javascript" }, jsx = { module: "javascript", config: { dialect: "jsx" } };
const ts = { module: "javascript", config: { dialect: "ts" } };
const tsx = { module: "javascript", config: { dialect: "ts jsx" } };
const md = { module: "markdown", gfm: true };
const c = { module: "cpp" }, css = { module: "css" }, html = { module: "html" }, json = { module: "json" };
const py = { module: "python" }, xml = { module: "xml" }, yaml = { module: "yaml" };

const fb = (name) => ({ fallback: name });
const shell = fb("shell"), toml = fb("toml"), dockerfile = fb("dockerfile"), makefile = fb("makefile");
const env = fb("env"), ini = fb("ini"), ruby = fb("ruby"), php = fb("php"), sql = fb("sql");
const graphql = fb("graphql"), kotlin = fb("kotlin"), csharp = fb("csharp"), elixir = fb("elixir");
const erlang = fb("erlang"), haskell = fb("haskell"), ocaml = fb("ocaml"), fsharp = fb("fsharp");
const scala = fb("scala"), clojure = fb("clojure"), groovy = fb("groovy"), perl = fb("perl");
const powershell = fb("powershell"), batch = fb("batch"), objc = fb("objectivec"), glsl = fb("glsl");
const latex = fb("latex"), diff = fb("diff"), ada = fb("ada"), applescript = fb("applescript");
const fortran = fb("fortran"), lisp = fb("lisp"), scheme = fb("scheme"), pascal = fb("pascal");
const verilog = fb("verilog"), vhdl = fb("vhdl"), wat = fb("wat"), asm = fb("x86asm");
const mermaid = fb("mermaid"), http = fb("http"), cmake = fb("cmake"), apache = fb("apache");
const nginx = fb("nginx");

const LANGS = {
  // Lezer parsers (incremental LR)
  js, mjs: js, cjs: js, jsx, ts, mts: ts, cts: ts, tsx,
  json, css, less: css, scss: { module: "sass" }, sass: { module: "sass", config: { dialect: "indented" } },
  html, htm: html, vue: html, svelte: html, xml, svg: xml, plist: xml,
  md, markdown: md, mdx: md, yml: yaml, yaml, py, pyi: py, rs: { module: "rust" }, go: { module: "go" },
  c, h: c, cc: c, cpp: c, cxx: c, hpp: c, hh: c, java: { module: "java" },

  // TanStack Highlight fallback (non-Lezer languages)
  sh: shell, bash: shell, zsh: shell, ksh: shell, fish: shell,
  toml, dockerfile, mk: makefile, mak: makefile, nix: fb("nix"),
  env, ini, cfg: ini, conf: ini, editorconfig: ini, properties: fb("properties"),
  sql, graphql, gql: graphql, proto: fb("protobuf"),
  diff, patch: diff, cmake, nginx, htaccess: apache, http, rest: http, mmd: mermaid, mermaid,
  swift: fb("swift"), kt: kotlin, kts: kotlin, cs: csharp, csx: csharp,
  rb: ruby, rake: ruby, gemspec: ruby, php, phtml: php, dart: fb("dart"), lua: fb("lua"),
  ex: elixir, exs: elixir, erl: erlang, hrl: erlang, hs: haskell, lhs: haskell,
  ml: ocaml, mli: ocaml, fs: fsharp, fsi: fsharp, fsx: fsharp,
  scala, sc: scala, sbt: scala, clj: clojure, cljs: clojure, cljc: clojure, edn: clojure,
  elm: fb("elm"), groovy, gradle: groovy, pl: perl, pm: perl, r: fb("r"), jl: fb("julia"),
  ps1: powershell, psm1: powershell, psd1: powershell, bat: batch, cmd: batch, awk: fb("awk"),
  m: objc, mm: objc, glsl, vert: glsl, frag: glsl, comp: glsl, geom: glsl, tesc: glsl, tese: glsl,
  tex: latex, sty: latex, cls: latex, bib: latex,
  d: fb("d"), cr: fb("crystal"), coffee: fb("coffeescript"),
  ada, adb: ada, ads: ada, applescript, scpt: applescript,
  f: fortran, f90: fortran, f95: fortran, f03: fortran,
  lisp, lsp: lisp, cl: lisp, scm: scheme, ss: scheme, rkt: scheme,
  matlab: fb("matlab"), pas: pascal, pp: pascal, vb: fb("vbnet"),
  v: verilog, sv: verilog, vh: verilog, svh: verilog, vhd: vhdl, vhdl,
  wat, wast: wat, asm, s: asm, ejs: fb("ejs"),
};

// Extensionless and dotfile names mapped before falling back to extension lookup.
const NAMES = {
  dockerfile, containerfile: dockerfile,
  makefile, gnumakefile: makefile, justfile: makefile,
  "cmakelists.txt": cmake,
  gemfile: ruby, rakefile: ruby, brewfile: ruby, podfile: ruby, vagrantfile: ruby,
  ".bashrc": shell, ".bash_profile": shell, ".bash_logout": shell, ".zshrc": shell,
  ".zprofile": shell, ".zshenv": shell, ".zlogin": shell, ".profile": shell, ".shrc": shell,
  ".env": env,
  ".editorconfig": ini, ".gitconfig": ini, ".npmrc": ini, ".yarnrc": ini, ".pypirc": ini,
  ".htaccess": apache,
  "nginx.conf": nginx,
};

/** How `path` is highlighted, from its file name or extension, or null. */
export function languageOf(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(slash + 1).toLowerCase();
  if (Object.hasOwn(NAMES, name)) return NAMES[name];
  if (name.endsWith(".dockerignore")) return null;
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return dockerfile;
  if (name.startsWith(".env.")) return env;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  return Object.hasOwn(LANGS, ext) ? LANGS[ext] : null;
}

const loaded = new Map();
/** For a language from `languageOf`, its parser loaded once: `(text) => (to) => spans`, a parse of
 *  `text` that each call takes on to `to`, giving the [from, to, key] spans over the part since the
 *  call before. Keys are the semantic colours the bundled files mod uses: keyword, string, comment,
 *  function, type, number, constant. */
export function spanner(lang) {
  if (!loaded.has(lang)) loaded.set(lang, load(lang).catch((e) => { loaded.delete(lang); throw e; }));
  return loaded.get(lang);
}

let highlighter = null;
async function load(lang) {
  if (lang.fallback) return loadFallback(lang.fallback);
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

// TanStack Highlight token classes → hj-review's 7 semantic keys.
const FALLBACK_KEYS = {
  keyword: "keyword", heading: "keyword", tag: "keyword", selector: "keyword",
  string: "string", "code-inline": "string", inserted: "string",
  comment: "comment", meta: "comment",
  function: "function", command: "function", attr: "function", link: "function", property: "function",
  type: "type",
  number: "number", deleted: "number",
  literal: "constant", variable: "constant",
};

// Fallback scanners tokenize a whole hunk side synchronously; cap the input so large new files
// stay within a frame budget in QuickJS-ng and never hit engine argument limits.
export const MAX_FALLBACK_CHARS = 80_000;

let fallbackMod = null;
async function loadFallback(name) {
  fallbackMod ??= import("./lezer/fallback.js").catch((e) => { fallbackMod = null; throw e; });
  const { tokenize } = await fallbackMod;
  return (text) => {
    if (text.length > MAX_FALLBACK_CHARS) return () => [];
    let all = [];
    for (const r of tokenize(text, name)) {
      const key = FALLBACK_KEYS[r.className];
      if (key) all.push([r.start, r.end, key]);
    }
    let idx = 0, done = 0;
    return (to) => {
      const spans = [];
      while (idx < all.length && all[idx][1] <= done) idx++;
      for (let i = idx; i < all.length && all[i][0] < to; i++) {
        const [a, b, key] = all[i];
        const from = Math.max(a, done), upto = Math.min(b, to);
        if (from < upto) spans.push([from, upto, key]);
        if (b <= to) idx = i + 1;
      }
      done = to;
      if (to >= text.length) all = [];
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
