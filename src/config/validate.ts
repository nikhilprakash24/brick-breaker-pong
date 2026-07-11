/**
 * Structural validators (SPEC-3.7 §7.9) — hand-rolled predicates, no runtime
 * schema dependency. Every failure carries a path-precise message like
 *   tuning.json: physics.ball_radius: expected number in [5, 10], got "7px"
 * Validation walks the whole file and reports ALL errors, not just the first.
 */

import { DT_MS } from "./types";

export interface ValidationError {
  file: string;
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(
      "Config validation failed:\n" +
        errors.map((e) => `${e.file}: ${e.path}: ${e.message}`).join("\n"),
    );
    this.name = "ConfigError";
    this.errors = errors;
  }
}

/** A field validator: checks `value`, returns the cleaned value or records an error. */
export type FieldSpec = (
  value: unknown,
  ctx: { file: string; path: string; errors: ValidationError[] },
) => unknown;

function fail(
  ctx: { file: string; path: string; errors: ValidationError[] },
  message: string,
  value: unknown,
): undefined {
  ctx.errors.push({
    file: ctx.file,
    path: ctx.path,
    message: `${message}, got ${JSON.stringify(value)}`,
  });
  return undefined;
}

export function num(min: number, max: number): FieldSpec {
  return (v, ctx) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return fail(ctx, `expected number in [${min}, ${max}]`, v);
    }
    return v;
  };
}

export function int(min: number, max: number): FieldSpec {
  return (v, ctx) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      return fail(ctx, `expected integer in [${min}, ${max}]`, v);
    }
    return v;
  };
}

/** Duration authored in ms; converted to ticks at load (§0.6.1). */
export function ms(min = 0, max = 3_600_000): FieldSpec {
  return (v, ctx) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return fail(ctx, `expected duration in ms in [${min}, ${max}]`, v);
    }
    return Math.round(v / DT_MS);
  };
}

export const frac01: FieldSpec = num(0, 1);

export function bool(): FieldSpec {
  return (v, ctx) => (typeof v === "boolean" ? v : fail(ctx, "expected boolean", v));
}

export function enumOf<T extends string | number>(...allowed: T[]): FieldSpec {
  return (v, ctx) =>
    (allowed as unknown[]).includes(v)
      ? v
      : fail(ctx, `expected one of ${allowed.map((a) => JSON.stringify(a)).join(" | ")}`, v);
}

export function numArray(opts: {
  length?: number;
  min?: number;
  max?: number;
  monotone?: boolean;
}): FieldSpec {
  return (v, ctx) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      return fail(ctx, "expected an array of numbers", v);
    }
    const arr = v as number[];
    if (opts.length !== undefined && arr.length !== opts.length) {
      return fail(ctx, `expected exactly ${opts.length} entries`, v);
    }
    if (opts.min !== undefined && arr.some((x) => x < opts.min!)) {
      return fail(ctx, `expected every entry >= ${opts.min}`, v);
    }
    if (opts.max !== undefined && arr.some((x) => x > opts.max!)) {
      return fail(ctx, `expected every entry <= ${opts.max}`, v);
    }
    if (opts.monotone && arr.some((x, i) => i > 0 && x < (arr[i - 1] as number))) {
      return fail(ctx, "expected a monotonically non-decreasing array", v);
    }
    return arr;
  };
}

/** An object whose full key set must match the schema's (unknown or missing keys are errors). */
export interface ObjectSchema {
  [key: string]: FieldSpec | ObjectSchema;
}

export function validateObject(
  file: string,
  basePath: string,
  value: unknown,
  schema: ObjectSchema,
  errors: ValidationError[],
): Record<string, unknown> | undefined {
  const path = basePath === "" ? "(root)" : basePath;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({ file, path, message: `expected an object, got ${JSON.stringify(value)}` });
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!(key in schema)) {
      errors.push({
        file,
        path: joinPath(basePath, key),
        message: "unknown key (config keys must match the registry id set exactly)",
      });
    }
  }
  for (const key of Object.keys(schema)) {
    const childPath = joinPath(basePath, key);
    if (!(key in obj)) {
      errors.push({ file, path: childPath, message: "missing required key" });
      continue;
    }
    const spec = schema[key] as FieldSpec | ObjectSchema;
    if (typeof spec === "function") {
      out[key] = spec(obj[key], { file, path: childPath, errors });
    } else {
      out[key] = validateObject(file, childPath, obj[key], spec, errors);
    }
  }
  return out;
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}
