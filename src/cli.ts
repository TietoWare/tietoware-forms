#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generateForm } from "./generate.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" }
    }
  });

  if (values.help || positionals[0] === "help") {
    process.stdout.write("Usage: tietoware-forms generate [--output <file>]\n");
    return;
  }
  if (positionals[0] !== "generate" || positionals.length !== 1) {
    throw new Error("Expected command: tietoware-forms generate");
  }

  const form = await generateForm(values.output ? { output: values.output } : {});
  process.stdout.write(`Generated form ${form.id} (${form.checksum}).\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown generator error.";
  process.stderr.write(`tietoware-forms: ${message}\n`);
  process.exitCode = 1;
});
