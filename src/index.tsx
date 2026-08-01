import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  $,
  component$,
  useSignal,
  useStore,
  type QRL
} from "@builder.io/qwik";
import type {
  FieldError,
  FormApiError,
  FormControlSettings,
  FormValues,
  GeneratedForm,
  JsonPrimitive,
  SubmissionSuccess
} from "./types.js";

export interface ClientSubmissionResult {
  ok: boolean;
  data?: SubmissionSuccess;
  error?: FormApiError;
}

export interface TietoWareFormProps {
  form: GeneratedForm;
  interactionToken: string;
  onSubmit$: QRL<(values: FormValues, interactionToken: string) => Promise<ClientSubmissionResult>>;
  initialValues?: FormValues;
  class?: string;
}

export const TietoWareForm = component$<TietoWareFormProps>((props) => {
  const state = useStore({
    values: initialFormValues(props.form, props.initialValues),
    errors: {} as Record<string, string[]>,
    generalError: "",
    succeeded: false
  });
  const submitting = useSignal(false);
  const formId = `tw-form-${safeId(props.form.id)}`;

  const submit = $(async (_event: SubmitEvent, formElement: HTMLFormElement) => {
    state.generalError = "";
    state.succeeded = false;
    state.errors = validateFormValues(props.form, state.values);

    const firstInvalid = Object.keys(state.errors)[0];
    if (firstInvalid) {
      focusField(formElement, formId, firstInvalid);
      return;
    }

    submitting.value = true;
    try {
      const result = await props.onSubmit$({ ...state.values }, props.interactionToken);
      if (result.ok) {
        state.succeeded = true;
        return;
      }

      state.generalError = result.error?.message ?? "Lähetys epäonnistui. Yritä myöhemmin uudelleen.";
      state.errors = groupErrors(result.error?.fieldErrors ?? []);
      const firstServerInvalid = Object.keys(state.errors)[0];
      if (firstServerInvalid) focusField(formElement, formId, firstServerInvalid);
    } catch {
      state.generalError = "Lähetys epäonnistui. Yritä myöhemmin uudelleen.";
    } finally {
      submitting.value = false;
    }
  });

  const fields = orderedFields(props.form);

  return (
    <form
      id={formId}
      class={props.class}
      aria-label={props.form.ui.formLabel ?? props.form.schema.title ?? "Yhteydenottolomake"}
      noValidate
      preventdefault:submit
      onSubmit$={submit}
      data-layout={props.form.ui.layout ?? "stack"}
    >
      {fields.map(([name, property]) => {
        const control = props.form.controls[name] ?? {};
        const errors = state.errors[name] ?? [];
        const inputId = `${formId}-${safeId(name)}`;
        const errorId = `${inputId}-error`;
        const required = props.form.schema.required?.includes(name) ?? false;
        const value = state.values[name];

        if (control.control === "hidden") {
          return (
            <input
              key={name}
              id={inputId}
              name={name}
              type="hidden"
              value={stringValue(value)}
              onInput$={(_, element) => { state.values[name] = element.value; }}
            />
          );
        }

        return (
          <div key={name} class="tw-form__field" data-field={name}>
            <label for={inputId}>
              {control.label ?? property.title ?? name}
              {required ? <span aria-hidden="true"> *</span> : null}
            </label>
            {property.description ? <p id={`${inputId}-description`}>{property.description}</p> : null}
            <FormControl
              id={inputId}
              name={name}
              property={property}
              control={control}
              value={value}
              required={required}
              invalid={errors.length > 0}
              describedBy={[
                property.description ? `${inputId}-description` : "",
                errors.length > 0 ? errorId : ""
              ].filter(Boolean).join(" ") || undefined}
              onValue$={$((next: JsonPrimitive) => { state.values[name] = next; })}
            />
            {errors.length > 0 ? (
              <div id={errorId} role="alert" class="tw-form__error">
                {errors.join(" ")}
              </div>
            ) : null}
          </div>
        );
      })}

      {state.generalError ? <div role="alert" class="tw-form__error">{state.generalError}</div> : null}
      {state.succeeded ? <div role="status">{props.form.ui.successMessage ?? "Kiitos, viestisi on vastaanotettu."}</div> : null}
      <button type="submit" disabled={submitting.value}>
        {submitting.value ? "Lähetetään…" : (props.form.ui.submitLabel ?? "Lähetä")}
      </button>
    </form>
  );
});

interface FormControlProps {
  id: string;
  name: string;
  property: GeneratedForm["schema"]["properties"][string];
  control: FormControlSettings;
  value: JsonPrimitive | undefined;
  required: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  onValue$: QRL<(value: JsonPrimitive) => void>;
}

const FormControl = component$<FormControlProps>((props) => {
  const common = {
    id: props.id,
    name: props.name,
    required: props.required,
    "aria-invalid": props.invalid ? "true" as const : "false" as const,
    ...(props.describedBy ? { "aria-describedby": props.describedBy } : {}),
    ...(props.control.autocomplete ? { autocomplete: props.control.autocomplete as never } : {}),
    ...(props.control.placeholder ? { placeholder: props.control.placeholder } : {})
  };

  if (props.control.control === "textarea") {
    return (
      <textarea
        {...common}
        rows={props.control.rows ?? 5}
        value={stringValue(props.value)}
        onInput$={(_, element) => props.onValue$(element.value)}
      />
    );
  }

  if (props.control.control === "select" || props.property.enum) {
    return (
      <select {...common} value={stringValue(props.value)} onInput$={(_, element) => props.onValue$(element.value)}>
        <option value="">Valitse</option>
        {(props.property.enum ?? []).map((option) => (
          <option key={String(option)} value={String(option)}>{String(option)}</option>
        ))}
      </select>
    );
  }

  if (props.control.control === "checkbox" || props.property.type === "boolean") {
    return (
      <input
        {...common}
        type="checkbox"
        checked={props.value === true}
        onInput$={(_, element) => props.onValue$(element.checked)}
      />
    );
  }

  return (
    <input
      {...common}
      type={inputType(props.property.format, props.property.type)}
      {...(props.control.inputMode ? { inputMode: props.control.inputMode } : {})}
      value={stringValue(props.value)}
      onInput$={(_, element) => props.onValue$(coerceValue(element.value, props.property.type))}
    />
  );
});

export function validateFormValues(form: GeneratedForm, values: FormValues): Record<string, string[]> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(form.schema);
  validate(values);
  return groupAjvErrors(validate.errors ?? []);
}

function groupAjvErrors(errors: ErrorObject[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const error of errors) {
    const requiredField = error.keyword === "required" && isRecord(error.params)
      ? error.params.missingProperty
      : undefined;
    const field = typeof requiredField === "string"
      ? requiredField
      : error.instancePath.replace(/^\//, "").split("/")[0];
    if (!field) continue;
    (grouped[field] ??= []).push(validationMessage(error));
  }
  return grouped;
}

function validationMessage(error: ErrorObject): string {
  if (error.keyword === "required") return "Täytä tämä kenttä.";
  if (error.keyword === "format") return "Tarkista kentän muoto.";
  if (error.keyword === "minLength") return "Arvo on liian lyhyt.";
  if (error.keyword === "maxLength") return "Arvo on liian pitkä.";
  return "Tarkista kentän arvo.";
}

function groupErrors(errors: FieldError[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const error of errors) {
    const field = error.path.replace(/^\//, "").split("/")[0]?.replace(/~1/g, "/").replace(/~0/g, "~");
    if (field) (grouped[field] ??= []).push(error.message);
  }
  return grouped;
}

function orderedFields(form: GeneratedForm) {
  return Object.entries(form.schema.properties).sort(([nameA], [nameB]) =>
    (form.controls[nameA]?.order ?? Number.MAX_SAFE_INTEGER) - (form.controls[nameB]?.order ?? Number.MAX_SAFE_INTEGER)
      || nameA.localeCompare(nameB)
  );
}

function initialFormValues(form: GeneratedForm, initial: FormValues | undefined): FormValues {
  return Object.fromEntries(Object.entries(form.schema.properties).map(([name, property]) => [
    name,
    initial?.[name] ?? property.default ?? (property.type === "boolean" ? false : "")
  ]));
}

function inputType(format: string | undefined, type: string | undefined): string {
  if (format === "email") return "email";
  if (format === "uri") return "url";
  if (type === "number" || type === "integer") return "number";
  return "text";
}

function coerceValue(value: string, type: string | undefined): JsonPrimitive {
  if ((type === "number" || type === "integer") && value !== "") return Number(value);
  return value;
}

function stringValue(value: JsonPrimitive | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function focusField(formElement: Pick<HTMLElement, "ownerDocument">, formId: string, field: string): void {
  const element = formElement.ownerDocument.getElementById(`${formId}-${safeId(field)}`);
  element?.focus();
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type {
  FieldError,
  FormApiError,
  FormControlSettings,
  FormControls,
  FormJsonSchema,
  FormUiSettings,
  FormValues,
  GeneratedForm,
  SubmissionSuccess
} from "./types.js";
