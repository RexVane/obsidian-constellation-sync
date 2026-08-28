import { describe, expect, it, vi } from "vitest";
import type { RequestUrlResponse } from "obsidian";
import { GitHubAuth } from "../src/auth/github-auth";
import type { GitHubAppConfig } from "../src/types";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

class MemorySecrets {
  private readonly values = new Map<string, string>();
  getSecret(key: string): string | null { return this.values.get(key) ?? null; }
  setSecret(key: string, value: string): void { this.values.set(key, value); }
  removeSecret(key: string): void { this.values.delete(key); }
}

const config: GitHubAppConfig = { clientId: "client", appSlug: "app", installUrl: "https://github.com/apps/app" };
const response = (json: unknown, status = 200): RequestUrlResponse => ({ status, headers: {}, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0) });

describe("GitHub Device Flow session storage", () => {
  it("refreshes an expired access token and keeps the old refresh token when GitHub omits a replacement", async () => {
    const secrets = new MemorySecrets();
    secrets.setSecret("constellation-sync-github-session", JSON.stringify({ accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() - 1000, tokenType: "bearer" }));
    const request = vi.fn(() => Promise.resolve(response({ access_token: "new", token_type: "bearer", expires_in: 3600 })));
    const auth = new GitHubAuth(config, secrets, request as never);
    await expect(auth.getValidAccessToken()).resolves.toBe("new");
    expect(JSON.parse(secrets.getSecret("constellation-sync-github-session") ?? "{}")).toMatchObject({ accessToken: "new", refreshToken: "refresh" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("redeems a rotating refresh token once when several requests race", async () => {
    const secrets = new MemorySecrets();
    secrets.setSecret("constellation-sync-github-session", JSON.stringify({ accessToken: "old", refreshToken: "rotating", expiresAt: Date.now() - 1000, tokenType: "bearer" }));
    const redeemed: string[] = [];
    const request = vi.fn((options: { body?: unknown }) => {
      const used = new URLSearchParams(String(options.body)).get("refresh_token") ?? "";
      redeemed.push(used);
      // GitHub invalidates a refresh token the moment it is redeemed.
      if (redeemed.filter((token) => token === "rotating").length > 1) {
        return Promise.resolve(response({ error: "bad_refresh_token", error_description: "refresh token already used" }));
      }
      return Promise.resolve(response({ access_token: "fresh", token_type: "bearer", expires_in: 3600, refresh_token: "next" }));
    });
    const auth = new GitHubAuth(config, secrets, request as never);

    const tokens = await Promise.all([auth.getValidAccessToken(), auth.getValidAccessToken(), auth.getValidAccessToken()]);

    expect(tokens).toEqual(["fresh", "fresh", "fresh"]);
    expect(redeemed).toEqual(["rotating"]);
  });

  it("does not claim to be configured when the public client ID is missing", () => {
    const auth = new GitHubAuth({ ...config, clientId: "" }, new MemorySecrets());
    expect(auth.isConfigured()).toBe(false);
  });
});
