import { randomUUID } from "node:crypto";
import type { RequestHandler } from "@builder.io/qwik-city";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { safeApiError } from "./errors.js";
import { createSignedHeaders, verifyInteractionToken } from "./hmac.js";
import type { FormApiError, GeneratedForm, JsonValue, SubmissionSuccess } from "./types.js";

export interface FormServerConfig {
  apiUrl: string;
  keyId: string;
  secret: string;
  form: GeneratedForm;
  maxPayloadBytes?: number;
  honeypotField?: string;
  minimumInteractionMs?: number;
  interactionMaxAgeMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface FormSubmissionPayload {
  values: Record<string, JsonValue>;
  interactionToken: string;
  idempotencyKey?: string;
}

export type SubmissionResult =
  | { ok: true; status: 201; data: SubmissionSuccess }
  | { ok: false; status: number; error: FormApiError };

export function createQwikCityFormHandler(config: FormServerConfig): RequestHandler {
  return async (event) => {
    let payload: unknown;
    try {
      payload = await event.request.json();
    } catch {
      event.json(400, { code: "invalid_json", message: "Lomakkeen tietoja ei voitu käsitellä." });
      return;
    }

    let result: SubmissionResult;
    try {
      result = await submitForm(payload, config);
    } catch {
      result = failure(500, "submission_failed");
    }
    event.json(result.status, result.ok ? result.data : result.error);
  };
}

export async function submitForm(payload: unknown, config: FormServerConfig): Promise<SubmissionResult> {
  if (!isSubmissionPayload(payload)) return failure(400, "invalid_payload");
  let serializedPayload: string;
  try {
    serializedPayload = JSON.stringify(payload);
  } catch {
    return failure(400, "invalid_payload");
  }
  if (Buffer.byteLength(serializedPayload, "utf8") > (config.maxPayloadBytes ?? config.form.security?.maxPayloadBytes ?? 64 * 1024)) {
    return failure(400, "payload_too_large");
  }

  const honeypot = config.honeypotField ?? config.form.security?.honeypotField ?? "company_website";
  if (typeof payload.values[honeypot] === "string" && payload.values[honeypot] !== "") {
    return failure(400, "bot_detected");
  }
  const values = omitField(payload.values, honeypot);
  const allowedFields = new Set(Object.keys(config.form.schema.properties));
  const unknownField = Object.keys(values).find((field) => !allowedFields.has(field));
  if (unknownField) return failure(400, "unknown_field");

  const token = verifyInteractionToken(payload.interactionToken, config.secret);
  const now = (config.now ?? Date.now)();
  const minimumAge = config.minimumInteractionMs ?? config.form.security?.minimumInteractionMs ?? 800;
  const maximumAge = config.interactionMaxAgeMs ?? 2 * 60 * 60 * 1000;
  if (!token || token.formId !== config.form.id || token.startedAt > now - minimumAge || token.startedAt < now - maximumAge) {
    return failure(400, "invalid_interaction");
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(config.form.schema);
  if (!validate(values)) return failure(422, "validation_failed");

  const url = new URL(`/api/v1/forms/${config.form.id}/submissions`, ensureTrailingSlash(config.apiUrl));
  const requestBody = JSON.stringify({
    values,
    interaction_token: payload.interactionToken,
    schema_checksum: config.form.checksum
  });
  const idempotencyKey = payload.idempotencyKey ?? randomUUID();
  const headers = createSignedHeaders({
    method: "POST",
    url,
    body: requestBody,
    keyId: config.keyId,
    secret: config.secret,
    idempotencyKey
  });

  let response: Response;
  try {
    response = await (config.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: requestBody
    });
  } catch {
    return failure(500, "upstream_unavailable");
  }

  const responsePayload = await readJson(response);
  if (response.status === 201 && isSuccess(responsePayload)) {
    return { ok: true, status: 201, data: responsePayload };
  }

  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  return { ok: false, status: response.status, error: safeApiError(response.status, responsePayload, retryAfter) };
}

function omitField(values: Record<string, JsonValue>, field: string): Record<string, JsonValue> {
  const { [field]: _omitted, ...remaining } = values;
  return remaining;
}

function failure(status: number, code: string): SubmissionResult {
  return { ok: false, status, error: { status, code, message: status === 422 ? "Tarkista lomakkeen tiedot." : "Lomakkeen tietoja ei voitu käsitellä." } };
}

function isSubmissionPayload(value: unknown): value is FormSubmissionPayload {
  if (!value || typeof value !== "object") return false;
  const values = Reflect.get(value, "values");
  const token = Reflect.get(value, "interactionToken");
  const key = Reflect.get(value, "idempotencyKey");
  return !!values && typeof values === "object" && !Array.isArray(values) && typeof token === "string"
    && (key === undefined || typeof key === "string");
}

function isSuccess(value: unknown): value is SubmissionSuccess {
  if (!value || typeof value !== "object") return false;
  return Number.isInteger(Reflect.get(value, "submission_id")) && Reflect.get(value, "status") === "received";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export { createInteractionToken } from "./hmac.js";
export type { GeneratedForm, SubmissionSuccess } from "./types.js";
