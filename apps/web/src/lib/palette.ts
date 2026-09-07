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

export const MAX_SERIES = SERIES.length;

/** Stable color for a category: same id, same slot, whatever else is on screen. */
export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length]!;
}

export const STATUS = {
  good: "var(--good)",
  warning: "var(--warning)",
  critical: "var(--critical)",
} as const;
