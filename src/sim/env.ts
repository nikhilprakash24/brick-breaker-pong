/**
 * Dev-build flag usable OUTSIDE Vite/vitest too (tools/batchRunner runs the
 * sim under tsx, where import.meta.env does not exist). Vite/vitest replace
 * or provide import.meta.env; under plain node/tsx the guard yields false —
 * batch runs execute with §12.2 assertions off, tests with them on.
 */
export const IS_DEV: boolean =
  typeof import.meta.env !== "undefined" && !!import.meta.env.DEV;
