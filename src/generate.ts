import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createSignedHeaders } from "./hmac.js";
import type {
  FormControlSettings,
  FormControls,
  FormJsonSchema,
  FormUiSettings,
  GeneratedForm
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const UI_KEYS = new Set(["submitLabel", "successMessage", "formLabel", "layout"]);
const CONTROL_KEYS = new Set(["control", "label", "placeholder", "autocomplete", "inputMode", "rows", "order"]);
const CONTROL_TYPES = new Set(["input", "textarea", "select", "checkbox", "hidden"]);

export interface GenerateEnvironment {
  TIETOWARE_FORMS_API_URL?: string;
  TIETOWARE_FORMS_FORM_ID?: string;
  TIETOWARE_FORMS_KEY_ID?: string;
  TIETOWARE_FORMS_HMAC_SECRET?: string;
}

export interface GenerateOptions {
  env?: GenerateEnvironment;
  output?: string;
  fetch?: typeof globalThis.fetch;
}

export async function generateForm(options: GenerateOptions = {}): Promise<GeneratedForm> {
  const env = options.env ?? process.env;
  const apiUrl = required(env.TIETOWARE_FORMS_API_URL, "TIETOWARE_FORMS_API_URL");
  const formId = required(env.TIETOWARE_FORMS_FORM_ID, "TIETOWARE_FORMS_FORM_ID");
  const keyId = required(env.TIETOWARE_FORMS_KEY_ID, "TIETOWARE_FORMS_KEY_ID");
  const secret = required(env.TIETOWARE_FORMS_HMAC_SECRET, "TIETOWARE_FORMS_HMAC_SECRET");
  if (!UUID_PATTERN.test(formId)) throw new Error("TIETOWARE_FORMS_FORM_ID must be a valid UUID.");

  const url = new URL(`/api/v1/forms/${formId}/schema`, ensureTrailingSlash(apiUrl));
  const headers = createSignedHeaders({ method: "GET", url, keyId, secret });
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers }
  });

  if (response.status === 401) throw new Error("Schema request was rejected (HTTP 401).");
  if (response.status === 410) throw new Error("The requested form is no longer available (HTTP 410).");
  if (!response.ok) throw new Error(`Schema request failed (HTTP ${response.status}).`);

  const form = validateSchemaResponse(await readJson(response));
  if (form.id !== formId) throw new Error("Schema response form id does not match the requested form.");

  const output = resolve(options.output ?? "src/forms.generated.ts");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderGeneratedModule(form), { encoding: "utf8", mode: 0o600 });
  return form;
}

export function validateSchemaResponse(value: unknown): GeneratedForm {
  if (!isRecord(value)) throw new Error("Schema response must be a JSON object.");
  const { id, checksum, schema, ui, controls } = value;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error("Schema response contains an invalid form id.");
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) throw new Error("Schema response contains an invalid checksum.");
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error("Schema response does not contain an object JSON Schema.");
  }
  if (!isRecord(ui) || !isRecord(controls)) throw new Error("Schema response is missing ui or controls settings.");

  rejectUnknownKeys(ui, UI_KEYS, "ui");
  for (const [field, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) throw new Error(`Schema property ${field} must be an object.`);
    if (property.type !== undefined && !["string", "number", "integer", "boolean"].includes(String(property.type))) {
      throw new Error(`Unsupported schema property type for ${field}.`);
    }
  }
  for (const [field, control] of Object.entries(controls)) {
    if (!Object.hasOwn(schema.properties, field)) throw new Error(`Control references unknown schema field: ${field}.`);
    if (!isRecord(control)) throw new Error(`Control settings for ${field} must be an object.`);
    rejectUnknownKeys(control, CONTROL_KEYS, `controls.${field}`);
    if (control.control !== undefined && (typeof control.control !== "string" || !CONTROL_TYPES.has(control.control))) {
      throw new Error(`Unknown control type for ${field}.`);
    }
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  if (!ajv.validateSchema(schema)) throw new Error(`Invalid JSON Schema: ${ajv.errorsText(ajv.errors)}.`);

  const publicPayload = { schema, ui, controls };
  const calculated = checksumFor(publicPayload);
  if (calculated !== checksum) throw new Error("Schema response checksum does not match its public payload.");

  return {
    id,
    checksum,
    schema: schema as unknown as FormJsonSchema,
    ui: ui as unknown as FormUiSettings,
    controls: controls as unknown as FormControls
  };
}

export function checksumFor(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function renderGeneratedModule(form: GeneratedForm): string {
  return [
    "// Generated by @tietoware/forms. Do not edit.",
    'import type { GeneratedForm } from "@tietoware/forms";',
    "",
    `export const form = ${stableStringify(form)} as const satisfies GeneratedForm;`,
    ""
  ].join("\n");
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Schema response is not valid JSON.");
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown package feature: ${path}.${unknown}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type { FormControlSettings };
