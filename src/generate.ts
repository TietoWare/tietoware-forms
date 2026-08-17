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
  FormSecuritySettings,
  FormUiSettings,
  GeneratedForm
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const UI_KEYS = new Set(["submitLabel", "successMessage", "formLabel", "layout"]);
const CONTROL_KEYS = new Set(["control", "label", "placeholder", "autocomplete", "inputMode", "rows", "order"]);
const CONTROL_TYPES = new Set(["input", "textarea", "select", "checkbox", "hidden"]);
const API_CONTROL_KEYS = new Set(["honeypot_field", "minimum_completion_seconds", "maximum_payload_bytes"]);
const API_WIDGET_TYPES = new Set(["text", "input", "textarea", "select", "checkbox", "hidden"]);

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

  const schemaProperties = schema.properties as Record<string, unknown>;
  const apiFormat = Object.keys(ui).some((key) => key.startsWith("ui:")
    || (Object.hasOwn(schemaProperties, key) && hasApiFieldSettings(ui[key])))
    || Object.keys(controls).some((key) => API_CONTROL_KEYS.has(key));
  if (apiFormat) return validateApiSchemaResponse({ id, checksum, schema, ui, controls });

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

/**
 * Validates the API payload before it is transformed.  The API checksum is a
 * checksum of this exact public shape, not of the package's normalized form.
 */
function validateApiSchemaResponse(value: {
  id: string;
  checksum: string;
  schema: Record<string, unknown>;
  ui: Record<string, unknown>;
  controls: Record<string, unknown>;
}): GeneratedForm {
  validateJsonSchemaProperties(value.schema);
  rejectUnknownKeys(value.controls, API_CONTROL_KEYS, "controls");
  validateApiUi(value.ui, value.schema.properties as Record<string, unknown>);
  validateApiControls(value.controls, value.schema.properties as Record<string, unknown>);

  const publicPayload = { schema: value.schema, ui: value.ui, controls: value.controls };
  if (checksumFor(publicPayload) !== value.checksum) {
    throw new Error("Schema response checksum does not match its public payload.");
  }

  return {
    id: value.id,
    checksum: value.checksum,
    schema: value.schema as unknown as FormJsonSchema,
    ...normalizeApiSettings(value.ui, value.controls)
  };
}

function validateJsonSchemaProperties(schema: Record<string, unknown>): void {
  for (const [field, property] of Object.entries(schema.properties as Record<string, unknown>)) {
    if (!isRecord(property)) throw new Error(`Schema property ${field} must be an object.`);
    if (property.type !== undefined && !["string", "number", "integer", "boolean"].includes(String(property.type))) {
      throw new Error(`Unsupported schema property type for ${field}.`);
    }
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  if (!ajv.validateSchema(schema)) throw new Error(`Invalid JSON Schema: ${ajv.errorsText(ajv.errors)}.`);
}

function validateApiUi(ui: Record<string, unknown>, properties: Record<string, unknown>): void {
  for (const [key, setting] of Object.entries(ui)) {
    if (key === "ui:order") {
      if (!Array.isArray(setting) || setting.some((field) => typeof field !== "string" || !Object.hasOwn(properties, field))) {
        throw new Error("ui.ui:order must contain only schema field names.");
      }
      continue;
    }
    if (key === "ui:submitButtonOptions") {
      if (!isRecord(setting) || Object.keys(setting).some((option) => option !== "submitText") || typeof setting.submitText !== "string") {
        throw new Error("ui.ui:submitButtonOptions must be an object.");
      }
      continue;
    }
    if (!Object.hasOwn(properties, key) || !isRecord(setting)) throw new Error(`Unknown package feature: ui.${key}.`);
    for (const [settingKey, settingValue] of Object.entries(setting)) {
      if (!["ui:placeholder", "ui:autocomplete", "ui:widget", "ui:options"].includes(settingKey)) {
        throw new Error(`Unknown package feature: ui.${key}.${settingKey}.`);
      }
      if (["ui:placeholder", "ui:autocomplete"].includes(settingKey) && typeof settingValue !== "string") {
        throw new Error(`ui.${key}.${settingKey} must be a string.`);
      }
      if (settingKey === "ui:widget" && (typeof settingValue !== "string" || !API_WIDGET_TYPES.has(settingValue))) {
        throw new Error(`ui.${key}.ui:widget is not supported by this package.`);
      }
      if (settingKey === "ui:options" && (!isRecord(settingValue)
        || Object.keys(settingValue).some((option) => option !== "rows")
        || typeof settingValue.rows !== "number"
        || !Number.isInteger(settingValue.rows)
        || settingValue.rows < 1
        || settingValue.rows > 20)) {
        throw new Error(`ui.${key}.ui:options.rows must be an integer between 1 and 20.`);
      }
    }
  }
}

function validateApiControls(controls: Record<string, unknown>, properties: Record<string, unknown>): void {
  const honeypot = controls.honeypot_field;
  if (honeypot !== undefined && (typeof honeypot !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(honeypot))) {
    throw new Error("controls.honeypot_field must be a snake_case field name.");
  }
  if (typeof honeypot === "string" && Object.hasOwn(properties, honeypot)) {
    throw new Error("controls.honeypot_field must not be a schema field.");
  }
  const minimum = controls.minimum_completion_seconds;
  if (minimum !== undefined && (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 0 || minimum > 60)) {
    throw new Error("controls.minimum_completion_seconds must be an integer between 0 and 60.");
  }
  const maximum = controls.maximum_payload_bytes;
  if (maximum !== undefined && (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1_024 || maximum > 1_048_576)) {
    throw new Error("controls.maximum_payload_bytes must be an integer between 1024 and 1048576.");
  }
}

function normalizeApiSettings(ui: Record<string, unknown>, controls: Record<string, unknown>): Pick<GeneratedForm, "ui" | "controls" | "security"> {
  const normalizedControls: FormControls = {};
  const order = Array.isArray(ui["ui:order"]) ? ui["ui:order"] : [];
  for (const [index, field] of order.entries()) normalizedControls[field as string] = { order: index };

  for (const [field, settings] of Object.entries(ui)) {
    if (!isRecord(settings) || field.startsWith("ui:")) continue;
    const control = normalizedControls[field] ?? {};
    if (typeof settings["ui:placeholder"] === "string") control.placeholder = settings["ui:placeholder"];
    if (typeof settings["ui:autocomplete"] === "string") control.autocomplete = settings["ui:autocomplete"];
    const widget = settings["ui:widget"];
    if (widget === "textarea" || widget === "select" || widget === "checkbox" || widget === "hidden") {
      control.control = widget;
    }
    const options = settings["ui:options"];
    if (isRecord(options) && typeof options.rows === "number") control.rows = options.rows;
    normalizedControls[field] = control;
  }

  const submitOptions = ui["ui:submitButtonOptions"];
  const security: FormSecuritySettings = {};
  if (typeof controls.honeypot_field === "string") security.honeypotField = controls.honeypot_field;
  if (typeof controls.minimum_completion_seconds === "number") security.minimumInteractionMs = controls.minimum_completion_seconds * 1_000;
  if (typeof controls.maximum_payload_bytes === "number") security.maxPayloadBytes = controls.maximum_payload_bytes;

  const normalized = {
    ui: isRecord(submitOptions) && typeof submitOptions.submitText === "string" ? { submitLabel: submitOptions.submitText } : {},
    controls: normalizedControls
  };
  return Object.keys(security).length > 0 ? { ...normalized, security } : normalized;
}

export function checksumFor(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Checksum payload must contain only finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Checksum payload must contain only JSON values.");
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!;
    const rightPoint = rightPoints[index]!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function hasApiFieldSettings(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((setting) => setting.startsWith("ui:"));
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
