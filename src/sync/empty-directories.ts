import type { SyncPolicy } from "../types";
import { shouldSyncPath } from "../utils/path";

export const EMPTY_DIRECTORY_MARKER = ".constellation-sync-empty-folder";

export interface DirectoryAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export function isEmptyDirectoryMarker(path: string): boolean {
  const normalized = normalize(path);
  return normalized === EMPTY_DIRECTORY_MARKER || normalized.endsWith(`/${EMPTY_DIRECTORY_MARKER}`);
}

export function emptyDirectoryMarkerPath(directory: string): string {
  const normalized = normalize(directory).replace(/\/$/, "");
  if (!normalized) throw new Error("The vault root does not need an empty-directory marker.");
  return `${normalized}/${EMPTY_DIRECTORY_MARKER}`;
}

export function emptyDirectoryFromMarker(path: string): string | null {
  if (!isEmptyDirectoryMarker(path)) return null;
  const normalized = normalize(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? null : normalized.slice(0, slash);
}

export async function reconcileEmptyDirectoryMarkers(
  adapter: DirectoryAdapter,
  policy: SyncPolicy,
  configDir: string
): Promise<string[]> {
  const root = await adapter.list("");
  const markers = new Set<string>();
  for (const folder of root.folders.map(normalize).filter(isVisibleVaultPath).sort()) {
    await visitDirectory(adapter, folder, policy, configDir, markers);
  }
  return [...markers].sort();
}

export async function removeEmptyDirectoryMarker(adapter: DirectoryAdapter, path: string): Promise<void> {
  const normalized = normalize(path);
  const directory = emptyDirectoryFromMarker(normalized);
  if (!directory) {
    if (await adapter.exists(normalized)) await adapter.remove(normalized);
    return;
  }

  if (await adapter.exists(normalized)) await adapter.remove(normalized);
  await pruneEmptyParents(adapter, directory);
}

async function visitDirectory(
  adapter: DirectoryAdapter,
  directory: string,
  policy: SyncPolicy,
  configDir: string,
  markers: Set<string>
): Promise<boolean> {
  const listing = await adapter.list(directory);
  const markerPath = emptyDirectoryMarkerPath(directory);
  const normalizedFiles = listing.files.map(normalize);
  const existingMarker = normalizedFiles.includes(markerPath);
  const directFiles = normalizedFiles.filter(
    (path) => path !== markerPath && isVisibleVaultPath(path) && shouldSyncPath(path, policy, configDir)
  );

  let childContributes = false;
  for (const folder of listing.folders.map(normalize).filter(isVisibleVaultPath).sort()) {
    if (await visitDirectory(adapter, folder, policy, configDir, markers)) childContributes = true;
  }

  const markerAllowed = shouldSyncPath(markerPath, policy, configDir);
  const needsMarker = markerAllowed && directFiles.length === 0 && !childContributes;
  if (needsMarker) {
    if (!existingMarker) await adapter.write(markerPath, "");
    markers.add(markerPath);
    return true;
  }

  if (existingMarker) await adapter.remove(markerPath);
  return directFiles.length > 0 || childContributes;
}

async function pruneEmptyParents(adapter: DirectoryAdapter, initial: string): Promise<void> {
  let current = normalize(initial);
  while (current && isVisibleVaultPath(current) && await adapter.exists(current)) {
    const listing = await adapter.list(current);
    if (listing.files.length > 0 || listing.folders.length > 0) return;
    await adapter.rmdir(current, false);
    const slash = current.lastIndexOf("/");
    current = slash < 0 ? "" : current.slice(0, slash);
  }
}

function isVisibleVaultPath(path: string): boolean {
  return normalize(path).split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}
