import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // Section 10.5 harness — ships with the build so the binding can be
        // demoed standalone from the deployed URL.
        bindingTest: resolve(__dirname, "binding-test.html"),
      },
    },
  },
});
