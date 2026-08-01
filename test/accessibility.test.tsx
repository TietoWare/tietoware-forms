import { $, type JSXNode } from "@builder.io/qwik";
import { createDOM } from "@builder.io/qwik/testing";
import { describe, expect, it, vi } from "vitest";
import { TietoWareForm, validateFormValues } from "../src/index.js";
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

describe("accessible form", () => {
  it("connects visible fields to labels", async () => {
    const { screen, render } = await createDOM();
    await render(<TietoWareForm form={form} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true }))} /> as JSXNode);
    for (const input of screen.querySelectorAll("input, textarea")) {
      expect(input.id).not.toBe("");
      expect(screen.querySelector(`label[for=\"${input.id}\"]`)).not.toBeNull();
    }
  });

  it("reports errors, focuses the first field and retains entered values", async () => {
    const { screen, render, userEvent } = await createDOM();
    await render(<TietoWareForm form={form} interactionToken="token" onSubmit$={$(() => Promise.resolve({ ok: true }))} /> as JSXNode);

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
    expect(validateFormValues(form, { email: "not-email", message: "" })).toEqual({
      email: ["Tarkista kentän muoto."],
      message: ["Arvo on liian lyhyt."]
    });
  });
});
