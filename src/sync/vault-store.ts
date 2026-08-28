import { normalizePath, TFile, type App } from "obsidian";
import type { SnapshotManifest, SyncPolicy } from "../types";
import { gitBlobOid } from "../utils/hash";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../utils/path";

export interface LocalScan {
  manifest: SnapshotManifest;
  blockedPaths: string[];
}

export interface VaultStore {
  configDir(): string;
  scan(policy: SyncPolicy): Promise<LocalScan>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class ObsidianVaultStore implements VaultStore {
  constructor(private readonly app: App) {}

  configDir(): string {
    return this.app.vault.configDir;
  }

  async scan(policy: SyncPolicy): Promise<LocalScan> {
    const configDir = this.configDir();
    const paths = new Set(
      this.app.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => shouldSyncPath(path, policy, configDir))
    );
    if (
      policy.obsidian.coreSettings ||
      policy.obsidian.themesAndSnippets ||
      policy.obsidian.communityPluginData.length > 0
    ) {
      await this.collectAdapterFiles(configDir, paths, policy);
    }

    const blockedPaths: string[] = [];
    for (const path of paths) {
      if (validatePortablePath(path).length > 0) blockedPaths.push(path);
    }
    for (const group of findPortableCollisions([...paths]).values()) blockedPaths.push(...group);

    const manifest: SnapshotManifest = {};
    for (const path of [...paths].sort()) {
      const bytes = await this.read(path);
      manifest[path] = { path, oid: await gitBlobOid(bytes), size: bytes.byteLength };
    }
    return { manifest, blockedPaths: [...new Set(blockedPaths)].sort() };
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return new Uint8Array(await this.app.vault.readBinary(file));
    return new Uint8Array(await this.app.vault.adapter.readBinary(normalized));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    await this.ensureParent(normalized);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

  private async collectAdapterFiles(directory: string, output: Set<string>, policy: SyncPolicy): Promise<void> {
    if (!(await this.app.vault.adapter.exists(directory))) return;
    const listing = await this.app.vault.adapter.list(directory);
    for (const file of listing.files) {
      if (shouldSyncPath(file, policy, this.configDir())) output.add(file);
    }
    for (const folder of listing.folders) await this.collectAdapterFiles(folder, output, policy);
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
