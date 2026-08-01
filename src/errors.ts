import type { FieldError, FormApiError } from "./types.js";

const SAFE_MESSAGES: Record<number, string> = {
  400: "Lomakkeen tietoja ei voitu käsitellä.",
  401: "Lomakkeen yhteys ei ole käytettävissä.",
  409: "Lähetys on jo vastaanotettu.",
  410: "Lomake ei ole enää käytettävissä.",
  422: "Tarkista lomakkeen tiedot.",
  429: "Lähetyksiä on tehty liian nopeasti. Yritä hetken kuluttua.",
  500: "Lähetys epäonnistui. Yritä myöhemmin uudelleen."
};

export function jsonPointerToField(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;

  const firstSegment = path.slice(1).split("/", 1)[0];
  if (!firstSegment) return undefined;

  return firstSegment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function groupFieldErrors(errors: FieldError[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};

  for (const error of errors) {
    const field = jsonPointerToField(error.path);
    if (!field) continue;
    (grouped[field] ??= []).push(error.message);
  }

  return grouped;
}

export function safeApiError(status: number, payload?: unknown, retryAfter?: number): FormApiError {
  const fieldErrors = readFieldErrors(payload);
  const code = readCode(payload) ?? statusCode(status);

  return {
    code,
    message: SAFE_MESSAGES[status] ?? SAFE_MESSAGES[500]!,
    status,
    ...(fieldErrors.length > 0 ? { fieldErrors } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {})
  };
}

function readCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = Reflect.get(payload, "code");
  return typeof code === "string" && /^[a-z0-9_]+$/.test(code) ? code : undefined;
}

function readFieldErrors(payload: unknown): FieldError[] {
  if (!payload || typeof payload !== "object") return [];
  const errors = Reflect.get(payload, "errors");
  if (!Array.isArray(errors)) return [];

  return errors.flatMap((item): FieldError[] => {
    if (!item || typeof item !== "object") return [];
    const path = Reflect.get(item, "path");
    const code = Reflect.get(item, "code");
    const message = Reflect.get(item, "message");
    return typeof path === "string" && typeof code === "string" && typeof message === "string"
      ? [{ path, code, message }]
      : [];
  });
}

function statusCode(status: number): string {
  return status === 401 ? "unauthorized"
    : status === 409 ? "duplicate_submission"
    : status === 410 ? "form_gone"
    : status === 422 ? "validation_failed"
    : status === 429 ? "rate_limited"
    : "submission_failed";
}
