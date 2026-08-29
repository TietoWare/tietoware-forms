import { describe, expect, it, vi } from "vitest";
import { checksumFor } from "../src/generate.js";
import { createInteractionToken } from "../src/hmac.js";
import { submitForm, type FormServerConfig } from "../src/server.js";

const now = Date.UTC(2026, 7, 1, 18, 0, 0);
const nowSeconds = Math.floor(now / 1000);
const secret = "test-secret";
const publicPayload = {
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: {
      email: { type: "string" as const, format: "email" },
      company_website: { type: "string" as const }
    },
    required: ["email"],
    additionalProperties: false
  },
  ui: {},
  controls: { company_website: { control: "hidden" as const } }
};
const form = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  checksum: checksumFor(publicPayload),
  ...publicPayload
};
const token = createInteractionToken({ formId: form.id, startedAt: nowSeconds - 2, nonce: "interaction-nonce" }, secret);

const apiForm = {
  id: form.id,
  checksum: "a".repeat(64),
  schema: {
    type: "object" as const,
    properties: { email: { type: "string" as const, format: "email" } },
    required: ["email"],
    additionalProperties: false
  },
  ui: {},
  controls: {},
  security: { honeypotField: "website", minimumInteractionMs: 3_000, maxPayloadBytes: 512 }
};

const acceptanceForm = {
  id: form.id,
  checksum: checksumFor({
    schema: {
      type: "object" as const,
      properties: {
        email: { type: "string" as const, format: "email" },
        privacyAccepted: { type: "boolean" as const, const: true },
        termsAccepted: { type: "boolean" as const, const: true }
      },
      required: ["email", "privacyAccepted", "termsAccepted"],
      additionalProperties: false
    },
    ui: {},
    controls: {
      privacyAccepted: { control: "checkbox" as const },
      termsAccepted: { control: "checkbox" as const }
    }
  }),
  schema: {
    type: "object" as const,
    properties: {
      email: { type: "string" as const, format: "email" },
      privacyAccepted: { type: "boolean" as const, const: true },
      termsAccepted: { type: "boolean" as const, const: true }
    },
    required: ["email", "privacyAccepted", "termsAccepted"],
    additionalProperties: false
  },
  ui: {},
  controls: {
    privacyAccepted: { control: "checkbox" as const },
    termsAccepted: { control: "checkbox" as const }
  }
};

function config(fetch: typeof globalThis.fetch): FormServerConfig {
  return { apiUrl: "https://app.example.fi/api", keyId: "key-id", secret, form, fetch, now: () => now };
}

describe("Qwik City submission", () => {
  it("checks honeypot, timing and unknown fields before the API call", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(submitForm({ values: { email: "a@b.fi", company_website: "spam" }, interactionToken: token }, config(fetch)))
      .resolves.toMatchObject({ ok: false, error: { code: "bot_detected" } });
    await expect(submitForm({ values: { email: "a@b.fi", extra: "no" }, interactionToken: token }, config(fetch)))
      .resolves.toMatchObject({ ok: false, error: { code: "unknown_field" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs and forwards a valid submission", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(
      { submission_id: 42, status: "received" },
      { status: 201 }
    ));
    const result = await submitForm({
      values: { email: "hello@example.fi", company_website: "" },
      interactionToken: token,
      idempotencyKey: "request-1"
    }, config(fetch));

    expect(result).toEqual({ ok: true, status: 201, data: { submission_id: 42, status: "received" } });
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-TW-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(new Headers(init?.headers).get("X-TW-Idempotency-Key")).toBe("request-1");
  });

  it("maps Laravel validation errors without exposing internals", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      code: "validation_failed",
      errors: [{ path: "/email", code: "format", message: "Tarkista sähköpostiosoite." }],
      exception: "Sensitive\\ServerException"
    }, { status: 422 }));
    const result = await submitForm({ values: { email: "hello@example.fi", company_website: "" }, interactionToken: token }, config(fetch));
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      error: { message: "Tarkista lomakkeen tiedot.", fieldErrors: [{ path: "/email" }] }
    });
    expect(JSON.stringify(result)).not.toContain("Sensitive");
  });

  it("uses generated API protections and never forwards the honeypot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(
      { submission_id: 43, status: "received" }, { status: 201 }
    ));
    const apiConfig: FormServerConfig = { ...config(fetch), form: apiForm };
    const oldToken = createInteractionToken({ formId: apiForm.id, startedAt: nowSeconds - 3, nonce: "api-nonce" }, secret);

    await expect(submitForm({ values: { email: "a@b.fi", website: "bot" }, interactionToken: oldToken }, apiConfig))
      .resolves.toMatchObject({ ok: false, error: { code: "bot_detected" } });
    await expect(submitForm({ values: { email: "a@b.fi", website: "" }, interactionToken: oldToken }, apiConfig))
      .resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ values: { email: "a@b.fi" } });

    const tooEarlyToken = createInteractionToken({ formId: apiForm.id, startedAt: nowSeconds - 2, nonce: "early-nonce" }, secret);
    await expect(submitForm({ values: { email: "a@b.fi", website: "" }, interactionToken: tooEarlyToken }, apiConfig))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_interaction" } });
    await expect(submitForm({ values: { email: "x".repeat(800), website: "" }, interactionToken: oldToken }, apiConfig))
      .resolves.toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  });

  it("matches the API interaction-token maximum age", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(
      { submission_id: 45, status: "received" }, { status: 201 }
    ));
    const atLimit = createInteractionToken({ formId: form.id, startedAt: nowSeconds - 3_600, nonce: "limit-nonce" }, secret);
    const expired = createInteractionToken({ formId: form.id, startedAt: nowSeconds - 3_601, nonce: "expired-nonce" }, secret);

    await expect(submitForm({ values: { email: "a@b.fi", company_website: "" }, interactionToken: atLimit }, config(fetch)))
      .resolves.toMatchObject({ ok: true });
    await expect(submitForm({ values: { email: "a@b.fi", company_website: "" }, interactionToken: expired }, config(fetch)))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_interaction" } });
  });

  it("rejects a missing acceptance before POST and accepts only true values server-side", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(
      { submission_id: 44, status: "received" }, { status: 201 }
    ));
    const acceptanceConfig: FormServerConfig = { ...config(fetch), form: acceptanceForm };
    const acceptanceToken = createInteractionToken({ formId: acceptanceForm.id, startedAt: nowSeconds - 2, nonce: "acceptance-nonce" }, secret);

    await expect(submitForm({
      values: { email: "hello@example.fi", privacyAccepted: false, termsAccepted: true },
      interactionToken: acceptanceToken
    }, acceptanceConfig)).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "validation_failed" }
    });
    expect(fetch).not.toHaveBeenCalled();

    await expect(submitForm({
      values: { email: "hello@example.fi", privacyAccepted: true, termsAccepted: true },
      interactionToken: acceptanceToken
    }, acceptanceConfig)).resolves.toMatchObject({ ok: true, status: 201 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
