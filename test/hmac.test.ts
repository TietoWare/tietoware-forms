import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalizeRequest, normalizePathAndQuery, sha256, signRequest } from "../src/hmac.js";

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
});
