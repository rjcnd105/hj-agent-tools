// Bundles the Lezer parsers into herdr/hj-review/lezer: one module per language, loaded on the
// first diff in that language, sharing chunks so every parser sees one @lezer/common.
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

const out = new URL("../hj-review/lezer/", import.meta.url);
const langs = ["cpp", "css", "go", "html", "java", "javascript", "json", "markdown", "python", "rust", "sass", "xml", "yaml"];
await rm(out, { recursive: true, force: true });
await build({
  entryPoints: Object.fromEntries([["common", "@lezer/common"], ["highlight", "@lezer/highlight"], ...langs.map((l) => [l, `@lezer/${l}`])]),
  outdir: out.pathname, bundle: true, splitting: true, format: "esm", minify: true,
  chunkNames: "chunk-[hash]", target: "es2022", logLevel: "warning",
});
await cp(new URL("node_modules/@lezer/common/LICENSE", import.meta.url), new URL("LICENSE", out));
