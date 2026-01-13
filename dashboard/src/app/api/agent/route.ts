// ✅ UPDATED FILE: app/api/agent/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type BarWidget = {
  id: string;
  title: string;
  note?: string;
  type: "bar";
  value_type?: "currency" | "count";
  data: { location_name: string; sales_cents: number }[];
};

type TableWidget = {
  id: string;
  title: string;
  note?: string;
  type: "table";
  value_type?: "currency" | "count";
  data: { normalized_name: string; sales_cents: number }[];
};

type LineWidget = {
  id: string;
  title: string;
  note?: string;
  type: "line";
  data:
    | { hour: number; sales_cents: number }[]
    | { date: string; sales_cents: number }[];
};

type PieWidget = {
  id: string;
  title: string;
  note?: string;
  type: "pie";
  data: { channel: string; sales_cents: number }[];
};

type MetricWidget = {
  id: string;
  type: "metric";
  title: string;
  value: number; // cents for currency, raw count for count
  value_type: "currency" | "count";
  note?: string;
};

type Widget = BarWidget | TableWidget | LineWidget | PieWidget | MetricWidget;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Metric = "sales" | "revenue";

/**
 * ✅ Use enriched view for deterministic channel/is_takeout/is_doordash
 */
const ORDERS_VIEW = "v_orders_enriched";

/**
 * ✅ Preprocess helper: converts null -> undefined so "optional" fields won't fail Zod
 */
const nullToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const IntentEnum = z.enum([
  "comparison",
  "trend",
  "breakdown",
  "ranking",
  "single_value",
]);

const RecommendedWidgetEnum = z.enum(["bar", "line", "pie", "table", "metric"]);

const QueryIdEnum = z.enum([
  "metric_total",
  "sales_by_location",
  "top_items",
  "hourly_sales",
  "daily_sales",
  "delivery_vs_dinein",
  "doordash_revenue",
  "takeout_orders_by_location",
]);

const PlanSchema = z.object({
  assistant_message: z.string().min(1),
  clarify_question: nullToUndefined(z.string()).optional(),

  // ✅ explicit “agentic” fields
  intent: nullToUndefined(IntentEnum).optional(),
  recommended_widget: nullToUndefined(RecommendedWidgetEnum).optional(),

  actions: z
    .array(
      z
        .object({
          // ✅ query_id is optional (LLM can omit it)
          query_id: nullToUndefined(QueryIdEnum).optional(),

          // ✅ action-level intent/widget (preferred)
          intent: nullToUndefined(IntentEnum).optional(),
          recommended_widget: nullToUndefined(RecommendedWidgetEnum).optional(),

          title: nullToUndefined(z.string()).optional(),
          note: nullToUndefined(z.string()).optional(),
          params: nullToUndefined(
            z.object({
              metric: nullToUndefined(z.enum(["sales", "revenue"])).optional(),
              location: nullToUndefined(z.string()).optional(),
              locations: nullToUndefined(z.array(z.string()).max(5)).optional(),
              order_date: nullToUndefined(z.string()).optional(),

              // ✅ NEW: date range for daily trends
              start_date: nullToUndefined(z.string()).optional(),
              end_date: nullToUndefined(z.string()).optional(),

              limit: nullToUndefined(
                z.number().int().min(1).max(50)
              ).optional(),
            })
          ).optional(),
        })
        .refine((a) => !!a.query_id || !!a.recommended_widget, {
          message: "Each action must include query_id or recommended_widget.",
        })
    )
    .max(5)
    .default([]),
});

type PlanAction = z.infer<typeof PlanSchema>["actions"][number];

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match?.[0]) return JSON.parse(match[0]);
    throw new Error("Model returned non-JSON");
  }
}

function cleanStr(x: unknown): string {
  return String(x ?? "").trim();
}

function canonicalISODate(input: unknown): string | null {
  const raw = cleanStr(input);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function cleanNote(input: unknown): string | undefined {
  const s = typeof input === "string" ? input.trim() : "";
  return s ? s : undefined;
}

function metricHintFromQuery(userQuery: string): Metric {
  const q = userQuery.toLowerCase();
  if (
    q.includes("revenue") ||
    q.includes("gross") ||
    q.includes("total charged") ||
    q.includes("total amount") ||
    q.includes("including tax") ||
    q.includes("incl tax") ||
    q.includes("including fees") ||
    q.includes("incl fees") ||
    q.includes("total")
  ) {
    return "revenue";
  }
  return "sales";
}

function detectLocationsInQuery(userQuery: string, knownLocations: string[]) {
  const q = userQuery.toLowerCase();
  const hits: string[] = [];

  for (const loc of knownLocations) {
    const l = loc.toLowerCase();
    if (l && q.includes(l)) hits.push(loc);
  }

  return Array.from(new Set(hits)).slice(0, 5);
}

/**
 * Month map (deterministic date parsing)
 */
const monthMap: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function parseMonthDayFromText(
  text: string
): { month: string; day: string } | null {
  const t = text.toLowerCase();

  const m1 = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s,/-]*(\d{1,2})(?:st|nd|rd|th)?\b/i
  );
  if (m1) {
    const mon = monthMap[m1[1].toLowerCase()];
    const day = pad2(Number(m1[2]));
    if (mon && Number(day) >= 1 && Number(day) <= 31)
      return { month: mon, day };
  }

  const m2 = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?[\s,/-]*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i
  );
  if (m2) {
    const mon = monthMap[m2[2].toLowerCase()];
    const day = pad2(Number(m2[1]));
    if (mon && Number(day) >= 1 && Number(day) <= 31)
      return { month: mon, day };
  }

  return null;
}

function inferISODateFromUserText(userText: string): string | null {
  const md = parseMonthDayFromText(userText);
  if (!md) return null;
  return `2025-${md.month}-${md.day}`;
}

/** -------------------------------
 * ✅ Relative date helpers (yesterday/today)
 * ------------------------------*/
function isoToDate(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function dateToISO(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = pad2(dt.getUTCMonth() + 1);
  const d = pad2(dt.getUTCDate());
  return `${y}-${m}-${d}`;
}

function addDaysISO(iso: string, deltaDays: number): string | null {
  const dt = isoToDate(iso);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dateToISO(dt);
}

function resolveRelativeOrderDate(
  userQuery: string,
  maxDate: string | null
): string | null {
  const q = userQuery.toLowerCase();
  if (!maxDate) return null;

  if (q.includes("yesterday")) return addDaysISO(maxDate, -1);
  if (q.includes("today")) return maxDate;

  return null;
}

/** -------------------------------
 * ✅ Graph-like query detection (force line charts)
 * ------------------------------*/
function isGraphLikeQuery(q: string) {
  const t = q.toLowerCase();
  return (
    t.includes("graph") ||
    t.includes("chart") ||
    t.includes("plot") ||
    t.includes("trend") ||
    t.includes("over time") ||
    t.includes("daily")
  );
}

function hasFirstWeekPhrase(q: string) {
  const t = q.toLowerCase();
  return t.includes("first week") || t.includes("week 1");
}

/** -------------------------------
 * Answer-first summaries helpers
 * ------------------------------*/
function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatValue(value: number, valueType: "currency" | "count") {
  if (valueType === "count") return `${Math.round(value)}`;
  return dollars(value);
}

function formatPct(n: number) {
  if (!Number.isFinite(n)) return "";
  return `${(n * 100).toFixed(1)}%`;
}

function sum(values: number[]) {
  return values.reduce((a, b) => a + b, 0);
}

function buildAnswerFirstSummaries(widgets: Widget[]): string {
  const lines: string[] = [];

  for (const w of widgets) {
    if (w.type === "metric") {
      lines.push(
        `• ${w.title}: ${formatValue(w.value, w.value_type)}${
          w.note ? ` (${w.note})` : ""
        }.`
      );
      continue;
    }

    const valueType: "currency" | "count" =
      (w.type === "bar" && (w.value_type ?? "currency")) ||
      (w.type === "table" && (w.value_type ?? "currency")) ||
      (w.type === "line" ? "currency" : "currency");

    if (w.type === "bar") {
      const values = w.data.map((d) => Number(d.sales_cents ?? 0));
      const total = sum(values);
      if (total <= 0) continue;

      const top = w.data.reduce((best, cur) =>
        Number(cur.sales_cents ?? 0) > Number(best.sales_cents ?? 0)
          ? cur
          : best
      );

      const topVal = Number(top.sales_cents ?? 0);
      const pct = topVal / total;

      lines.push(
        `• ${w.title}: Total ${formatValue(total, valueType)}. Top: ${
          top.location_name
        } (${formatValue(topVal, valueType)}, ${formatPct(pct)}).`
      );
      continue;
    }

    if (w.type === "pie") {
      const values = w.data.map((d) => Number(d.sales_cents ?? 0));
      const total = sum(values);
      if (total <= 0) continue;

      const top = w.data.reduce((best, cur) =>
        Number(cur.sales_cents ?? 0) > Number(best.sales_cents ?? 0)
          ? cur
          : best
      );

      const topVal = Number(top.sales_cents ?? 0);
      const pct = topVal / total;

      lines.push(
        `• ${w.title}: Total ${formatValue(total, "currency")}. Largest: ${
          top.channel
        } (${formatValue(topVal, "currency")}, ${formatPct(pct)}).`
      );
      continue;
    }

    if (w.type === "table") {
      const values = w.data.map((d) => Number(d.sales_cents ?? 0));
      const total = sum(values);
      if (total <= 0) continue;

      const top = w.data.reduce((best, cur) =>
        Number(cur.sales_cents ?? 0) > Number(best.sales_cents ?? 0)
          ? cur
          : best
      );

      const topVal = Number(top.sales_cents ?? 0);
      const pct = topVal / total;

      const vt: "currency" | "count" = w.value_type ?? "currency";

      lines.push(
        `• ${w.title}: Total ${formatValue(total, vt)}. Top: ${
          top.normalized_name
        } (${formatValue(topVal, vt)}, ${formatPct(pct)}).`
      );
      continue;
    }

    if (w.type === "line") {
      const values = (w.data as any[]).map((p) => Number(p.sales_cents ?? 0));
      const total = sum(values);
      if (total <= 0) continue;

      const topPoint = (w.data as any[]).reduce((best, cur) =>
        Number(cur.sales_cents ?? 0) > Number(best.sales_cents ?? 0)
          ? cur
          : best
      );

      const topVal = Number(topPoint.sales_cents ?? 0);
      const pct = topVal / total;

      if ("hour" in topPoint) {
        const hr = Number(topPoint.hour);
        const label = Number.isFinite(hr) ? `${hr}:00` : "peak hour";
        lines.push(
          `• ${w.title}: Total ${formatValue(
            total,
            "currency"
          )}. Peak: ${label} (${formatValue(topVal, "currency")}, ${formatPct(
            pct
          )}).`
        );
      } else if ("date" in topPoint) {
        lines.push(
          `• ${w.title}: Total ${formatValue(total, "currency")}. Peak: ${
            topPoint.date
          } (${formatValue(topVal, "currency")}, ${formatPct(pct)}).`
        );
      }
      continue;
    }
  }

  if (!lines.length) return "";
  return `\n\nSummary\n${lines.join("\n")}`;
}

async function getKnownLocationsAndRange(): Promise<{
  knownLocations: string[];
  minDate: string | null;
  maxDate: string | null;
}> {
  const { data, error } = await supabaseServer
    .from(ORDERS_VIEW)
    .select("location, order_date");

  if (error) return { knownLocations: [], minDate: null, maxDate: null };

  const locSet = new Set<string>();
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const r of (data ?? []) as any[]) {
    const loc = cleanStr(r.location);
    const d = cleanStr(r.order_date);

    if (loc) locSet.add(loc);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  return { knownLocations: Array.from(locSet), minDate, maxDate };
}

function buildPlannerPrompt(args: {
  userQuery: string;
  clarification?: string | null;
  knownLocations: string[];
  detectedLocations: string[];
  metricHint: Metric;
  minDate: string | null;
  maxDate: string | null;
  inferredIsoDate: string | null;
}) {
  const {
    userQuery,
    clarification,
    knownLocations,
    detectedLocations,
    metricHint,
    minDate,
    maxDate,
    inferredIsoDate,
  } = args;

  return `
You are an analytics agent for a restaurant dashboard.
Return ONLY valid JSON. No markdown. No commentary.

CRITICAL JSON RULE:
- NEVER output null. If a field is unknown / not needed, OMIT it.

Sales vs Revenue definition (IMPORTANT):
- "sales" = item_sales_cents (net sales: pre-tax, before tip/fees)
- "revenue" = total_cents (gross: total charged including tax/tip/fees)

Clarification handling (IMPORTANT):
- Sometimes you previously asked a question. If "clarification" is provided, treat it as the user's answer.
- If clarification is "All", "All locations", "Overall", or "Everything", then DO NOT filter to a single location (i.e., no params.location).

Known locations (prefer these exact spellings): ${JSON.stringify(
    knownLocations
  )}
Detected locations mentioned: ${JSON.stringify(detectedLocations)}
Preferred metric from wording: ${metricHint}

Data date range available: ${minDate ?? "unknown"} to ${
    maxDate ?? "unknown"
  } (inclusive).

Date parsing hint:
- Inferred ISO date from the user's text (if any): ${inferredIsoDate ?? "null"}

✅ AGENTIC OUTPUT (REQUIRED):
For each action, output:
- intent: comparison | trend | breakdown | ranking | single_value
- recommended_widget: bar | line | pie | table | metric

You MAY omit query_id. The server will map (intent + recommended_widget + params) to the correct query.

Mapping guidance:
- recommended_widget=metric => single number total (use metric_total)
- bar => by-location comparisons/rankings (sales_by_location OR takeout_orders_by_location OR doordash_revenue)
- line => time trends (hourly_sales when order_date is set; else daily_sales)
- pie => channel breakdown (delivery_vs_dinein)
- table => top items (top_items)

✅ REQUIRED BEHAVIOR FOR SINGLE-DAY QUESTIONS (IMPORTANT):
If the user asks for a SPECIFIC DAY total (examples: "Revenue yesterday", "Sales on Jan 3rd", "Revenue for 2025-01-03"):
You MUST return TWO actions:
1) A metric card total:
   - intent="single_value"
   - recommended_widget="metric"
   - include params.order_date=YYYY-MM-DD (resolve "yesterday" to latest-1 day)
2) An hourly breakdown for the SAME day:
   - intent="breakdown"
   - recommended_widget="line"
   - include params.order_date=YYYY-MM-DD

This applies even if the user only asked for one number. The UI must show BOTH: metric + hourly line.

For daily trend windows (optional):
- You can include params.start_date and params.end_date (YYYY-MM-DD) when the user asks for a range (e.g., "first week").

If user asks for a date outside available range, ask EXACTLY ONE clarification question and mention the available range.

Return JSON of this exact shape:
{
  "assistant_message": "short helpful sentence",
  "clarify_question": "optional - ask exactly one question",
  "intent": "optional top-level intent",
  "recommended_widget": "optional top-level widget",
  "actions": [
    {
      "intent": "comparison|trend|breakdown|ranking|single_value",
      "recommended_widget": "bar|line|pie|table|metric",
      "query_id": "optional",
      "title": "optional widget title",
      "note": "optional note",
      "params": {
        "metric": "sales" | "revenue",
        "location": "optional location",
        "locations": ["optional","list"],
        "order_date": "optional YYYY-MM-DD",
        "start_date": "optional YYYY-MM-DD",
        "end_date": "optional YYYY-MM-DD",
        "limit": 10
      }
    }
  ]
}

User query: ${JSON.stringify(userQuery)}
Clarification (if any): ${JSON.stringify(clarification ?? "")}
`.trim();
}

function metricToColumn(metric: Metric) {
  return metric === "revenue" ? "total_cents" : "item_sales_cents";
}

/** -------------------------------
 * ✅ map (intent + recommended_widget) -> query_id
 * ------------------------------*/
function expectedWidgetFromQueryId(
  queryId: z.infer<typeof QueryIdEnum>
): z.infer<typeof RecommendedWidgetEnum> {
  switch (queryId) {
    case "metric_total":
      return "metric";
    case "sales_by_location":
    case "doordash_revenue":
    case "takeout_orders_by_location":
      return "bar";
    case "top_items":
      return "table";
    case "hourly_sales":
    case "daily_sales":
      return "line";
    case "delivery_vs_dinein":
      return "pie";
    default:
      return "bar";
  }
}

function inferQueryIdFromRecommendation(args: {
  userQuery: string;
  action: PlanAction;
}): z.infer<typeof QueryIdEnum> {
  const q = args.userQuery.toLowerCase();
  const rw = args.action.recommended_widget;
  const intent = args.action.intent;
  const params = args.action.params ?? {};
  const hasOrderDate = !!canonicalISODate(params.order_date);

  const mentionsDoorDash = q.includes("doordash");
  const mentionsTakeout =
    q.includes("takeout") || q.includes("pickup") || q.includes("pick up");
  const mentionsOrders = q.includes("orders");

  if (rw === "metric") return "metric_total";
  if (rw === "pie") return "delivery_vs_dinein";
  if (rw === "table") return "top_items";

  if (rw === "line") {
    if (hasOrderDate) return "hourly_sales";
    return "daily_sales";
  }

  if (mentionsDoorDash) return "doordash_revenue";
  if (mentionsOrders || mentionsTakeout) return "takeout_orders_by_location";

  if (intent === "ranking" || intent === "comparison" || intent === "breakdown")
    return "sales_by_location";

  return "sales_by_location";
}

function normalizeAction(args: {
  userQuery: string;
  action: PlanAction;
  minDate?: string | null; // ✅ allow using dataset minDate for "first week"
}): PlanAction & {
  query_id: z.infer<typeof QueryIdEnum>;
  recommended_widget?: z.infer<typeof RecommendedWidgetEnum>;
} {
  const { userQuery } = args;
  let a: PlanAction = args.action;

  // ✅ If user explicitly asked for a graph/chart/plot/trend, force line chart behavior
  const wantsGraph = isGraphLikeQuery(userQuery);
  if (wantsGraph) {
    a = {
      ...a,
      intent: a.intent ?? "trend",
      recommended_widget: "line",
    };

    // ✅ If they said "first week", auto-scope to first 7 days of dataset (minDate..minDate+6)
    if (hasFirstWeekPhrase(userQuery) && args.minDate) {
      const p = a.params ?? {};
      const hasStart = canonicalISODate((p as any).start_date);
      const hasEnd = canonicalISODate((p as any).end_date);

      if (!hasStart || !hasEnd) {
        const end = addDaysISO(args.minDate, 6);
        a = {
          ...a,
          params: {
            ...(p ?? {}),
            start_date: args.minDate,
            ...(end ? { end_date: end } : {}),
          },
        };
      }
    }
  }

  const query_id =
    a.query_id ??
    inferQueryIdFromRecommendation({ userQuery: args.userQuery, action: a });

  const expected = expectedWidgetFromQueryId(query_id);
  const recommended_widget = a.recommended_widget ?? expected;
  const fixedRecommended =
    recommended_widget !== expected ? expected : recommended_widget;

  return {
    ...a,
    query_id,
    recommended_widget: fixedRecommended,
  };
}

/** -------------------------------
 * ✅ Safety net: enforce Metric + Hourly pair for single-day totals
 * ------------------------------*/
function normalizeLocList(xs: unknown): string[] {
  return Array.isArray(xs)
    ? xs
        .map(cleanStr)
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    : [];
}

function sameScope(a: any, b: any) {
  const ap = a?.params ?? {};
  const bp = b?.params ?? {};

  const aDate = canonicalISODate(ap.order_date);
  const bDate = canonicalISODate(bp.order_date);

  const aLoc = cleanStr(ap.location || "").toLowerCase();
  const bLoc = cleanStr(bp.location || "").toLowerCase();

  const aLocs = normalizeLocList(ap.locations);
  const bLocs = normalizeLocList(bp.locations);

  const locsEq =
    aLocs.length === bLocs.length &&
    aLocs.every((x, i) => x === (bLocs[i] ?? ""));

  return aDate === bDate && aLoc === bLoc && locsEq;
}

function applyRelativeDatesToAction(
  action: PlanAction,
  userQuery: string,
  maxDate: string | null
): PlanAction {
  const rel = resolveRelativeOrderDate(userQuery, maxDate);
  if (!rel) return action;

  const p = action.params ?? {};
  const has = canonicalISODate(p.order_date);
  if (has) return action;

  return {
    ...action,
    params: {
      ...p,
      order_date: rel,
    },
  };
}

function ensureMetricAndHourlyPair(args: {
  userQuery: string;
  maxDate: string | null;
  actions: PlanAction[];
}): PlanAction[] {
  const { userQuery, maxDate } = args;

  // First: fill relative dates (yesterday/today) if missing.
  const seeded = args.actions.map((a) =>
    applyRelativeDatesToAction(a, userQuery, maxDate)
  );

  const out: PlanAction[] = [...seeded];

  // 1) If there is metric_total with order_date, ensure hourly exists for same scope
  for (const raw of seeded) {
    const a = normalizeAction({ userQuery, action: raw });

    if (a.query_id !== "metric_total") continue;
    const d = canonicalISODate(a.params?.order_date);
    if (!d) continue;

    const hasHourly = out.some((x) => {
      const nx = normalizeAction({ userQuery, action: x });
      return nx.query_id === "hourly_sales" && sameScope(nx, a);
    });

    if (!hasHourly) {
      out.push({
        intent: "breakdown",
        recommended_widget: "line",
        title: a.title ? `Hourly breakdown — ${a.title}` : undefined,
        note: undefined,
        params: {
          ...(a.params ?? {}),
          order_date: d,
        },
      });
    }
  }

  // 2) If there is hourly_sales with order_date, ensure metric_total exists for same scope
  for (const raw of seeded) {
    const a = normalizeAction({ userQuery, action: raw });

    if (a.query_id !== "hourly_sales") continue;
    const d = canonicalISODate(a.params?.order_date);
    if (!d) continue;

    const hasMetric = out.some((x) => {
      const nx = normalizeAction({ userQuery, action: x });
      return nx.query_id === "metric_total" && sameScope(nx, a);
    });

    if (!hasMetric) {
      out.unshift({
        // put metric first so it renders above line after slicing
        intent: "single_value",
        recommended_widget: "metric",
        title: a.title ? a.title.replace(/^Hourly\s+/i, "") : undefined,
        note: undefined,
        params: {
          ...(a.params ?? {}),
          order_date: d,
        },
      });
    }
  }

  return out;
}

async function runAction(
  action: PlanAction & { query_id: z.infer<typeof QueryIdEnum> },
  knownLocations: string[],
  metricHint: Metric,
  minDate: string | null,
  maxDate: string | null
): Promise<Widget> {
  const queryId = action.query_id;
  const params = action.params ?? {};
  const note = cleanNote(action.note);

  const metric: Metric = (params.metric as Metric) ?? metricHint;
  const metricCol = metricToColumn(metric);

  const location = cleanStr(params.location) || "";
  const locations = Array.isArray(params.locations)
    ? params.locations.map(cleanStr).filter(Boolean)
    : [];

  const order_date = canonicalISODate(params.order_date);

  const locFilterSingle =
    location &&
    knownLocations.some((l) => l.toLowerCase() === location.toLowerCase())
      ? knownLocations.find((l) => l.toLowerCase() === location.toLowerCase())!
      : location || null;

  const locFilterList =
    locations.length > 0
      ? locations
          .map((loc) => {
            const hit = knownLocations.find(
              (l) => l.toLowerCase() === loc.toLowerCase()
            );
            return hit ?? loc;
          })
          .slice(0, 5)
      : [];

  if (order_date && minDate && maxDate) {
    if (order_date < minDate || order_date > maxDate) {
      throw new Error(
        `Date ${order_date} is outside the available range (${minDate} to ${maxDate}).`
      );
    }
  }

  if (queryId === "metric_total") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select(`location, order_date, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let total = 0;
    for (const r of (data ?? []) as any[]) {
      total += Number(r[metricCol] ?? 0);
    }

    const metricLabel = metric === "revenue" ? "Revenue" : "Sales";
    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `metric_total:${metric}:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      type: "metric",
      title:
        action.title ??
        `${metricLabel}${scope}${order_date ? ` (${order_date})` : ""}`,
      value: total,
      value_type: "currency",
      note,
    };
  }

  if (queryId === "sales_by_location") {
    let q = supabaseServer.from(ORDERS_VIEW).select(`location, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const totals = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      const loc = cleanStr(r.location) || "Unknown";
      const cents = Number(r[metricCol] ?? 0);
      totals.set(loc, (totals.get(loc) ?? 0) + cents);
    }

    const result = Array.from(totals.entries())
      .map(([location_name, sales_cents]) => ({ location_name, sales_cents }))
      .sort((a, b) => b.sales_cents - a.sales_cents);

    const metricLabel = metric === "revenue" ? "Revenue" : "Sales";

    return {
      id: `sales_by_location:${metric}:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title: action.title ?? `${metricLabel} by Location`,
      note,
      type: "bar",
      value_type: "currency",
      data: result,
    };
  }

  if (queryId === "top_items") {
    const limit = Number.isFinite(Number(params.limit))
      ? Math.min(50, Math.max(1, Number(params.limit)))
      : 10;

    const { data, error } = await supabaseServer
      .from("v_order_items")
      .select("normalized_name, line_total_cents");
    if (error) throw new Error(error.message);

    const totals = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      const name = cleanStr(r.normalized_name) || "unknown";
      const cents = Number(r.line_total_cents ?? 0);
      totals.set(name, (totals.get(name) ?? 0) + cents);
    }

    const result = Array.from(totals.entries())
      .map(([normalized_name, sales_cents]) => ({
        normalized_name,
        sales_cents,
      }))
      .sort((a, b) => b.sales_cents - a.sales_cents)
      .slice(0, limit);

    return {
      id: `top_items:${limit}`,
      title: action.title ?? `Top ${limit} Items (by sales)`,
      note,
      type: "table",
      value_type: "currency",
      data: result,
    };
  }

  if (queryId === "hourly_sales") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select(`order_hour, location, order_date, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const totals = new Map<number, number>();
    for (const r of (data ?? []) as any[]) {
      const hr = Number(r.order_hour);
      if (!Number.isFinite(hr)) continue;
      const cents = Number(r[metricCol] ?? 0);
      totals.set(hr, (totals.get(hr) ?? 0) + cents);
    }

    const series = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      sales_cents: totals.get(hour) ?? 0,
    }));

    const metricLabel = metric === "revenue" ? "Revenue" : "Sales";
    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `hourly_sales:${metric}:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title:
        action.title ??
        `Hourly ${metricLabel}${scope}${order_date ? ` (${order_date})` : ""}`,
      note,
      type: "line",
      data: series,
    };
  }

  if (queryId === "daily_sales") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select(`order_date, location, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);

    // ✅ Optional range filters
    const start_date = canonicalISODate((params as any).start_date);
    const end_date = canonicalISODate((params as any).end_date);

    if (start_date && minDate && maxDate) {
      if (start_date < minDate || start_date > maxDate) {
        throw new Error(
          `Start date ${start_date} is outside the available range (${minDate} to ${maxDate}).`
        );
      }
    }
    if (end_date && minDate && maxDate) {
      if (end_date < minDate || end_date > maxDate) {
        throw new Error(
          `End date ${end_date} is outside the available range (${minDate} to ${maxDate}).`
        );
      }
    }

    if (start_date) q = q.gte("order_date", start_date);
    if (end_date) q = q.lte("order_date", end_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const totals = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      const d = cleanStr(r.order_date);
      if (!d) continue;
      const cents = Number(r[metricCol] ?? 0);
      totals.set(d, (totals.get(d) ?? 0) + cents);
    }

    const series = Array.from(totals.entries())
      .map(([date, sales_cents]) => ({ date, sales_cents }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const metricLabel = metric === "revenue" ? "Revenue" : "Sales";
    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    const rangeLabel =
      start_date && end_date ? ` (${start_date} → ${end_date})` : "";

    return {
      id: `daily_sales:${metric}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }:${start_date ?? "all"}:${end_date ?? "all"}`,
      title: action.title ?? `Daily ${metricLabel}${scope}${rangeLabel}`,
      note,
      type: "line",
      data: series,
    };
  }

  if (queryId === "delivery_vs_dinein") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select(`location, order_date, channel, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let delivery = 0;
    let dinein = 0;
    let unknown = 0;

    for (const r of (data ?? []) as any[]) {
      const cents = Number(r[metricCol] ?? 0);
      const ch = cleanStr(r.channel);

      if (ch === "Delivery") delivery += cents;
      else if (ch === "Dine-in") dinein += cents;
      else unknown += cents;
    }

    const notes: string[] = [];
    if (note) notes.push(note);

    notes.push(
      metric === "sales"
        ? `Using net sales (item_sales_cents): pre-tax, before tip/fees.`
        : `Using gross revenue (total_cents): includes tax, tip, and fees.`
    );

    const result = [
      { channel: "Delivery", sales_cents: delivery },
      { channel: "Dine-in", sales_cents: dinein },
      { channel: "Unknown", sales_cents: unknown },
    ].filter((x) => x.sales_cents > 0);

    const metricLabel = metric === "revenue" ? "Revenue" : "Sales";
    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `delivery_vs_dinein:${metric}:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title:
        action.title ??
        `Delivery vs Dine-in ${metricLabel}${scope}${
          order_date ? ` (${order_date})` : ""
        }`,
      note: notes.join(" "),
      type: "pie",
      data: result,
    };
  }

  if (queryId === "doordash_revenue") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select("location, order_date, total_cents, is_doordash");

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    q = q.eq("is_doordash", true);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const totals = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      const loc = cleanStr(r.location) || "Unknown";
      const cents = Number(r.total_cents ?? 0);
      totals.set(loc, (totals.get(loc) ?? 0) + cents);
    }

    const result = Array.from(totals.entries())
      .map(([location_name, sales_cents]) => ({ location_name, sales_cents }))
      .sort((a, b) => b.sales_cents - a.sales_cents);

    return {
      id: `doordash_revenue:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title: action.title ?? `DoorDash Revenue by Location`,
      note: note ?? "Revenue uses total_cents (includes tax, tip, fees).",
      type: "bar",
      value_type: "currency",
      data: result,
    };
  }

  if (queryId === "takeout_orders_by_location") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select("location, order_date, is_takeout");

    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const counts = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      if (!r.is_takeout) continue;
      const loc = cleanStr(r.location) || "Unknown";
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }

    const result = Array.from(counts.entries())
      .map(([location_name, count]) => ({ location_name, sales_cents: count }))
      .sort((a, b) => b.sales_cents - a.sales_cents);

    const notes: string[] = [];
    if (note) notes.push(note);
    notes.push("Counts of pickup/takeout orders (not dollars).");

    return {
      id: `takeout_orders_by_location:${order_date ?? "all"}`,
      title:
        action.title ??
        `Takeout Orders by Location${order_date ? ` (${order_date})` : ""}`,
      note: notes.join(" "),
      type: "bar",
      value_type: "count",
      data: result,
    };
  }

  throw new Error("Unsupported query_id");
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userQuery = cleanStr(body?.query);
    const clarification = cleanStr(body?.clarification);

    if (!userQuery) {
      return NextResponse.json(
        { ok: false, error: "Missing query" },
        { status: 400 }
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "OPENAI_API_KEY not set" },
        { status: 500 }
      );
    }

    const { knownLocations, minDate, maxDate } =
      await getKnownLocationsAndRange();

    const detectedLocations = detectLocationsInQuery(userQuery, knownLocations);
    const metricHint = metricHintFromQuery(userQuery);
    const inferredIsoDate = inferISODateFromUserText(userQuery);

    const prompt = buildPlannerPrompt({
      userQuery,
      clarification: clarification || null,
      knownLocations,
      detectedLocations,
      metricHint,
      minDate,
      maxDate,
      inferredIsoDate,
    });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = resp.choices?.[0]?.message?.content ?? "";
    let parsed: unknown;

    try {
      parsed = safeJsonParse(text);
    } catch {
      const retry = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "user",
            content:
              prompt + "\n\nIMPORTANT: Return ONLY valid JSON. No extra text.",
          },
        ],
      });

      const retryText = retry.choices?.[0]?.message?.content ?? "";
      parsed = safeJsonParse(retryText);
    }

    let plan = PlanSchema.parse(parsed);

    if (plan.clarify_question) {
      return NextResponse.json({
        ok: true,
        assistant_message: plan.assistant_message,
        clarify_question: plan.clarify_question,
        widgets: [] as Widget[],
      });
    }

    if (!plan.actions.length) {
      const force = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "user",
            content:
              prompt +
              "\n\nYou returned zero actions. You MUST return at least one action unless you ask a clarify_question.",
          },
        ],
      });

      const forceText = force.choices?.[0]?.message?.content ?? "";
      const forceParsed = safeJsonParse(forceText);
      plan = PlanSchema.parse(forceParsed);

      if (plan.clarify_question) {
        return NextResponse.json({
          ok: true,
          assistant_message: plan.assistant_message,
          clarify_question: plan.clarify_question,
          widgets: [] as Widget[],
        });
      }
    }

    // ✅ Enforce metric + hourly line pair for single-day totals (and fill "yesterday")
    plan.actions = ensureMetricAndHourlyPair({
      userQuery,
      maxDate,
      actions: plan.actions,
    });

    // ✅ only run up to 3 widgets (metric + line fits)
    const actionsToRun = plan.actions.slice(0, 3);

    const widgets: Widget[] = [];
    for (const raw of actionsToRun) {
      const action = normalizeAction({ userQuery, action: raw, minDate });
      const w = await runAction(
        action,
        knownLocations,
        metricHint,
        minDate,
        maxDate
      );
      widgets.push(w);
    }

    const summary = buildAnswerFirstSummaries(widgets);

    return NextResponse.json({
      ok: true,
      assistant_message: `${plan.assistant_message}${summary}`,
      widgets,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
