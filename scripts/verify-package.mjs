import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const forbiddenPaths = [
  /(^|\/)node_modules\//,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/).*\.generated\.ts$/,
  /(^|\/)forms\.generated\.ts$/,
  /(^|\/).*\.(?:pem|key|p12)$/
];
const forbiddenClientMarkers = [
  "node:crypto",
  "TIETOWARE_FORMS_HMAC_SECRET",
  "TIETOWARE_FORMS_KEY_ID",
  "createSignedHeaders",
  "verifyInteractionToken",
  "./server.js",
  "./hmac.js"
];

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32"
}));
const files = packed[0]?.files?.map((file) => file.path) ?? [];
const forbidden = files.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file)));
if (forbidden.length > 0) throw new Error(`Forbidden package files: ${forbidden.join(", ")}`);

const client = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
const leaked = forbiddenClientMarkers.filter((marker) => client.includes(marker));
if (leaked.length > 0) throw new Error(`Client bundle contains server-only markers: ${leaked.join(", ")}`);

process.stdout.write(`Package contains ${files.length} reviewed files; client/server boundary is clean.\n`);
