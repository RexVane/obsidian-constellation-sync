export const BRANCH_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function slugifyEnglishName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

export function validateBranchName(name: string, defaultBranch = "main"): string | null {
  if (name.length < 2 || name.length > 63) return "length";
  if (!BRANCH_NAME_PATTERN.test(name)) return "format";
  const reserved = new Set(["main", "master", "gh-pages", defaultBranch.toLowerCase()]);
  if (reserved.has(name)) return "reserved";
  return null;
}

export function branchFromEnglishName(input: string, defaultBranch = "main"): string {
  const branch = slugifyEnglishName(input);
  const error = validateBranchName(branch, defaultBranch);
  if (error) throw new Error(`Invalid vault English name: ${error}`);
  return branch;
}
