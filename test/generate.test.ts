import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { checksumFor, generateForm, renderGeneratedModule, validateSchemaResponse } from "../src/generate.js";

const formId = "123e4567-e89b-42d3-a456-426614174000";
const publicPayload = {
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: { email: { type: "string" as const, format: "email" } },
    required: ["email"],
    additionalProperties: false
  },
  ui: { submitLabel: "Lähetä" },
  controls: { email: { autocomplete: "email" } }
};
const responseBody = { id: formId, checksum: checksumFor(publicPayload), ...publicPayload };
const env = {
  TIETOWARE_FORMS_API_URL: "https://app.example.fi/api",
  TIETOWARE_FORMS_FORM_ID: formId,
  TIETOWARE_FORMS_KEY_ID: "site-key",
  TIETOWARE_FORMS_HMAC_SECRET: "secret"
};

const apiPublicPayload = {
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: {
      name: { type: "string" as const },
      email: { type: "string" as const, format: "email" },
      message: { type: "string" as const }
    },
    required: ["name", "email"],
    additionalProperties: false
  },
  ui: {
    "ui:order": ["name", "email", "message"],
    name: { "ui:placeholder": "Nimesi" },
    email: { "ui:autocomplete": "email" },
    message: { "ui:widget": "textarea", "ui:options": { rows: 6 } },
    "ui:submitButtonOptions": { submitText: "Lähetä viesti" }
  },
  controls: {
    honeypot_field: "website",
    minimum_completion_seconds: 3,
    maximum_payload_bytes: 16_384
  }
};

describe("schema generator", () => {
  it("requires all server secrets", async () => {
    await expect(generateForm({ env: {} })).rejects.toThrow("TIETOWARE_FORMS_API_URL is required");
  });

  it.each([401, 410])("fails safely for HTTP %s", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status }));
    await expect(generateForm({ env, fetch })).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects an invalid schema and unknown controls", () => {
    expect(() => validateSchemaResponse({ ...responseBody, schema: {} })).toThrow("object JSON Schema");
    expect(() => validateSchemaResponse({
      ...responseBody,
      controls: { email: { widget: "magic" } }
    })).toThrow("Unknown package feature");
  });

  it("writes deterministic public data without secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tietoware-forms-"));
    const output = join(directory, "forms.generated.ts");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(responseBody));

    const generated = await generateForm({ env, output, fetch });
    const contents = await readFile(output, "utf8");

    expect(generated.id).toBe(formId);
    expect(contents).toBe(renderGeneratedModule(responseBody));
    expect(contents).not.toContain(env.TIETOWARE_FORMS_HMAC_SECRET);
    expect(contents).not.toContain(env.TIETOWARE_FORMS_API_URL);
  });

  it("validates the original API payload and normalizes its ui:* settings", () => {
    const form = validateSchemaResponse({
      id: formId,
      checksum: checksumFor(apiPublicPayload),
      ...apiPublicPayload
    });

    expect(form.checksum).toBe(checksumFor(apiPublicPayload));
    expect(form.ui).toEqual({ submitLabel: "Lähetä viesti" });
    expect(form.controls).toEqual({
      name: { order: 0, placeholder: "Nimesi" },
      email: { order: 1, autocomplete: "email" },
      message: { order: 2, control: "textarea", rows: 6 }
    });
    expect(form.security).toEqual({ honeypotField: "website", minimumInteractionMs: 3_000, maxPayloadBytes: 16_384 });
  });

  it("rejects a tampered API payload before normalization", () => {
    expect(() => validateSchemaResponse({
      id: formId,
      checksum: checksumFor(apiPublicPayload),
      ...apiPublicPayload,
      ui: { ...apiPublicPayload.ui, "ui:order": ["email", "name", "message"] }
    })).toThrow("checksum");
  });
});
