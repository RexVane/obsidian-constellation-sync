export interface MergeResult {
  clean: boolean;
  text?: string;
  reason?: "overlap" | "complexity";
}

interface Hunk {
  start: number;
  end: number;
  replacement: string[];
  side: "local" | "remote";
}

const MAX_LCS_CELLS = 2_000_000;

export function mergeText(base: string, local: string, remote: string): MergeResult {
  if (local === remote) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };
  if (remote === base) return { clean: true, text: local };

  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if (baseLines.length * Math.max(localLines.length, remoteLines.length) > MAX_LCS_CELLS) {
    return { clean: false, reason: "complexity" };
  }

  const localHunks = diffHunks(baseLines, localLines, "local");
  const remoteHunks = diffHunks(baseLines, remoteLines, "remote");
  const combined: Hunk[] = [];

  for (const localHunk of localHunks) {
    const overlaps = remoteHunks.filter((remoteHunk) => hunksOverlap(localHunk, remoteHunk));
    if (overlaps.length === 0) {
      combined.push(localHunk);
      continue;
    }
    if (
      overlaps.length === 1 &&
      sameHunk(localHunk, overlaps[0] as Hunk)
    ) {
      combined.push(localHunk);
      continue;
    }
    return { clean: false, reason: "overlap" };
  }

  for (const remoteHunk of remoteHunks) {
    if (!localHunks.some((localHunk) => sameHunk(localHunk, remoteHunk))) combined.push(remoteHunk);
  }

  combined.sort((a, b) => b.start - a.start || b.end - a.end);
  const merged = [...baseLines];
  for (const hunk of combined) merged.splice(hunk.start, hunk.end - hunk.start, ...hunk.replacement);
  return { clean: true, text: merged.join("\n") };
}

function diffHunks(base: string[], variant: string[], side: Hunk["side"]): Hunk[] {
  const rows = base.length + 1;
  const columns = variant.length + 1;
  const matrix = new Uint32Array(rows * columns);
  const at = (row: number, column: number): number => matrix[row * columns + column] ?? 0;

  for (let row = base.length - 1; row >= 0; row -= 1) {
    for (let column = variant.length - 1; column >= 0; column -= 1) {
      matrix[row * columns + column] =
        base[row] === variant[column]
          ? at(row + 1, column + 1) + 1
          : Math.max(at(row + 1, column), at(row, column + 1));
    }
  }

  const hunks: Hunk[] = [];
  let row = 0;
  let column = 0;
  let active: Hunk | null = null;
  const finish = (): void => {
    if (active) hunks.push(active);
    active = null;
  };

  while (row < base.length || column < variant.length) {
    if (row < base.length && column < variant.length && base[row] === variant[column]) {
      finish();
      row += 1;
      column += 1;
      continue;
    }

    active ??= { start: row, end: row, replacement: [], side };
    if (column < variant.length && (row >= base.length || at(row, column + 1) >= at(row + 1, column))) {
      active.replacement.push(variant[column] as string);
      column += 1;
    } else if (row < base.length) {
      row += 1;
      active.end = row;
    }
  }
  finish();
  return hunks;
}

function hunksOverlap(left: Hunk, right: Hunk): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function sameHunk(left: Hunk, right: Hunk): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.replacement.length === right.replacement.length &&
    left.replacement.every((line, index) => line === right.replacement[index])
  );
}
