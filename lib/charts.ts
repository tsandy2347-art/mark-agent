// lib/charts.ts — tiny dependency-free SVG chart builders for Mark's report
// pages. Server-rendered (these return SVG markup strings / React-ready prop
// sets) so a page can draw a chart with no client JS and no charting library.
//
// The JBC dark theme palette (see app/globals.css):
//   accent cyan  #22d3ee   emerald #34d399   amber #fbbf24   rose #f43f5e
//   indigo #818cf8   muted #8a96ac   grid #1f2937
//
// All amounts are AUD. Helpers round + format for the eye, never for maths.

export const CHART_COLORS = {
  cyan: "#22d3ee",
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#f43f5e",
  indigo: "#818cf8",
  muted: "#8a96ac",
  grid: "#1f2937",
  fg: "#e8eef7",
};

/** Compact AUD for axis / labels: 1_940_221 -> "$1.94M", -223_797 -> "-$224k". */
export function fmtAud(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (a >= 1_000_000) s = `$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 2)}M`;
  else if (a >= 1_000) s = `$${Math.round(a / 1_000)}k`;
  else s = `$${Math.round(a)}`;
  return neg ? `-${s}` : s;
}

/** "2026-04" -> "Apr". */
export function monthShort(ym: string): string {
  const m = Number(ym.split("-")[1]);
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] || ym;
}

export interface GroupedBarSeries {
  label: string;
  color: string;
  /** one value per category, same order/length as categories */
  values: (number | null)[];
}

/** Grouped vertical bar chart. Returns an array of positioned rects + axis
 *  ticks the page maps to <rect>/<text>. Handles negative values (bars grow
 *  down from a zero baseline). Pure geometry — no JSX here. */
export function groupedBars(opts: {
  categories: string[];
  series: GroupedBarSeries[];
  width: number;
  height: number;
  /** indices of categories to render as "faded" (e.g. arrears/partial months) */
  fadedCategories?: number[];
}) {
  const { categories, series, width, height } = opts;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const rawMax = Math.max(0, ...all);
  const rawMin = Math.min(0, ...all);
  // Pad the range a touch so bars don't kiss the frame.
  const max = rawMax === 0 && rawMin === 0 ? 1 : rawMax * 1.1;
  const min = rawMin * 1.1;
  const range = max - min || 1;
  const yOf = (v: number) => padT + plotH * (1 - (v - min) / range);
  const zeroY = yOf(0);

  const groupW = plotW / categories.length;
  const innerPad = groupW * 0.18;
  const barsPerGroup = series.length;
  const barW = (groupW - innerPad * 2) / barsPerGroup;

  const bars: Array<{
    x: number; y: number; w: number; h: number; color: string; faded: boolean;
    value: number; label: string; cat: string;
  }> = [];
  categories.forEach((cat, ci) => {
    const gx = padL + groupW * ci + innerPad;
    series.forEach((s, si) => {
      const v = s.values[ci];
      if (v == null) return;
      const y = yOf(Math.max(v, 0));
      const h = Math.abs(yOf(v) - zeroY);
      bars.push({
        x: gx + barW * si,
        y,
        w: barW * 0.86,
        h: Math.max(h, 1),
        color: s.color,
        faded: (opts.fadedCategories ?? []).includes(ci),
        value: v,
        label: s.label,
        cat,
      });
    });
  });

  // 4 horizontal gridlines + value labels.
  const ticks: Array<{ y: number; label: string; v: number }> = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = min + (range * i) / steps;
    ticks.push({ y: yOf(v), label: fmtAud(v), v });
  }

  const catLabels = categories.map((c, ci) => ({
    x: padL + groupW * ci + groupW / 2,
    label: c,
    faded: (opts.fadedCategories ?? []).includes(ci),
  }));

  return { padL, padR, padT, padB, plotW, plotH, zeroY, bars, ticks, catLabels, width, height };
}

/** Single line chart (used for the consolidated profit trend / cash runway).
 *  Returns the polyline points + dot positions + axis ticks. */
export function lineChart(opts: {
  categories: string[];
  values: (number | null)[];
  width: number;
  height: number;
  color?: string;
  fadedCategories?: number[];
}) {
  const { categories, values, width, height } = opts;
  const color = opts.color ?? CHART_COLORS.cyan;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const nums = values.filter((v): v is number => v != null);
  const rawMax = Math.max(0, ...nums);
  const rawMin = Math.min(0, ...nums);
  const max = rawMax === 0 && rawMin === 0 ? 1 : rawMax * 1.1;
  const min = rawMin < 0 ? rawMin * 1.1 : 0;
  const range = max - min || 1;
  const yOf = (v: number) => padT + plotH * (1 - (v - min) / range);
  const xOf = (i: number) =>
    padL + (categories.length === 1 ? plotW / 2 : (plotW * i) / (categories.length - 1));

  const points: Array<{ x: number; y: number; v: number; faded: boolean }> = [];
  values.forEach((v, i) => {
    if (v == null) return;
    points.push({ x: xOf(i), y: yOf(v), v, faded: (opts.fadedCategories ?? []).includes(i) });
  });
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const ticks: Array<{ y: number; label: string }> = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = min + (range * i) / steps;
    ticks.push({ y: yOf(v), label: fmtAud(v) });
  }
  const catLabels = categories.map((c, i) => ({
    x: xOf(i),
    label: c,
    faded: (opts.fadedCategories ?? []).includes(i),
  }));
  const zeroY = yOf(0);

  return { padL, padR, padT, padB, plotW, plotH, color, points, polyline, ticks, catLabels, zeroY, width, height };
}
