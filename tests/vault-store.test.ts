import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { ObsidianVaultStore } from "../src/sync/vault-store";

class MemoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([""]);
  readCount = 0;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.directories.has(path));
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter(
      (item) => item.startsWith(prefix) && item !== path && !item.slice(prefix.length).includes("/")
    );
    return Promise.resolve({ files, folders });
  }

  stat(path: string): Promise<{ type: "file"; ctime: number; mtime: number; size: number } | null> {
    const bytes = this.files.get(path);
    return Promise.resolve(bytes ? { type: "file", ctime: 1, mtime: 1, size: bytes.byteLength } : null);
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    this.readCount += 1;
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data));
    return Promise.resolve();
  }

  write(path: string, data: string): Promise<void> {
    return this.writeBinary(path, new TextEncoder().encode(data).buffer);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    const prefix = `${path}/`;
    if (recursive) {
      for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file);
      for (const directory of [...this.directories]) if (directory === path || directory.startsWith(prefix)) this.directories.delete(directory);
    } else {
      this.directories.delete(path);
    }
    return Promise.resolve();
  }
}

function abstractFile(adapter: MemoryAdapter, path: string): TFile | TFolder | null {
  const bytes = adapter.files.get(path);
  if (bytes) {
    const file = new TFile();
    file.path = path;
    file.stat = { ctime: 1, mtime: 1, size: bytes.byteLength };
    return file;
  }
  if (adapter.directories.has(path)) {
    const folder = new TFolder();
    folder.path = path;
    return folder;
  }
  return null;
}

function createApp(adapter: MemoryAdapter): App {
  const vault = {
    configDir: ".obsidian",
    adapter,
    getFiles: () => [...adapter.files.keys()].map((path) => abstractFile(adapter, path) as TFile),
    getAbstractFileByPath: (path: string) => abstractFile(adapter, path),
    readBinary: (file: TFile) => adapter.readBinary(file.path),
    modifyBinary: (file: TFile, data: ArrayBuffer) => adapter.writeBinary(file.path, data),
    createBinary: (path: string, data: ArrayBuffer) => adapter.writeBinary(path, data)
  };
  return {
    vault,
    fileManager: {
      trashFile: (file: TFile) => adapter.remove(file.path)
    }
  } as unknown as App;
}

describe("Obsidian vault store", () => {
  it("scans note content, excludes configuration, and reuses unchanged hashes", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set("note.md", new TextEncoder().encode("note"));
    adapter.files.set(".obsidian/app.json", new TextEncoder().encode("{}"));
    adapter.files.set(".github/workflows/test.yml", new TextEncoder().encode("on: push"));
    const store = new ObsidianVaultStore(createApp(adapter));

    const first = await store.scan();
    expect(Object.keys(first.manifest)).toEqual(["note.md"]);
    expect(first.blockedPaths).toEqual([]);
    expect(adapter.readCount).toBe(1);

    await store.scan();
    expect(adapter.readCount).toBe(1);
  });

  it("writes nested files and removes them through the vault trash API", async () => {
    const adapter = new MemoryAdapter();
    const store = new ObsidianVaultStore(createApp(adapter));
    const bytes = new TextEncoder().encode("new note");

    await store.write("folder/new.md", bytes);
    expect(adapter.directories.has("folder")).toBe(true);
    expect(adapter.files.get("folder/new.md")).toEqual(bytes);

    await store.remove("folder/new.md");
    expect(adapter.files.has("folder/new.md")).toBe(false);
  });
});
