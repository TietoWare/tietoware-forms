import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalizeRequest, createInteractionToken, normalizePathAndQuery, sha256, signRequest, verifyInteractionToken } from "../src/hmac.js";

interface Vector {
  name: string;
  method: string;
  path: string;
  normalized_path: string;
  timestamp: number;
  nonce: string;
  body: string;
  secret: string;
  body_sha256: string;
  signature: string;
}

const vectors = JSON.parse(
  await readFile(new URL("./fixtures/hmac-vectors.json", import.meta.url), "utf8")
) as Vector[];

describe("HMAC protocol", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(normalizePathAndQuery(vector.path)).toBe(vector.normalized_path);
      expect(sha256(vector.body)).toBe(vector.body_sha256);
      expect(signRequest({
        method: vector.method,
        path: vector.path,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
        body: vector.body,
        secret: vector.secret
      })).toBe(vector.signature);
      expect(canonicalizeRequest(vector)).toContain(`\n${vector.body_sha256}`);
    });
  }

  it("rejects malformed interaction token timestamps and empty nonces", () => {
    const secret = "secret";
    const malformedTimestamp = createInteractionToken({ formId: "form", startedAt: Number.POSITIVE_INFINITY, nonce: "nonce" }, secret);
    const emptyNonce = createInteractionToken({ formId: "form", startedAt: 1_700_000_000_000, nonce: "" }, secret);

    expect(verifyInteractionToken(malformedTimestamp, secret)).toBeUndefined();
    expect(verifyInteractionToken(emptyNonce, secret)).toBeUndefined();
  });
});
