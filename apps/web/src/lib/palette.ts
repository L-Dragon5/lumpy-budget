/**
 * The eight categorical slots, in fixed order. Assigned by identity (a category
 * keeps its color when a filter changes the set), never cycled past eight:
 * anything beyond the top seven folds into "Other".
 *
 * Validated with the dataviz palette checker against this app's own surfaces
 * (#ffffff light, #262626 dark): lightness band, chroma floor, adjacent CVD
 * separation and normal-vision floor all pass in both modes. Three light-mode
 * slots sit under 3:1 contrast, so every chart here also ships the numbers as
 * text -- a legend with values or the breakdown table beside it.
 */
export const SERIES = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)",
  "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)",
] as const;

/** Colored slots available before the tail has to fold into "Other". */
export const MAX_SERIES = SERIES.length;

/** Everything past the last slot. Never a generated hue. */
export const OTHER_COLOR = "var(--muted-foreground)";

/**
 * Slot `index`, or the "Other" grey past the end. Deliberately not modulo:
 * cycling would put the same hue on two things at once, which is the whole
 * failure the fixed order exists to prevent.
 */
export function seriesColor(index: number): string {
  return SERIES[index] ?? OTHER_COLOR;
}

export const STATUS = {
  good: "var(--good)",
  warning: "var(--warning)",
  critical: "var(--critical)",
} as const;
