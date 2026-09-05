import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { SnapshotManifest } from "../types";
import { gitBlobOid } from "../utils/hash";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../utils/path";
import {
  isEmptyDirectoryMarker,
  reconcileEmptyDirectoryMarkers,
  removeEmptyDirectoryMarker
} from "./empty-directories";

export interface LocalScan {
  manifest: SnapshotManifest;
  blockedPaths: string[];
}

export interface VaultStore {
  configDir(): string;
  /** Config entries currently picked for sync, relative to the config directory. */
  syncedConfigPaths(): string[];
  setSyncedConfigPaths(paths: string[]): void;
  scan(): Promise<LocalScan>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface CachedOid {
  mtime: number;
  size: number;
  oid: string;
}

export class ObsidianVaultStore implements VaultStore {
  // Hashing every byte of the vault on each scan is the dominant cost of an
  // automatic sync, and most files are untouched between runs. Keyed on
  // mtime and size, so any edit still forces a rehash.
  private readonly oidCache = new Map<string, CachedOid>();
  private configSyncPaths: string[] = [];

  constructor(private readonly app: App) {}

  configDir(): string {
    return this.app.vault.configDir;
  }

  syncedConfigPaths(): string[] {
    return this.configSyncPaths;
  }

  setSyncedConfigPaths(paths: string[]): void {
    this.configSyncPaths = paths;
  }

  async scan(): Promise<LocalScan> {
    const configDir = this.configDir();
    const selection = new Set(this.configSyncPaths);
    const emptyDirectoryMarkers = await reconcileEmptyDirectoryMarkers(this.app.vault.adapter, configDir);
    const paths = new Set(
      this.app.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => !isEmptyDirectoryMarker(path) && shouldSyncPath(path, configDir, selection))
    );
    for (const marker of emptyDirectoryMarkers) paths.add(marker);
    for (const configPath of await this.collectSelectedConfigPaths(configDir, selection)) paths.add(configPath);
    const blockedPaths: string[] = [];
    for (const path of paths) {
      if (validatePortablePath(path).length > 0) blockedPaths.push(path);
    }
    for (const group of findPortableCollisions([...paths]).values()) blockedPaths.push(...group);

    const manifest: SnapshotManifest = {};
    for (const path of [...paths].sort()) {
      manifest[path] = await this.entryFor(path);
    }
    for (const path of [...this.oidCache.keys()]) {
      if (!paths.has(path)) this.oidCache.delete(path);
    }
    return { manifest, blockedPaths: [...new Set(blockedPaths)].sort() };
  }

  // Selected config entries live outside the vault index, so they are walked
  // through the adapter: exact files directly, directory entries recursively.
  private async collectSelectedConfigPaths(configDir: string, selection: ReadonlySet<string>): Promise<string[]> {
    if (selection.size === 0) return [];
    const found: string[] = [];
    for (const entry of selection) {
      const target = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      const absolute = `${configDir}/${target}`;
      try {
        if (entry.endsWith("/")) {
          if (await this.app.vault.adapter.exists(absolute)) await this.collectUnder(absolute, found);
        } else if (await this.app.vault.adapter.exists(absolute)) {
          found.push(absolute);
        }
      } catch {
        // A missing or unreadable config entry simply contributes nothing.
      }
    }
    return found.filter((path) => shouldSyncPath(path, configDir, selection));
  }

  private async collectUnder(dir: string, found: string[]): Promise<void> {
    const listing = await this.app.vault.adapter.list(dir);
    for (const file of listing.files) found.push(file);
    for (const folder of listing.folders) await this.collectUnder(folder, found);
  }

  private async entryFor(path: string): Promise<SnapshotManifest[string]> {
    const stat = await this.statOf(path);
    if (stat) {
      const cached = this.oidCache.get(path);
      if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
        return { path, oid: cached.oid, size: cached.size };
      }
    }
    const bytes = await this.read(path);
    const oid = await gitBlobOid(bytes);
    if (stat && stat.size === bytes.byteLength) {
      this.oidCache.set(path, { mtime: stat.mtime, size: bytes.byteLength, oid });
    } else {
      this.oidCache.delete(path);
    }
    return { path, oid, size: bytes.byteLength };
  }

  private async statOf(path: string): Promise<{ mtime: number; size: number } | null> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return { mtime: file.stat.mtime, size: file.stat.size };
    try {
      const stat = await this.app.vault.adapter.stat(normalized);
      return stat && stat.type === "file" ? { mtime: stat.mtime, size: stat.size } : null;
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return new Uint8Array(await this.app.vault.readBinary(file));
    return new Uint8Array(await this.app.vault.adapter.readBinary(normalized));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    this.oidCache.delete(normalized);
    await this.ensureParent(normalized);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (isEmptyDirectoryMarker(normalized)) {
      await this.app.vault.adapter.writeBinary(normalized, buffer);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.vault.modifyBinary(file, buffer);
    } else if (normalized === this.configDir() || normalized.startsWith(`${this.configDir()}/`)) {
      await this.app.vault.adapter.writeBinary(normalized, buffer);
    } else {
      await this.app.vault.createBinary(normalized, buffer);
    }
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.oidCache.delete(normalized);
    if (isEmptyDirectoryMarker(normalized)) {
      await removeEmptyDirectoryMarker(this.app.vault.adapter, normalized);
      return;
    }
    const abstract = this.app.vault.getAbstractFileByPath(normalized);
    if (abstract instanceof TFile) {
      await this.app.fileManager.trashFile(abstract);
      return;
    }
    if (abstract instanceof TFolder) {
      await this.app.vault.adapter.rmdir(normalized, true);
      return;
    }
    if (await this.app.vault.adapter.exists(normalized)) {
      try {
        await this.app.vault.adapter.remove(normalized);
      } catch {
        // The adapter cannot tell files from directories here; on macOS
        // removing a directory without the recursive flag throws EISDIR.
        await this.app.vault.adapter.rmdir(normalized, true);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }
}
