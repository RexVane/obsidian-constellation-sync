import { requestUrl, type RequestUrlParam } from "obsidian";
import type { DeviceCode, GitHubAppConfig, GitHubSession } from "../types";

// SecretStorage IDs are restricted to lowercase alphanumeric characters and dashes.
const SESSION_KEY = "constellation-sync-github-session";

export interface SecretStore {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): void;
  removeSecret(key: string): void;
}

interface TokenPayload {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
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
  // GitHub rotates refresh tokens: whoever redeems one invalidates it. Parallel
  // API calls hitting an expired access token must therefore share a single
  // refresh, or all but the winner get a dead session and force a re-login.
  private refreshInFlight: Promise<GitHubSession> | null = null;

  constructor(
    readonly config: GitHubAppConfig,
    private readonly secrets: SecretStore,
    private readonly sendRequest: (request: RequestUrlParam) => ReturnType<typeof requestUrl> = requestUrl
  ) {}

  isConfigured(): boolean {
    return this.config.clientId.length > 0;
  }

  async beginDeviceFlow(): Promise<DeviceCode> {
    this.assertConfigured();
    const response = await this.sendRequest({
      url: "https://github.com/login/device/code",
      method: "POST",
      headers: { Accept: "application/json" },
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ client_id: this.config.clientId }).toString(),
      throw: false
    });
    const data = response.json as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    };
    if (response.status >= 400 || !data.device_code || !data.user_code || !data.verification_uri) {
      throw new GitHubAuthError(data.error_description ?? "GitHub did not issue a device code.", data.error ?? "device-code-failed");
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in ?? 900,
      interval: data.interval ?? 5
    };
  }

  async pollDeviceFlow(device: DeviceCode, signal?: AbortSignal): Promise<GitHubSession> {
    this.assertConfigured();
    const deadline = Date.now() + device.expiresIn * 1000;
    let intervalMs = Math.max(device.interval, 5) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs, signal);
      const response = await this.sendRequest({
        url: "https://github.com/login/oauth/access_token",
        method: "POST",
        headers: { Accept: "application/json" },
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({
          client_id: this.config.clientId,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }).toString(),
        throw: false
      });
      const data = response.json as TokenPayload;
      if (data.access_token) return this.persistToken(data);
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        intervalMs += Math.max(data.interval ?? 5, 5) * 1000;
        continue;
      }
      if (data.error === "expired_token") throw new GitHubAuthError("The GitHub device code expired.", "expired-token");
      if (data.error === "access_denied") throw new GitHubAuthError("GitHub authorization was denied.", "access-denied");
      throw new GitHubAuthError(data.error_description ?? "GitHub authorization failed.", data.error ?? "authorization-failed");
    }
    throw new GitHubAuthError("The GitHub device code expired.", "expired-token");
  }

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

  async getValidAccessToken(): Promise<string> {
    const session = this.getSession();
    if (!session) throw new GitHubAuthError("GitHub is not connected.", "not-authenticated");
    if (!session.expiresAt || session.expiresAt - Date.now() > 60_000) return session.accessToken;
    if (!session.refreshToken || (session.refreshExpiresAt && session.refreshExpiresAt <= Date.now())) {
      throw new GitHubAuthError("The GitHub session expired. Sign in again.", "refresh-expired");
    }
    return (await this.refresh(session.refreshToken)).accessToken;
  }

  async refresh(refreshToken: string): Promise<GitHubSession> {
    this.refreshInFlight ??= this.performRefresh(refreshToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(refreshToken: string): Promise<GitHubSession> {
    this.assertConfigured();
    const response = await this.sendRequest({
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      headers: { Accept: "application/json" },
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }).toString(),
      throw: false
    });
    const data = response.json as TokenPayload;
    if (!data.access_token) {
      throw new GitHubAuthError(data.error_description ?? "Could not refresh the GitHub session.", data.error ?? "refresh-failed");
    }
    return this.persistToken(data, this.getSession() ?? undefined);
  }

  signOut(): void {
    this.secrets.removeSecret(SESSION_KEY);
  }

  private persistToken(data: TokenPayload, previous?: GitHubSession): GitHubSession {
    if (!data.access_token) throw new GitHubAuthError("GitHub returned an empty access token.", "empty-token");
    const now = Date.now();
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    const refreshExpiresAt = data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : previous?.refreshExpiresAt;
    const session: GitHubSession = {
      accessToken: data.access_token,
      tokenType: data.token_type ?? "bearer",
      ...(data.scope ? { scope: data.scope } : {}),
      ...(data.expires_in ? { expiresAt: now + data.expires_in * 1000 } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshExpiresAt ? { refreshExpiresAt } : {})
    };
    this.secrets.setSecret(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new GitHubAuthError("A GitHub App client ID has not been configured in this build.", "app-not-configured");
    }
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}
