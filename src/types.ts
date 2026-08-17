export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: JsonPrimitive;
  /** JSON Schema value that the property must equal when it is present. */
  const?: JsonValue;
  enum?: JsonPrimitive[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  [key: string]: unknown;
}

export interface FormJsonSchema {
  $schema?: string;
  $id?: string;
  type: "object";
  title?: string;
  description?: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface FormUiSettings {
  submitLabel?: string;
  successMessage?: string;
  formLabel?: string;
  layout?: "stack" | "grid";
}

export interface FormControlSettings {
  control?: "input" | "textarea" | "select" | "checkbox" | "hidden";
  label?: string;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search";
  rows?: number;
  order?: number;
}

export type FormControls = Record<string, FormControlSettings>;

export interface FormSecuritySettings {
  /** A client-only trap field that must be empty when submitted. */
  honeypotField?: string;
  /** Minimum time between creating the interaction token and submitting. */
  minimumInteractionMs?: number;
  /** Maximum JSON request-body size accepted by the server handler. */
  maxPayloadBytes?: number;
}

export interface GeneratedForm {
  id: string;
  checksum: string;
  schema: FormJsonSchema;
  ui: FormUiSettings;
  controls: FormControls;
  /** Normalized server-side protection settings supplied by the Forms API. */
  security?: FormSecuritySettings;
}

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export interface ValidationFailedResponse {
  code: "validation_failed";
  errors: FieldError[];
}

export interface SubmissionSuccess {
  submission_id: number;
  status: "received";
}

export interface FormApiError {
  code: string;
  message: string;
  status: number;
  fieldErrors?: FieldError[];
  retryAfter?: number;
}

export interface InteractionTokenPayload {
  formId: string;
  startedAt: number;
  nonce: string;
}

export type FormValues = Record<string, JsonPrimitive>;
