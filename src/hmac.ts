import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { InteractionTokenPayload } from "./types.js";

export interface HmacInput {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  secret: string;
}

export interface SignedHeadersOptions {
  method: string;
  url: string | URL;
  body?: string;
  keyId: string;
  secret: string;
  timestamp?: number;
  nonce?: string;
  idempotencyKey?: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalizeRequest(input: Omit<HmacInput, "secret">): string {
  return [
    input.method.toUpperCase(),
    normalizePathAndQuery(input.path),
    String(input.timestamp),
    input.nonce,
    sha256(input.body)
  ].join("\n");
}

export function signRequest(input: HmacInput): string {
  return createHmac("sha256", input.secret)
    .update(canonicalizeRequest(input), "utf8")
    .digest("hex");
}

export function normalizePathAndQuery(value: string): string {
  const url = new URL(value, "https://canonical.invalid");
  const pairs = [...url.searchParams.entries()]
    .map(([key, item]) => [encodeRfc3986(key), encodeRfc3986(item)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) => compareOrdinal(keyA, keyB) || compareOrdinal(valueA, valueB));

  const query = pairs.map(([key, item]) => `${key}=${item}`).join("&");
  return `${url.pathname || "/"}${query ? `?${query}` : ""}`;
}

export function createSignedHeaders(options: SignedHeadersOptions): Record<string, string> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? randomUUID();
  const body = options.body ?? "";
  const url = typeof options.url === "string" ? new URL(options.url) : options.url;
  const signature = signRequest({
    method: options.method,
    path: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    body,
    secret: options.secret
  });

  return {
    "X-TW-Key-Id": options.keyId,
    "X-TW-Timestamp": String(timestamp),
    "X-TW-Nonce": nonce,
    ...(options.idempotencyKey ? { "X-TW-Idempotency-Key": options.idempotencyKey } : {}),
    "X-TW-Signature": signature
  };
}

export function createInteractionToken(payload: InteractionTokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyInteractionToken(token: string, secret: string): InteractionTokenPayload | undefined {
  const [encoded, actual, extra] = token.split(".");
  if (!encoded || !actual || extra !== undefined) return undefined;

  const expected = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const formId = Reflect.get(parsed, "formId");
    const startedAt = Reflect.get(parsed, "startedAt");
    const nonce = Reflect.get(parsed, "nonce");
    if (typeof formId !== "string" || !formId
      || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0
      || typeof nonce !== "string" || !nonce) return undefined;
    return { formId, startedAt, nonce };
  } catch {
    return undefined;
  }
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
