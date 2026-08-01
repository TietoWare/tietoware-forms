# `@tietoware/forms`

Schema-driven, accessible Qwik City forms for TietoWare App. The package keeps browser-safe rendering separate from HMAC-signed server communication.

## Requirements

- Node.js 20 or newer
- Qwik and Qwik City 1.8 or newer
- A TietoWare App form and integration key
- A GitHub token with `read:packages` for installation

## Install

Add the registry to the consuming project's `.npmrc`:

```ini
@tietoware:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_READ_TOKEN}
```

Then install the package:

```bash
npm install @tietoware/forms
```

## Generate the form artifact

Set the following values in the server or CI environment. Never prefix them with `PUBLIC_` and never expose them through Qwik's client environment.

```text
TIETOWARE_FORMS_API_URL=https://app.example.fi/api
TIETOWARE_FORMS_FORM_ID=123e4567-e89b-42d3-a456-426614174000
TIETOWARE_FORMS_KEY_ID=<integration-key-id>
TIETOWARE_FORMS_HMAC_SECRET=<secret>
```

Fetch the schema during the consuming site's build:

```bash
npx tietoware-forms generate --output src/forms.generated.ts
```

The generator validates the UUID, JSON Schema Draft 2020-12 document, supported UI controls and a SHA-256 checksum of the canonical public payload. The checksum input is the stable, recursively key-sorted JSON representation of `{ schema, ui, controls }`.

The generated file contains only the form id, checksum, schema, UI settings and controls. It never contains the API URL, key id, HMAC secret or other environment values.

## Render in Qwik

```tsx
import { component$, $ } from "@builder.io/qwik";
import { TietoWareForm } from "@tietoware/forms";
import { form } from "~/forms.generated";

export default component$(() => {
  const submit = $(async (values, interactionToken) => {
    const response = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, interactionToken })
    });
    const payload = await response.json();
    return response.ok ? { ok: true, data: payload } : { ok: false, error: payload };
  });

  return <TietoWareForm form={form} interactionToken="server-created-token" onSubmit$={submit} />;
});
```

Create the interaction token on the server and pass it into the rendered route. Do not create or sign it in browser code.

## Qwik City endpoint

```ts
import type { RequestHandler } from "@builder.io/qwik-city";
import { createQwikCityFormHandler } from "@tietoware/forms/server";
import { form } from "~/forms.generated";

const handler = createQwikCityFormHandler({
  apiUrl: process.env.TIETOWARE_FORMS_API_URL!,
  keyId: process.env.TIETOWARE_FORMS_KEY_ID!,
  secret: process.env.TIETOWARE_FORMS_HMAC_SECRET!,
  form
});

export const onPost: RequestHandler = handler;
```

`createQwikCityFormHandler` enforces a 64 KiB default payload limit, rejects unknown fields, checks the honeypot and signed interaction token, validates with Ajv, and only then sends an HMAC-signed request to TietoWare App. Limits can be tightened with the server configuration.

Create the initial token from server-only code:

```ts
import { randomUUID } from "node:crypto";
import { createInteractionToken } from "@tietoware/forms/server";

const token = createInteractionToken({
  formId: form.id,
  startedAt: Date.now(),
  nonce: randomUUID()
}, process.env.TIETOWARE_FORMS_HMAC_SECRET!);
```

## HMAC contract

The canonical request is five UTF-8 lines separated by one LF:

```text
UPPERCASE_METHOD
NORMALIZED_PATH_AND_SORTED_QUERY
UNIX_TIMESTAMP
NONCE
SHA256_OF_EXACT_UTF8_REQUEST_BODY
```

Query keys and values use RFC 3986 encoding and are sorted by encoded key and then encoded value. The signature is lowercase HMAC-SHA256 hex. Shared language-neutral vectors live in `test/fixtures/hmac-vectors.json` and must be copied unchanged into the Laravel contract tests.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

`pack:check` also verifies that the browser entry does not import Node crypto, HMAC logic, server exports or secret environment names.

## Release

1. Update `version` using semantic versioning.
2. Merge a commit that passes CI.
3. Create and push a cryptographically signed annotated tag matching the version, for example `v0.1.0`.
4. The release workflow verifies the tag, repeats all checks, attests the tarball and publishes it to GitHub Packages.

Published versions are immutable. A form schema change does not require a package release, but it does require rebuilding the consuming Qwik City site so its generated artifact is refreshed.

## Security

See [SECURITY.md](SECURITY.md). Do not place production keys, `.env` files, generated customer schemas or submission data in issues, tests or commits.
