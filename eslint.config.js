// Lint guards (SPEC-3.13 §13.4) — these rules ENFORCE the architecture:
// determinism inside src/sim/** and the sim→presentation import boundary.
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/sim/**/*.ts"],
    rules: {
      // Determinism (§0.6.2): no wall clock or unseeded randomness in the sim.
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Sim randomness must come from seeded mulberry32 streams (sim/rng.ts).",
        },
        {
          object: "Date",
          property: "now",
          message: "No wall clock in the sim — time is the tick counter.",
        },
        {
          object: "performance",
          property: "now",
          message: "No wall clock in the sim — time is the tick counter.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/render/**",
                "**/audio/**",
                "**/ui/**",
                "**/persistence/**",
                "**/debug/**",
              ],
              message:
                "src/sim must not import presentation or persistence modules (SPEC-3.13 §13.4).",
            },
          ],
        },
      ],
    },
  },
);
