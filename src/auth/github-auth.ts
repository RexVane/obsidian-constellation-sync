import type { GitHubSession } from "../types";

// SecretStorage IDs are restricted to lowercase alphanumeric characters and dashes.
const SESSION_KEY = "constellation-sync-github-session";

export interface SecretStore {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): void;
  removeSecret(key: string): void;
}

export class GitHubAuthError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class GitHubAuth {
  constructor(private readonly secrets: SecretStore) {}

  getSession(): GitHubSession | null {
    const value = this.secrets.getSecret(SESSION_KEY);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as GitHubSession;
      return typeof parsed.accessToken === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  setPatSession(token: string): GitHubSession {
    const accessToken = token.trim();
    if (!accessToken) throw new GitHubAuthError("The token is empty.", "empty-token");
    const session: GitHubSession = { accessToken, tokenType: "pat" };
    this.secrets.setSecret(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  getValidAccessToken(): string {
    const session = this.getSession();
    if (!session) throw new GitHubAuthError("GitHub is not connected.", "not-authenticated");
    return session.accessToken;
  }

  signOut(): void {
    this.secrets.removeSecret(SESSION_KEY);
  }
}
