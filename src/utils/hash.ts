import { utf8 } from "./encoding";

export async function digestHex(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest(algorithm, copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gitBlobOid(bytes: Uint8Array): Promise<string> {
  const header = utf8(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header, 0);
  payload.set(bytes, header.length);
  return digestHex("SHA-1", payload);
}

export async function stableFingerprint(value: unknown): Promise<string> {
  return digestHex("SHA-256", utf8(stableStringify(value)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
