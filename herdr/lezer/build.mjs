// Bundles the Lezer parsers (one module per language, sharing @lezer/common) and a single
// @tanstack/highlight fallback bundle for languages Lezer does not cover into herdr/hj-review/lezer.
import { build } from "esbuild";
import { cp, readdir, rm } from "node:fs/promises";

const out = new URL("../hj-review/lezer/", import.meta.url);
const langs = ["cpp", "css", "go", "html", "java", "javascript", "json", "markdown", "python", "rust", "sass", "xml", "yaml"];
const lezerCovered = new Set([
  "index", "plaintext", "tsrx",
  "c", "cpp", "css", "go", "html", "java", "js", "json", "jsx", "less",
  "markdown", "python", "rust", "scss", "ts", "tsx", "vue", "svelte", "yaml",
]);
// Registered inside fallback.js only for embedded delegation (e.g. PHP -> html, EJS -> js/css/ts);
// top-level .html/.css/.js/.ts files still route to Lezer in syntax.js.
const embeddedLangs = ["css", "html", "js", "ts"];

const tanstackDir = new URL("node_modules/@tanstack/highlight/dist/languages/", import.meta.url);
const fallbackLangs = (await readdir(tanstackDir))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.slice(0, -3))
  .filter((l) => !lezerCovered.has(l))
  .sort();
const bundledLangs = [...fallbackLangs, ...embeddedLangs];

await rm(out, { recursive: true, force: true });
await build({
  entryPoints: Object.fromEntries([["common", "@lezer/common"], ["highlight", "@lezer/highlight"], ...langs.map((l) => [l, `@lezer/${l}`])]),
  outdir: out.pathname, bundle: true, splitting: true, format: "esm", minify: true,
  chunkNames: "chunk-[hash]", target: "es2022", logLevel: "warning",
});

// Single lazy-loaded fallback bundle for all non-Lezer languages + embedded delegates.
const fallbackEntry = [
  ...bundledLangs.map((l, i) => `import { ${l} as l${i} } from "@tanstack/highlight/languages/${l}";`),
  `const defs = new Map();`,
  `for (const def of [${bundledLangs.map((_, i) => `l${i}`).join(", ")}]) {`,
  `  defs.set(def.name.toLowerCase(), def);`,
  `  for (const a of def.aliases || []) defs.set(a.toLowerCase(), def);`,
  `}`,
  `function normalize(len, input) {`,
  `  const out = []; let sorted = true, prev = 0;`,
  `  for (const r of input) {`,
  `    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;`,
  `    const start = Math.max(0, r.start), end = Math.min(len, r.end);`,
  `    if (start >= end) continue;`,
  `    if (start < prev) sorted = false;`,
  `    prev = start; out.push({ start, end, className: r.className });`,
  `  }`,
  `  if (!sorted) out.sort((a, b) => a.start - b.start);`,
  `  const clean = []; let end = 0;`,
  `  for (const r of out) { if (r.start < end) continue; end = r.end; clean.push(r); }`,
  `  return clean;`,
  `}`,
  `export const languages = ${JSON.stringify(fallbackLangs)};`,
  `export function tokenize(code, lang, depth = 0) {`,
  `  const def = defs.get(lang);`,
  `  if (!def || depth > 12) return [];`,
  `  return normalize(code.length, def.tokenize(code, {`,
  `    hasLanguage: (name) => defs.has(name.trim().toLowerCase()),`,
  `    tokenize: (sub, subLang) => tokenize(sub, subLang.trim().toLowerCase(), depth + 1),`,
  `  }));`,
  `}`,
].join("\n");

await build({
  stdin: { contents: fallbackEntry, resolveDir: new URL(".", import.meta.url).pathname, loader: "js" },
  outfile: new URL("fallback.js", out).pathname,
  bundle: true, format: "esm", minify: true, target: "es2022", logLevel: "warning",
});

await Promise.all([
  cp(new URL("node_modules/@lezer/common/LICENSE", import.meta.url), new URL("LICENSE", out)),
  cp(new URL("node_modules/@tanstack/highlight/LICENSE", import.meta.url), new URL("TANSTACK-LICENSE", out)),
  cp(new URL("node_modules/@tanstack/highlight/NOTICE.md", import.meta.url), new URL("TANSTACK-NOTICE.md", out)),
]);
