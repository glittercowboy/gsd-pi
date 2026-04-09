/**
 * Shared input-validation primitives for GSD tool handlers.
 */

/** Type guard: value is a string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate that `value` is an array of non-empty strings.
 * Throws with a message referencing `field` on failure.
 * Returns the validated array (narrowed to string[]).
 */
export function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.some((item) => !isNonEmptyString(item))) {
    throw new Error(`${field} must contain only non-empty strings`);
  }
  return value;
}
