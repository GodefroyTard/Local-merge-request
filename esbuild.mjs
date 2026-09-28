import { chmodSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, logLevel: "info" };

const configs = [
  { ...common, entryPoints: ["src/extension/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["src/cli/main.ts"], outfile: "dist/cli.js", banner: { js: "#!/usr/bin/env node" } },
];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  chmodSync("dist/cli.js", 0o755);
}
