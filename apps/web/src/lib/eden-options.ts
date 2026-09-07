/**
 * Eden's default JSON reviver rewrites any date-shaped string into a `Date`, so
 * "2026-10-01" would arrive as a Date object while its type still says `string`.
 * The compiler cannot see that lie, and the whole app assumes YYYY-MM-DD strings
 * end to end (services/db/src/client.ts selects every DATE column as a string for
 * the same reason). Turning it off is load-bearing, not a preference.
 *
 * Guarded by eden-options.test.ts.
 */
export const EDEN_OPTIONS = { parseDate: false } as const;
