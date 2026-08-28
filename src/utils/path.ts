import type { SyncPolicy } from "../types";

const ALWAYS_EXCLUDED = [
  ".git/**",
  ".trash/**",
  ".obsidian/cache/**",
  ".obsidian/workspace*.json",
  ".obsidian/plugins/constellation-sync/**",
  "**/.DS_Store",
  "**/Thumbs.db"
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID = /[<>:"|?*]/;

export function normalizeRepoPath(input: string): string {
  const path = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!path || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Unsafe vault path: ${input}`);
  }
  return path;
}

export function isAlwaysExcluded(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return ALWAYS_EXCLUDED.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function shouldSyncPath(path: string, policy: SyncPolicy): boolean {
  const normalized = normalizeRepoPath(path);
  if (isAlwaysExcluded(normalized)) return false;

  if (normalized.startsWith(".obsidian/")) {
    if (isCoreSetting(normalized) && !policy.obsidian.coreSettings) return false;
    if (isThemeOrSnippet(normalized) && !policy.obsidian.themesAndSnippets) return false;
    const pluginId = communityPluginId(normalized);
    if (pluginId && !policy.obsidian.communityPluginData.includes(pluginId)) return false;
    if (!isCoreSetting(normalized) && !isThemeOrSnippet(normalized) && !pluginId) return false;
  }

  let included = true;
  for (const line of policy.ignorePatterns) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negate = trimmed.startsWith("!");
    const pattern = negate ? trimmed.slice(1) : trimmed;
    if (pattern && globToRegExp(pattern).test(normalized)) included = negate;
  }
  return included && !isAlwaysExcluded(normalized);
}

export function validatePortablePath(path: string): string[] {
  const normalized = normalizeRepoPath(path).normalize("NFC");
  const errors: string[] = [];
  for (const segment of normalized.split("/")) {
    if (WINDOWS_RESERVED.test(segment)) errors.push("windows-reserved-name");
    if (WINDOWS_INVALID.test(segment) || Array.from(segment).some((char) => char.charCodeAt(0) < 32)) errors.push("windows-invalid-character");
    if (/[. ]$/.test(segment)) errors.push("windows-trailing-dot-or-space");
  }
  return [...new Set(errors)];
}

export function findPortableCollisions(paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  return new Map([...groups].filter(([, values]) => new Set(values).size > 1));
}

export function globToRegExp(pattern: string): RegExp {
  let source = pattern.replace(/\\/g, "/");
  if (source.startsWith("/")) source = source.slice(1);
  if (source.endsWith("/")) source += "**";

  let output = "^";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "*" && next === "*") {
      const following = source[index + 2];
      output += following === "/" ? "(?:.*/)?" : ".*";
      index += following === "/" ? 2 : 1;
    } else if (char === "*") {
      output += "[^/]*";
    } else if (char === "?") {
      output += "[^/]";
    } else {
      output += char?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${output}$`);
}

function isCoreSetting(path: string): boolean {
  return /^\.obsidian\/(app|appearance|hotkeys|core-plugins(?:-migration)?|types|graph)\.json$/.test(path);
}

function isThemeOrSnippet(path: string): boolean {
  return /^\.obsidian\/(themes|snippets)\//.test(path);
}

function communityPluginId(path: string): string | null {
  const match = /^\.obsidian\/plugins\/([^/]+)\/(?:data\.json|.+\.(?:json|db))$/.exec(path);
  return match?.[1] ?? null;
}
