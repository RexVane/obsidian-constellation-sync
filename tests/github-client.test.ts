import { describe, expect, it } from "vitest";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { GitHubAuth } from "../src/auth/github-auth";
import { GitHubClient, selectCanonicalVaults } from "../src/github/github-client";
import type { RemoteVaultSummary, RepositoryRef, VaultMetadata } from "../src/types";

const repository: RepositoryRef = { id: 10, nodeId: "node", owner: "owner", name: "notes", fullName: "owner/notes", private: true, defaultBranch: "main" };

function response(json: unknown, status = 200): RequestUrlResponse {
  return { status, headers: { "x-ratelimit-remaining": "4999" }, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0) };
}

function parseBody(request: RequestUrlParam | undefined): Record<string, unknown> {
  if (!request || typeof request.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("GitHub client request contracts", () => {
  it("deduplicates a vault identity and prefers the branch named by its metadata", () => {
    const metadata: VaultMetadata = {
      schemaVersion: 1,
      vaultId: "shared-vault",
      englishName: "obsidian-data",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      policyRevision: 1,
      syncPolicy: {
        obsidian: { coreSettings: false, themesAndSnippets: false, communityPluginData: [] },
        ignorePatterns: []
      }
    };
    const duplicate: RemoteVaultSummary = {
      branch: { name: "obsidian-vault", protected: false, headOid: "old-head" },
      metadata
    };
    const canonical: RemoteVaultSummary = {
      branch: { name: "obsidian-data", protected: false, headOid: "current-head" },
      metadata
    };

    expect(selectCanonicalVaults([duplicate, canonical])).toEqual([canonical]);
    expect(selectCanonicalVaults([canonical, duplicate])).toEqual([canonical]);
  });

  it("renames a branch through the non-administration branch endpoint", async () => {
    const requests: RequestUrlParam[] = [];
    const client = new GitHubClient({ getValidAccessToken: () => Promise.resolve("token") } as GitHubAuth, (request) => {
      requests.push(request);
      return Promise.resolve(response({ name: "project-notes", protected: false, commit: { sha: "head" } }));
    });
    await expect(client.renameBranch(repository, "work-notes", "project-notes")).resolves.toMatchObject({ name: "project-notes", headOid: "head" });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/owner/notes/branches/work-notes/rename"
    });
    const body = requests[0]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : null).toEqual({ new_name: "project-notes" });
  });

  it("reads a recursive tree while excluding the remote marker", async () => {
    const requests: RequestUrlParam[] = [];
    const queue = [
      response({ object: { sha: "commit" } }),
      response({ tree: { sha: "tree" } }),
      response({ sha: "tree", truncated: false, tree: [
        { path: ".constellation-sync/vault.json", type: "blob", mode: "100644", sha: "meta", size: 10, url: "" },
        { path: "note.md", type: "blob", mode: "100644", sha: "note", size: 4, url: "" }
      ] })
    ];
    const client = new GitHubClient({ getValidAccessToken: () => Promise.resolve("token") } as GitHubAuth, (request) => {
      requests.push(request);
      return Promise.resolve(queue.shift() ?? response({}, 500));
    });
    await expect(client.getSnapshot(repository, "work-notes")).resolves.toMatchObject({
      headOid: "commit",
      manifest: { "note.md": { path: "note.md", oid: "note", size: 4 } }
    });
    expect(requests[2]?.url).toContain("/git/trees/tree?recursive=1");
  });

  it("reports a missing vault marker as null instead of throwing", async () => {
    const client = new GitHubClient({ getValidAccessToken: () => Promise.resolve("token") } as GitHubAuth, () =>
      Promise.resolve(response({ message: "Not Found" }, 404))
    );
    await expect(client.getVaultMetadata(repository, "work-notes")).resolves.toBeNull();
  });

  it("still surfaces non-404 failures from the vault marker request", async () => {
    const client = new GitHubClient({ getValidAccessToken: () => Promise.resolve("token") } as GitHubAuth, () =>
      Promise.resolve(response({ message: "Bad credentials" }, 401))
    );
    await expect(client.getVaultMetadata(repository, "work-notes")).rejects.toThrow(/Bad credentials/);
  });

  it("bootstraps an empty repository before creating the vault branch", async () => {
    const requests: RequestUrlParam[] = [];
    const queue = [
      response({ message: "Git Repository is empty." }, 409),
      response({ sha: "bootstrap-blob" }),
      response({ sha: "bootstrap-tree" }),
      response({ sha: "bootstrap-commit" }),
      response({ ref: "refs/heads/main" }),
      response({ ref: "refs/heads/work-notes" }),
      response({ tree: { sha: "inherited-tree" } }),
      response({
        sha: "inherited-tree",
        truncated: false,
        tree: [{ path: ".constellation-sync/README.md", type: "blob", mode: "100644", sha: "bootstrap-blob", size: 42, url: "" }]
      }),
      response({ data: { createCommitOnBranch: { commit: { oid: "vault-head" } } } })
    ];
    const client = new GitHubClient({ getValidAccessToken: () => Promise.resolve("token") } as GitHubAuth, (request) => {
      requests.push(request);
      return Promise.resolve(queue.shift() ?? response({}, 500));
    });
    const metadata: VaultMetadata = {
      schemaVersion: 1,
      vaultId: "vault-id",
      englishName: "work-notes",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      policyRevision: 1,
      syncPolicy: {
        obsidian: { coreSettings: false, themesAndSnippets: false, communityPluginData: [] },
        ignorePatterns: []
      }
    };

    await expect(client.createVaultBranch(repository, metadata)).resolves.toBe("vault-head");
    expect(requests[1]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/owner/notes/git/blobs" });
    expect(parseBody(requests[1])).toMatchObject({ encoding: "base64" });
    expect(parseBody(requests[3])).toMatchObject({
      message: "Initialize Constellation Sync repository",
      tree: "bootstrap-tree",
      parents: []
    });
    expect(parseBody(requests[4])).toEqual({ ref: "refs/heads/main", sha: "bootstrap-commit" });
    expect(parseBody(requests[5])).toEqual({ ref: "refs/heads/work-notes", sha: "bootstrap-commit" });
    expect(requests[8]?.url).toBe("https://api.github.com/graphql");
  });
});
