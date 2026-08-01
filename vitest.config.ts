import { defineConfig } from "vitest/config";
import { qwikVite } from "@builder.io/qwik/optimizer";

export default defineConfig({
  plugins: [qwikVite()],
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true
  }
});
