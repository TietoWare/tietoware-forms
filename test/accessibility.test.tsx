import { $, type JSXNode } from "@builder.io/qwik";
import { createDOM } from "@builder.io/qwik/testing";
import { describe, expect, it, vi } from "vitest";
import { TietoWareForm, validateFormValues, type FormValues, type GeneratedForm } from "../src/index.js";
import { checksumFor } from "../src/generate.js";

const publicPayload = {
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    title: "Yhteydenotto",
    properties: {
      email: { type: "string" as const, title: "Sähköposti", format: "email" },
      message: { type: "string" as const, title: "Viesti", minLength: 2 }
    },
    required: ["email", "message"],
    additionalProperties: false
  },
  ui: { submitLabel: "Lähetä" },
  controls: { email: { autocomplete: "email" }, message: { control: "textarea" as const } }
};
const form = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  checksum: checksumFor(publicPayload),
  ...publicPayload
};

const acceptancePublicPayload = {
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: {
      privacyAccepted: {
        type: "boolean" as const,
        const: true,
        enum: [true, false]
      },
      termsAccepted: {
        type: "boolean" as const,
        const: true
      }
    },
    required: ["privacyAccepted", "termsAccepted"],
    additionalProperties: false
  },
  ui: {},
  controls: {
    privacyAccepted: { control: "checkbox" as const, label: "Tietosuojaseloste" },
    termsAccepted: { control: "checkbox" as const, label: "Käyttöehdot" }
  }
};
const acceptanceForm = {
  id: "223e4567-e89b-42d3-a456-426614174000",
  checksum: checksumFor(acceptancePublicPayload),
  ...acceptancePublicPayload
} satisfies GeneratedForm;

describe("accessible form", () => {
  it("connects visible fields to labels", async () => {
    const { screen, render } = await createDOM();
    await render(<TietoWareForm form={form} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true, data: { submission_id: 1, status: "received" as const } }))} /> as JSXNode);
    for (const input of screen.querySelectorAll("input, textarea")) {
      expect(input.id).not.toBe("");
      expect(screen.querySelector(`label[for=\"${input.id}\"]`)).not.toBeNull();
    }
  });

  it("reports errors, focuses the first field and retains entered values", async () => {
    const { screen, render, userEvent } = await createDOM();
    await render(<TietoWareForm form={form} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true, data: { submission_id: 1, status: "received" as const } }))} /> as JSXNode);

    const message = screen.querySelector("textarea") as HTMLTextAreaElement;
    message.value = "Säilyvä viesti";
    await userEvent(message, "input");
    const email = screen.querySelector("input[name=email]") as HTMLInputElement;
    const focus = vi.spyOn(email, "focus");
    const formElement = screen.querySelector("form") as HTMLFormElement;
    await userEvent(formElement, "submit");

    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(screen.querySelector("[role=alert]")).not.toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    expect(message.value).toBe("Säilyvä viesti");
  });

  it("validates required and formatted fields", () => {
    expect(validateFormValues(form, { message: "Hei" } as FormValues)).toEqual({
      email: ["Täytä tämä kenttä."]
    });
    expect(validateFormValues(form, { email: "not-email", message: "" })).toEqual({
      email: ["Tarkista kentän muoto."],
      message: ["Arvo on liian lyhyt."]
    });
  });

  it("renders the API honeypot outside the JSON Schema fields", async () => {
    const protectedForm = { ...form, security: { honeypotField: "website" } };
    const { screen, render } = await createDOM();
    await render(<TietoWareForm form={protectedForm} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true, data: { submission_id: 1, status: "received" as const } }))} /> as JSXNode);

    const honeypot = screen.querySelector("input[name=website]") as HTMLInputElement;
    expect(honeypot).not.toBeNull();
    expect(honeypot.autocomplete).toBe("off");
    expect(validateFormValues(protectedForm, { email: "hello@example.fi", message: "Hei", website: "" })).toEqual({});
  });

  it("renders a checkbox control before enum handling and validates acceptance with const", async () => {
    const { screen, render, userEvent } = await createDOM();
    await render(<TietoWareForm form={acceptanceForm} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true, data: { submission_id: 1, status: "received" as const } }))} /> as JSXNode);

    const privacy = screen.querySelector("input[name=privacyAccepted]") as HTMLInputElement;
    expect(privacy).not.toBeNull();
    expect(privacy.type).toBe("checkbox");
    expect(screen.querySelector("select[name=privacyAccepted]")).toBeFalsy();
    expect(privacy.required).toBe(true);
    expect(screen.querySelector(`label[for="${privacy.id}"]`)).not.toBeNull();

    await userEvent(screen.querySelector("form") as HTMLFormElement, "submit");

    expect(privacy.getAttribute("aria-invalid")).toBe("true");
    expect(privacy.getAttribute("aria-describedby")).toContain(`${privacy.id}-error`);
    expect(screen.querySelector(`[id="${privacy.id}-error"]`)?.textContent).toContain("Tarkista");
  });

  it("accepts true and rejects false according to the JSON Schema", () => {
    expect(validateFormValues(acceptanceForm, { privacyAccepted: false, termsAccepted: true })).toEqual({
      privacyAccepted: ["Tarkista kentän arvo."]
    });
    expect(validateFormValues(acceptanceForm, { privacyAccepted: true, termsAccepted: true })).toEqual({});
    expect(validateFormValues(acceptanceForm, {} as FormValues)).toEqual({
      privacyAccepted: ["Täytä tämä kenttä."],
      termsAccepted: ["Täytä tämä kenttä."]
    });
  });

  it("preserves enum value types and keeps field ids collision-safe", async () => {
    const selectForm = {
      id: "323e4567-e89b-42d3-a456-426614174000",
      checksum: "a".repeat(64),
      schema: {
        type: "object" as const,
        properties: {
          "a.b": { type: "number" as const, enum: [1, 2] },
          "a-b": { type: "string" as const, enum: ["one", "two"] }
        },
        required: ["a.b", "a-b"],
        additionalProperties: false
      },
      ui: {},
      controls: {}
    } satisfies GeneratedForm;
    const { screen, render } = await createDOM();
    await render(<TietoWareForm form={selectForm} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true, data: { submission_id: 1, status: "received" as const } }))} /> as JSXNode);

    const fields = screen.querySelectorAll("select");
    expect(fields).toHaveLength(2);
    const numericField = screen.querySelector('select[name="a.b"]') as HTMLSelectElement;
    expect(numericField.options[1]?.value).toBe("1");
    expect(numericField.options[2]?.value).toBe("2");
    expect(validateFormValues(selectForm, { "a.b": 2, "a-b": "one" })).toEqual({});
    expect(validateFormValues(selectForm, { "a.b": "2", "a-b": "one" })).toHaveProperty("a.b");
    expect(new Set([fields[0]?.id, fields[1]?.id]).size).toBe(2);
  });
});
