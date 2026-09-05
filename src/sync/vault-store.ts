import { normalizePath, TFile, type App } from "obsidian";
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

  constructor(private readonly app: App) {}

  configDir(): string {
    return this.app.vault.configDir;
  }

  async scan(): Promise<LocalScan> {
    const configDir = this.configDir();
    const emptyDirectoryMarkers = await reconcileEmptyDirectoryMarkers(this.app.vault.adapter, configDir);
    const paths = new Set(
      this.app.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => !isEmptyDirectoryMarker(path) && shouldSyncPath(path, configDir))
    );
    for (const marker of emptyDirectoryMarkers) paths.add(marker);
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
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (await this.app.vault.adapter.exists(normalized)) await this.app.vault.adapter.remove(normalized);
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
