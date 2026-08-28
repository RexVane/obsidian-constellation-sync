import { describe, expect, it } from "vitest";
import { GitHubAuth } from "../src/auth/github-auth";

class MemorySecrets {
  private readonly values = new Map<string, string>();
  getSecret(key: string): string | null { return this.values.get(key) ?? null; }
  setSecret(key: string, value: string): void { this.values.set(key, value); }
  removeSecret(key: string): void { this.values.delete(key); }
}

describe("GitHub token session storage", () => {
  it("stores a pasted token trimmed and returns it for API calls", () => {
    const secrets = new MemorySecrets();
    const auth = new GitHubAuth(secrets);
    auth.setPatSession("  ghp_example_token  ");
    expect(auth.getValidAccessToken()).toBe("ghp_example_token");
    expect(JSON.parse(secrets.getSecret("constellation-sync-github-session") ?? "{}")).toMatchObject({
      accessToken: "ghp_example_token",
      tokenType: "pat"
    });
  });

  it("rejects an empty token without touching storage", () => {
    const secrets = new MemorySecrets();
    const auth = new GitHubAuth(secrets);
    expect(() => auth.setPatSession("   ")).toThrow(/empty/i);
    expect(secrets.getSecret("constellation-sync-github-session")).toBeNull();
  });

  it("reports a missing session as not authenticated", () => {
    const auth = new GitHubAuth(new MemorySecrets());
    expect(() => auth.getValidAccessToken()).toThrow(/not connected/i);
  });

  it("drops the session on sign out", () => {
    const secrets = new MemorySecrets();
    const auth = new GitHubAuth(secrets);
    auth.setPatSession("ghp_example_token");
    auth.signOut();
    expect(() => auth.getValidAccessToken()).toThrow(/not connected/i);
  });
});
