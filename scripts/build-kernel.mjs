// Bundles the kernel into a single ESM file so the packaged app can run it with
// ELECTRON_RUN_AS_NODE=1 (or a plain node binary) without a node_modules tree.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await mkdir(resolve(root, "packages/kernel/dist"), { recursive: true });

await build({
  entryPoints: [resolve(root, "packages/kernel/src/main.ts")],
  outfile: resolve(root, "packages/kernel/dist/kernel.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["node:*"],
  banner: {
    js: [
      "import { createRequire as __anterosCreateRequire } from 'node:module';",
      "const require = __anterosCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

console.log("[build-kernel] packages/kernel/dist/kernel.mjs");