// Config mínima ESLint v9 (flat config) — `npm run lint` estaba roto sin esto
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "server.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        // Lo usa emailService para ponerle tope de tiempo a la llamada a Resend.
        AbortSignal: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^next$|^req$|^res$" }],
      "no-undef": "error",
    },
  },
];
