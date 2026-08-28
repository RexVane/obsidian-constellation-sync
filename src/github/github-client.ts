import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { GitHubAuth } from "../auth/github-auth";
import type {
  BranchSummary,
  CommitSummary,
  GitHubAccount,
  RemoteVaultSummary,
  RepositoryRef,
  SnapshotManifest,
  VaultMetadata
} from "../types";
import { SCHEMA_VERSION, VAULT_META_PATH } from "../types";
import { base64ToBytes, bytesToBase64, decodeUtf8, utf8 } from "../utils/encoding";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface TreeResponse {
  sha: string;
  truncated: boolean;
  tree: Array<{ path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number; url: string }>;
}

export interface RepositoryPage {
  repositories: RepositoryRef[];
  installations: Array<{ id: number; accountLogin: string }>;
}

export interface CommitAddition {
  path: string;
  bytes: Uint8Array;
}

export interface CommitChanges {
  additions: CommitAddition[];
  deletions: string[];
}

export class GitHubClient {
  private rateLimitRemaining: number | null = null;
  private rateLimitResetAt: number | null = null;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly sendRequest: (request: RequestUrlParam) => Promise<RequestUrlResponse> = requestUrl
  ) {}

  getRateLimit(): { remaining: number | null; resetAt: number | null } {
    return { remaining: this.rateLimitRemaining, resetAt: this.rateLimitResetAt };
  }

  async getAccount(): Promise<GitHubAccount> {
    const data = await this.api<{ login: string; avatar_url?: string }>("/user");
    return { login: data.login, ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}) };
  }

  async listAccessiblePrivateRepositories(): Promise<RepositoryPage> {
    const installations: Array<{ id: number; accountLogin: string }> = [];
    const repositories: RepositoryRef[] = [];
    const installationData = await this.api<{
      installations: Array<{ id: number; account: { login: string } }>;
    }>("/user/installations?per_page=100");

    for (const installation of installationData.installations) {
      installations.push({ id: installation.id, accountLogin: installation.account.login });
      let page = 1;
      while (true) {
        const data = await this.api<{
          repositories: Array<{
            id: number;
            node_id: string;
            name: string;
            full_name: string;
            private: boolean;
            default_branch: string;
            owner: { login: string };
          }>;
        }>(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`);
        for (const repository of data.repositories) {
          if (!repository.private) continue;
          repositories.push({
            id: repository.id,
            nodeId: repository.node_id,
            owner: repository.owner.login,
            name: repository.name,
            fullName: repository.full_name,
            private: repository.private,
            defaultBranch: repository.default_branch,
            installationId: installation.id
          });
        }
        if (data.repositories.length < 100) break;
        page += 1;
      }
    }
    return { repositories, installations };
  }

  async getRepository(owner: string, name: string): Promise<RepositoryRef> {
    const data = await this.api<{
      id: number;
      node_id: string;
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      owner: { login: string };
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    return {
      id: data.id,
      nodeId: data.node_id,
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch
    };
  }

  async listBranches(repository: RepositoryRef): Promise<BranchSummary[]> {
    const branches: BranchSummary[] = [];
    let page = 1;
    while (true) {
      const data = await this.api<Array<{ name: string; protected: boolean; commit: { sha: string } }>>(
        `${repoPath(repository)}/branches?per_page=100&page=${page}`
      );
      branches.push(...data.map((branch) => ({ name: branch.name, protected: branch.protected, headOid: branch.commit.sha })));
      if (data.length < 100) break;
      page += 1;
    }
    return branches;
  }

  async discoverVaults(repository: RepositoryRef): Promise<RemoteVaultSummary[]> {
    const branches = (await this.listBranches(repository)).filter((branch) => branch.name !== repository.defaultBranch);
    const results: RemoteVaultSummary[] = [];
    for (let offset = 0; offset < branches.length; offset += 4) {
      const batch = branches.slice(offset, offset + 4);
      const found = await Promise.all(
        batch.map(async (branch) => {
          try {
            const metadata = await this.getVaultMetadata(repository, branch.name);
            return metadata ? { branch, metadata } : null;
          } catch (error) {
            if (error instanceof GitHubApiError && error.status === 404) return null;
            throw error;
          }
        })
      );
      results.push(...found.filter((item): item is RemoteVaultSummary => item !== null));
    }
    return selectCanonicalVaults(results);
  }

  async findVaultById(repository: RepositoryRef, vaultId: string): Promise<RemoteVaultSummary | null> {
    return (await this.discoverVaults(repository)).find((vault) => vault.metadata.vaultId === vaultId) ?? null;
  }

  async getVaultMetadata(repository: RepositoryRef, branch: string): Promise<VaultMetadata | null> {
    // A branch without a marker is an ordinary answer, not a failure: every
    // caller already branches on null, so a 404 must not surface as an error.
    let response: { type: string; content?: string; encoding?: string };
    try {
      response = await this.api<{
        type: string;
        content?: string;
        encoding?: string;
      }>(`${repoPath(repository)}/contents/${VAULT_META_PATH}?ref=${encodeURIComponent(branch)}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
    if (response.type !== "file" || response.encoding !== "base64" || !response.content) return null;
    const text = decodeUtf8(base64ToBytes(response.content));
    if (!text) return null;
    let value: VaultMetadata;
    try {
      value = JSON.parse(text) as VaultMetadata;
    } catch {
      return null;
    }
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !value.vaultId ||
      !value.englishName ||
      !value.syncPolicy ||
      !value.syncPolicy.obsidian ||
      !Array.isArray(value.syncPolicy.ignorePatterns)
    ) return null;
    return value;
  }

  // The REST ref endpoint is served from a replica and can still report the
  // previous commit moments after a write, while createCommitOnBranch is
  // strongly consistent with the GraphQL view. Reading the head through GraphQL
  // keeps the expectedHeadOid we send in the same consistency domain as the
  // mutation that checks it.
  async getBranchHeadForCommit(repository: RepositoryRef, branch: string): Promise<string> {
    const query = `query BranchHead($owner: String!, $name: String!, $qualifiedName: String!) {
      repository(owner: $owner, name: $name) { ref(qualifiedName: $qualifiedName) { target { oid } } }
    }`;
    const data = await this.graphql<{
      repository: { ref: { target: { oid: string } | null } | null } | null;
    }>(query, { owner: repository.owner, name: repository.name, qualifiedName: `refs/heads/${branch}` });
    const oid = data.repository?.ref?.target?.oid;
    if (!oid) throw new GitHubApiError(`Branch ${branch} has no head commit.`, 404, "branch-head-missing");
    return oid;
  }

  async getBranchHead(repository: RepositoryRef, branch: string): Promise<string> {
    const data = await this.api<{ object: { sha: string } }>(
      `${repoPath(repository)}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    return data.object.sha;
  }

  async getSnapshot(repository: RepositoryRef, branch: string): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    const headOid = await this.getBranchHead(repository, branch);
    const rootTreeOid = await this.getCommitTree(repository, headOid);
    const tree = await this.getTree(repository, rootTreeOid, true);
    const entries = tree.truncated ? await this.walkTree(repository, rootTreeOid) : tree.tree;
    const manifest: SnapshotManifest = {};
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.path === VAULT_META_PATH || entry.path.startsWith(".constellation-sync/")) continue;
      manifest[entry.path] = { path: entry.path, oid: entry.sha, size: entry.size ?? 0 };
    }
    return { headOid, manifest };
  }

  async getBlob(repository: RepositoryRef, oid: string): Promise<Uint8Array> {
    const data = await this.api<{ content: string; encoding: string }>(`${repoPath(repository)}/git/blobs/${oid}`);
    if (data.encoding !== "base64") throw new GitHubApiError("GitHub returned an unsupported blob encoding.", 500, "blob-encoding");
    return base64ToBytes(data.content);
  }

  async createVaultBranch(repository: RepositoryRef, metadata: VaultMetadata): Promise<string> {
    const branch = metadata.englishName;
    let defaultHead: string;
    try {
      defaultHead = await this.getBranchHead(repository, repository.defaultBranch);
    } catch (error) {
      if (!isEmptyRepositoryError(error)) throw error;
      // GitHub does not expose a branch head until the first commit exists. Bootstrap
      // the configured default branch so the vault branch can still be created by the
      // same branch-and-marker flow used for initialized repositories.
      defaultHead = await this.createInitialRepositoryCommit(repository);
    }
    await this.api(`${repoPath(repository)}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: defaultHead }
    });

    const inherited = await this.getTree(repository, await this.getCommitTree(repository, defaultHead), true);
    const deletions = inherited.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    return this.createCommitOnBranch(repository, branch, defaultHead, `Initialize ${branch}`, {
      additions: [{ path: VAULT_META_PATH, bytes: utf8(JSON.stringify(metadata, null, 2) + "\n") }],
      deletions
    });
  }

  private async createInitialRepositoryCommit(repository: RepositoryRef): Promise<string> {
    const blob = await this.api<{ sha: string }>(`${repoPath(repository)}/git/blobs`, {
      method: "POST",
      body: {
        content: bytesToBase64(utf8("Constellation Sync repository bootstrap.\n")),
        encoding: "base64"
      }
    });
    const tree = await this.api<{ sha: string }>(`${repoPath(repository)}/git/trees`, {
      method: "POST",
      body: {
        tree: [{ path: ".constellation-sync/README.md", mode: "100644", type: "blob", sha: blob.sha }]
      }
    });
    const commit = await this.api<{ sha: string }>(`${repoPath(repository)}/git/commits`, {
      method: "POST",
      body: { message: "Initialize Constellation Sync repository", tree: tree.sha, parents: [] }
    });
    await this.api(`${repoPath(repository)}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${repository.defaultBranch}`, sha: commit.sha }
    });
    return commit.sha;
  }

  async renameBranch(repository: RepositoryRef, current: string, next: string): Promise<BranchSummary> {
    const data = await this.api<{ name: string; protected: boolean; commit: { sha: string } }>(
      `${repoPath(repository)}/branches/${encodeURIComponent(current)}/rename`,
      { method: "POST", body: { new_name: next } }
    );
    return { name: data.name, protected: data.protected, headOid: data.commit.sha };
  }

  async createCommitOnBranch(
    repository: RepositoryRef,
    branch: string,
    expectedHeadOid: string,
    message: string,
    changes: CommitChanges
  ): Promise<string> {
    const query = `mutation CreateCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid url } }
    }`;
    const input = {
      branch: { repositoryNameWithOwner: repository.fullName, branchName: branch },
      message: { headline: message },
      expectedHeadOid,
      fileChanges: {
        additions: changes.additions.map((addition) => ({ path: addition.path, contents: bytesToBase64(addition.bytes) })),
        deletions: changes.deletions.map((path) => ({ path }))
      }
    };
    const response = await this.graphql<{
      createCommitOnBranch: { commit: { oid: string } };
    }>(query, { input });
    return response.createCommitOnBranch.commit.oid;
  }

  async createCommitWithGitData(
    repository: RepositoryRef,
    branch: string,
    expectedHeadOid: string,
    message: string,
    changes: CommitChanges
  ): Promise<string> {
    const currentHead = await this.getBranchHead(repository, branch);
    if (currentHead !== expectedHeadOid) throw new GitHubApiError("Remote branch changed before commit.", 409, "head-mismatch");
    const baseCommit = await this.api<{ tree: { sha: string } }>(`${repoPath(repository)}/git/commits/${expectedHeadOid}`);
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
    for (const addition of changes.additions) {
      const blob = await this.api<{ sha: string }>(`${repoPath(repository)}/git/blobs`, {
        method: "POST",
        body: { content: bytesToBase64(addition.bytes), encoding: "base64" }
      });
      treeEntries.push({ path: addition.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const path of changes.deletions) treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    const tree = await this.api<{ sha: string }>(`${repoPath(repository)}/git/trees`, {
      method: "POST",
      body: { base_tree: baseCommit.tree.sha, tree: treeEntries }
    });
    const commit = await this.api<{ sha: string }>(`${repoPath(repository)}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.sha, parents: [expectedHeadOid] }
    });
    await this.api(`${repoPath(repository)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: { sha: commit.sha, force: false }
    });
    return commit.sha;
  }

  async updateVaultMetadata(
    repository: RepositoryRef,
    branch: string,
    expectedHeadOid: string,
    metadata: VaultMetadata
  ): Promise<string> {
    return this.createCommitOnBranch(repository, branch, expectedHeadOid, `Update vault metadata: ${branch}`, {
      additions: [{ path: VAULT_META_PATH, bytes: utf8(JSON.stringify(metadata, null, 2) + "\n") }],
      deletions: []
    });
  }

  async listCommits(repository: RepositoryRef, branch: string, page = 1): Promise<CommitSummary[]> {
    const data = await this.api<
      Array<{
        sha: string;
        html_url: string;
        commit: { message: string; author: { name: string; date: string } };
      }>
    >(`${repoPath(repository)}/commits?sha=${encodeURIComponent(branch)}&per_page=30&page=${page}`);
    return data.map((item) => ({
      oid: item.sha,
      message: item.commit.message,
      author: item.commit.author.name,
      authoredAt: item.commit.author.date,
      htmlUrl: item.html_url
    }));
  }

  async getFileAtCommit(repository: RepositoryRef, path: string, commitOid: string): Promise<Uint8Array> {
    const data = await this.api<{ type: string; content: string; encoding: string }>(
      `${repoPath(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commitOid)}`
    );
    if (data.type !== "file" || data.encoding !== "base64") throw new GitHubApiError("Historical path is not a file.", 422, "not-a-file");
    return base64ToBytes(data.content);
  }

  private async getTree(repository: RepositoryRef, oid: string, recursive: boolean): Promise<TreeResponse> {
    return this.api<TreeResponse>(`${repoPath(repository)}/git/trees/${oid}${recursive ? "?recursive=1" : ""}`);
  }

  private async getCommitTree(repository: RepositoryRef, commitOid: string): Promise<string> {
    const commit = await this.api<{ tree: { sha: string } }>(`${repoPath(repository)}/git/commits/${commitOid}`);
    return commit.tree.sha;
  }

  private async walkTree(repository: RepositoryRef, rootOid: string): Promise<TreeResponse["tree"]> {
    const output: TreeResponse["tree"] = [];
    const walk = async (oid: string, prefix: string): Promise<void> => {
      const tree = await this.getTree(repository, oid, false);
      for (const entry of tree.tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") await walk(entry.sha, path);
        else output.push({ ...entry, path });
      }
    };
    await walk(rootOid, "");
    return output;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.auth.getValidAccessToken();
    const response = await this.requestWithBackoff({
      url: `${API}/graphql`,
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION
      },
      contentType: "application/json",
      body: JSON.stringify({ query, variables }),
      throw: false
    });
    const value = response.json as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (response.status >= 400 || value.errors?.length || !value.data) {
      const message = value.errors?.map((error) => error.message).join("; ") || `GitHub GraphQL failed with ${response.status}.`;
      throw new GitHubApiError(message, response.status, value.errors?.[0]?.type ?? "graphql-error", response.headers["x-github-request-id"]);
    }
    return value.data;
  }

  private async api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const token = await this.auth.getValidAccessToken();
    const response = await this.requestWithBackoff({
      url: `${API}${path}`,
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...options.headers
      },
      ...(options.body === undefined
        ? {}
        : { contentType: "application/json", body: JSON.stringify(options.body) }),
      throw: false
    });
    if (response.status >= 400) {
      const body = response.json as { message?: string; documentation_url?: string } | null;
      const code = response.status === 403 && this.rateLimitRemaining === 0 ? "rate-limited" : `http-${response.status}`;
      throw new GitHubApiError(body?.message ?? `GitHub request failed with ${response.status}.`, response.status, code, response.headers["x-github-request-id"]);
    }
    return response.json as T;
  }

  private async requestWithBackoff(request: RequestUrlParam): Promise<RequestUrlResponse> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.sendRequest(request);
      this.captureRateLimit(response);
      if (!shouldRetry(response) || attempt === 3) return response;
      await waitForRetry(response, attempt);
    }
    throw new Error("GitHub request retry loop ended unexpectedly.");
  }

  private captureRateLimit(response: RequestUrlResponse): void {
    const remaining = response.headers["x-ratelimit-remaining"];
    const reset = response.headers["x-ratelimit-reset"];
    this.rateLimitRemaining = remaining === undefined ? this.rateLimitRemaining : Number(remaining);
    this.rateLimitResetAt = reset === undefined ? this.rateLimitResetAt : Number(reset) * 1000;
  }
}

export function selectCanonicalVaults(vaults: RemoteVaultSummary[]): RemoteVaultSummary[] {
  const byVaultId = new Map<string, RemoteVaultSummary>();
  for (const vault of vaults) {
    const current = byVaultId.get(vault.metadata.vaultId);
    if (!current || isPreferredVaultBranch(vault, current)) byVaultId.set(vault.metadata.vaultId, vault);
  }
  return [...byVaultId.values()].sort((left, right) => left.branch.name.localeCompare(right.branch.name, "en-US"));
}

function isPreferredVaultBranch(candidate: RemoteVaultSummary, current: RemoteVaultSummary): boolean {
  const candidateMatchesMetadata = candidate.branch.name === candidate.metadata.englishName;
  const currentMatchesMetadata = current.branch.name === current.metadata.englishName;
  if (candidateMatchesMetadata !== currentMatchesMetadata) return candidateMatchesMetadata;

  const candidateUpdatedAt = Date.parse(candidate.metadata.updatedAt) || 0;
  const currentUpdatedAt = Date.parse(current.metadata.updatedAt) || 0;
  if (candidateUpdatedAt !== currentUpdatedAt) return candidateUpdatedAt > currentUpdatedAt;
  return candidate.branch.name.localeCompare(current.branch.name, "en-US") < 0;
}

function repoPath(repository: RepositoryRef): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** True when GitHub rejected a commit because the branch had already moved. */
export function isStaleHeadError(error: unknown): boolean {
  return error instanceof GitHubApiError && /expected branch to point to/i.test(error.message);
}

function isEmptyRepositoryError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === 409 && /repository is empty/i.test(error.message);
}

function shouldRetry(response: RequestUrlResponse): boolean {
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) return true;
  if (response.status === 403) {
    const remaining = response.headers["x-ratelimit-remaining"];
    return remaining === "0" || response.headers["retry-after"] !== undefined;
  }
  return false;
}

async function waitForRetry(response: RequestUrlResponse, attempt: number): Promise<void> {
  const retryAfter = Number(response.headers["retry-after"] ?? "");
  const resetAt = Number(response.headers["x-ratelimit-reset"] ?? "") * 1000;
  const resetDelay = Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt - Date.now() : 0;
  const delay = Math.min(30_000, Math.max(1000, Number.isFinite(retryAfter) ? retryAfter * 1000 : resetDelay || 2 ** attempt * 1000));
  // Qualified for popout windows, as above.
  await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}
