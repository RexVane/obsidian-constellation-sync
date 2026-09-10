const ALWAYS_EXCLUDED = [
  ".git/**",
  ".github/**",
  ".trash/**",
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

export function isAlwaysExcluded(path: string, configDir: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const configRoot = normalizeConfigDir(configDir);
  const normalizedLower = normalized.normalize("NFC").toLocaleLowerCase("en-US");
  const configLower = configRoot.normalize("NFC").toLocaleLowerCase("en-US");
  if (normalizedLower === configLower || normalizedLower.startsWith(`${configLower}/`)) return true;
  return ALWAYS_EXCLUDED.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function shouldSyncPath(path: string, configDir: string): boolean {
  const normalized = normalizeRepoPath(path);
  return !isAlwaysExcluded(normalized, configDir);
}

export function validatePortablePath(path: string): string[] {
  const repoPath = normalizeRepoPath(path);
  const errors: string[] = [];
  if (repoPath !== path || path !== path.normalize("NFC")) errors.push("noncanonical-path");
  const normalized = repoPath.normalize("NFC");
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
  return new RegExp(`${output}$`, "i");
}

function normalizeConfigDir(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Unsafe Obsidian config directory: ${input}`);
  }
  return normalized;
}
