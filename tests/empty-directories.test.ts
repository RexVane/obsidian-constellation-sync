import { describe, expect, it } from "vitest";

import {
  EMPTY_DIRECTORY_MARKER,
  type DirectoryAdapter,
  reconcileEmptyDirectoryMarkers,
  removeEmptyDirectoryMarker
} from "../src/sync/empty-directories";

class MemoryDirectoryAdapter implements DirectoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  constructor(directories: string[] = [], files: Array<[string, string]> = []) {
    for (const directory of directories) this.addDirectory(directory);
    for (const [path, content] of files) {
      this.addParents(path);
      this.files.set(normalize(path), content);
    }
  }

  exists(path: string): Promise<boolean> {
    const normalized = normalize(path);
    return Promise.resolve(this.files.has(normalized) || this.directories.has(normalized));
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = normalize(path);
    const prefix = normalized ? `${normalized}/` : "";
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter(
      (item) => item.startsWith(prefix) && item !== normalized && !item.slice(prefix.length).includes("/")
    );
    return Promise.resolve({ files: files.sort(), folders: folders.sort() });
  }

  write(path: string, data: string): Promise<void> {
    this.addParents(path);
    this.files.set(normalize(path), data);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.files.delete(normalize(path));
    return Promise.resolve();
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    const normalized = normalize(path);
    const prefix = `${normalized}/`;
    if (!recursive) {
      const hasChildren = [...this.files.keys(), ...this.directories].some((item) => item.startsWith(prefix));
      if (hasChildren) throw new Error(`Directory is not empty: ${normalized}`);
    }
    for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file);
    for (const directory of [...this.directories]) {
      if (directory === normalized || directory.startsWith(prefix)) this.directories.delete(directory);
    }
    return Promise.resolve();
  }

  private addDirectory(path: string): void {
    const normalized = normalize(path);
    if (!normalized) return;
    const parts = normalized.split("/");
    for (let index = 1; index <= parts.length; index += 1) this.directories.add(parts.slice(0, index).join("/"));
  }

  private addParents(path: string): void {
    const normalized = normalize(path);
    const slash = normalized.lastIndexOf("/");
    if (slash >= 0) this.addDirectory(normalized.slice(0, slash));
  }
}

describe("empty directory markers", () => {
  it("creates markers only for visible leaf directories without synchronized files", async () => {
    const adapter = new MemoryDirectoryAdapter(
      ["全栈/empty", "全栈/parent/leaf", "全栈/with-note", ".obsidian/cache"],
      [["全栈/with-note/note.md", "note"]]
    );

    const markers = await reconcileEmptyDirectoryMarkers(adapter,".obsidian");

    expect(markers).toEqual([
      `全栈/empty/${EMPTY_DIRECTORY_MARKER}`,
      `全栈/parent/leaf/${EMPTY_DIRECTORY_MARKER}`
    ]);
    expect(adapter.files.has(`全栈/parent/${EMPTY_DIRECTORY_MARKER}`)).toBe(false);
    expect([...adapter.files.keys()].some((path) => path.startsWith(".obsidian/"))).toBe(false);

    await adapter.write("全栈/empty/new.md", "new");
    const refreshed = await reconcileEmptyDirectoryMarkers(adapter,".obsidian");
    expect(refreshed).not.toContain(`全栈/empty/${EMPTY_DIRECTORY_MARKER}`);
    expect(adapter.files.has(`全栈/empty/${EMPTY_DIRECTORY_MARKER}`)).toBe(false);
  });


  it("removes the local empty directory chain when a remote marker is deleted", async () => {
    const marker = `全栈/parent/leaf/${EMPTY_DIRECTORY_MARKER}`;
    const adapter = new MemoryDirectoryAdapter(["全栈/parent/leaf"], [[marker, ""]]);

    await removeEmptyDirectoryMarker(adapter, marker);

    expect(adapter.files.size).toBe(0);
    expect(adapter.directories.size).toBe(0);
  });
});

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}
