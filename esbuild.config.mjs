import esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

loadLocalEnv();

const production = process.argv[2] === "production";
// OAuth Client IDs and App slugs are public metadata. Keeping the project's
// release defaults here makes a clean source checkout reproducible while still
// allowing developers to override them with their own App through .env.local.
const releaseDefaults = {
  clientId: "Iv23liP1SGkZ70ToT0ng",
  appSlug: "constellation-sync",
  installUrl: "https://github.com/apps/constellation-sync/installations/new"
};
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "main.js",
  define: {
    __GITHUB_CLIENT_ID__: JSON.stringify(process.env.CONSTELLATION_GITHUB_CLIENT_ID ?? releaseDefaults.clientId),
    __GITHUB_APP_SLUG__: JSON.stringify(process.env.CONSTELLATION_GITHUB_APP_SLUG ?? releaseDefaults.appSlug),
    __GITHUB_INSTALL_URL__: JSON.stringify(process.env.CONSTELLATION_GITHUB_INSTALL_URL ?? releaseDefaults.installUrl)
  }
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2];
    process.env[match[1]] = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
}
