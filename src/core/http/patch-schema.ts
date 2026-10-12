import { z } from "zod";

/**
 * PATCH body from a create schema: every field optional and — unlike zod's `.partial()` —
 * WITHOUT the create defaults. (In Zod 4, `.partial()` still applies `.default()`, so a PATCH that
 * omits a field would silently reset it to its default.)
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let f = field as z.ZodType;
    while (f instanceof z.ZodDefault || f instanceof z.ZodPrefault) f = (f as unknown as { def: { innerType: z.ZodType } }).def.innerType;
    shape[key] = f.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}
