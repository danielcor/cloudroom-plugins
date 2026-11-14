// A minimal Standard Schema v1 builder for the RPC contract, so the plugin
// needs no validator dependency. Every RPC input is untrusted.
import type { StandardSchemaV1 } from "@get-bb/plugin-sdk";

type Issue = { message: string; path?: (string | number)[] };
type Check<T> = (value: unknown, path: (string | number)[], issues: Issue[]) => T;

export interface Schema<T> extends StandardSchemaV1<unknown, T> {
  readonly check: Check<T>;
}

function make<T>(check: Check<T>): Schema<T> {
  return {
    check,
    "~standard": {
      version: 1,
      vendor: "snippets",
      validate(value) {
        const issues: Issue[] = [];
        const out = check(value, [], issues);
        return issues.length ? { issues } : { value: out };
      },
    },
  };
}

export const v = {
  string(opts: { max?: number; pattern?: RegExp } = {}): Schema<string> {
    return make((value, path, issues) => {
      if (typeof value !== "string") issues.push({ message: "expected a string", path });
      else if (opts.max !== undefined && value.length > opts.max) issues.push({ message: `longer than ${opts.max}`, path });
      else if (opts.pattern && !opts.pattern.test(value)) issues.push({ message: "invalid value", path });
      return value as string;
    });
  },
  int(opts: { min?: number; max?: number } = {}): Schema<number> {
    return make((value, path, issues) => {
      if (typeof value !== "number" || !Number.isInteger(value)) issues.push({ message: "expected an integer", path });
      else if ((opts.min !== undefined && value < opts.min) || (opts.max !== undefined && value > opts.max)) issues.push({ message: "out of range", path });
      return value as number;
    });
  },
  literal<const L extends string>(...values: L[]): Schema<L> {
    return make((value, path, issues) => {
      if (!values.includes(value as L)) issues.push({ message: `expected ${values.join(" | ")}`, path });
      return value as L;
    });
  },
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return make((value, path, issues) => (value === null ? null : inner.check(value, path, issues)));
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return make((value, path, issues) => (value === undefined ? undefined : inner.check(value, path, issues)));
  },
  array<T>(inner: Schema<T>, max: number): Schema<T[]> {
    return make((value, path, issues) => {
      if (!Array.isArray(value)) {
        issues.push({ message: "expected an array", path });
        return [];
      }
      if (value.length > max) issues.push({ message: `more than ${max} items`, path });
      return value.map((item, i) => inner.check(item, [...path, i], issues));
    });
  },
  object<S extends Record<string, Schema<unknown>>>(shape: S): Schema<{ [K in keyof S]: S[K] extends Schema<infer T> ? T : never }> {
    return make((value, path, issues) => {
      const out: Record<string, unknown> = {};
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ message: "expected an object", path });
        return out as never;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) if (!(key in shape)) issues.push({ message: "unknown key", path: [...path, key] });
      for (const [key, schema] of Object.entries(shape)) {
        const got = schema.check(record[key], [...path, key], issues);
        if (got !== undefined) out[key] = got;
      }
      return out as never;
    });
  },
  /** Output schemas: the host still checks the result is strict JSON. */
  json<T>(): Schema<T> {
    return make((value) => value as T);
  },
};
