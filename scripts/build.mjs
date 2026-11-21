// Builds the extension into dist/ (the folder Chrome loads). No network, no remote code.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: { background: "src/background.ts", offscreen: "src/offscreen.ts", popup: "src/popup/popup.ts" },
  absWorkingDir: root,
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: false,
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
});

// Phosphor icons inlined into the popup, so nothing is fetched.
const icon = (name) => {
  const svg = readFileSync(join(root, "node_modules/@phosphor-icons/core/assets/regular", `${name}.svg`), "utf8");
  return svg.replace("<svg ", '<svg aria-hidden="true" ');
};
const popup = readFileSync(join(root, "src/popup/popup.html"), "utf8").replace(/\{\{icon:([a-z-]+)\}\}/g, (_, n) => icon(n));
writeFileSync(join(dist, "popup.html"), popup);
cpSync(join(root, "src/popup/popup.css"), join(dist, "popup.css"));
writeFileSync(
  join(dist, "offscreen.html"),
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Reader</title></head><body><script src="offscreen.js" type="module"></script></body></html>\n',
);
writeFileSync(join(dist, "manifest.json"), readFileSync(join(root, "static/manifest.json"), "utf8").replace("__VERSION__", version));
cpSync(join(root, "static/icons"), join(dist, "icons"), { recursive: true });
cpSync(join(root, "static/fonts"), join(dist, "fonts"), { recursive: true });
cpSync(join(root, "licenses"), join(dist, "licenses"), { recursive: true });
console.log(`Built v${version} into dist/`);
