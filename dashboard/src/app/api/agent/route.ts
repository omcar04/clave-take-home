// app/api/agent/route.ts
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
  value_type?: "currency" | "count"; // ✅ so takeout counts don’t look like dollars
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

type Widget = BarWidget | TableWidget | LineWidget | PieWidget;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Metric = "sales" | "revenue";

/**
 * ✅ Preprocess helper: converts null -> undefined so "optional" fields won't fail Zod
 */
const nullToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const PlanSchema = z.object({
  assistant_message: z.string().min(1),
  clarify_question: nullToUndefined(z.string()).optional(),
  actions: z
    .array(
      z.object({
        query_id: z.enum([
          "sales_by_location",
          "top_items",
          "hourly_sales",
          "daily_sales",
          "delivery_vs_dinein",
          "doordash_revenue",
          "takeout_orders_by_location",
        ]),
        title: nullToUndefined(z.string()).optional(),
        note: nullToUndefined(z.string()).optional(),
        params: nullToUndefined(
          z.object({
            metric: nullToUndefined(z.enum(["sales", "revenue"])).optional(),
            location: nullToUndefined(z.string()).optional(),
            locations: nullToUndefined(z.array(z.string()).max(5)).optional(),
            order_date: nullToUndefined(z.string()).optional(), // ✅ null-safe now
            limit: nullToUndefined(z.number().int().min(1).max(50)).optional(),
          })
        ).optional(),
      })
    )
    .max(5)
    .default([]),
});

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

function classifyChannel(fulfillmentRaw: unknown, sourceRaw: unknown) {
  const fulfillment = cleanStr(fulfillmentRaw).toLowerCase();
  const source = cleanStr(sourceRaw).toLowerCase();

  if (source.includes("doordash")) return "Delivery";

  if (
    fulfillment.includes("delivery") ||
    fulfillment.includes("pickup") ||
    fulfillment.includes("takeout") ||
    fulfillment.includes("to-go") ||
    fulfillment.includes("togo") ||
    fulfillment.includes("carryout") ||
    fulfillment.includes("curbside")
  ) {
    return "Delivery";
  }

  if (
    fulfillment.includes("dine") ||
    fulfillment.includes("on_prem") ||
    fulfillment.includes("on-prem") ||
    fulfillment.includes("onsite") ||
    fulfillment.includes("in_store") ||
    fulfillment.includes("in-store")
  ) {
    return "Dine-in";
  }

  return "Unknown";
}

function isTakeout(fulfillmentRaw: unknown) {
  const f = cleanStr(fulfillmentRaw).toLowerCase();
  return (
    f.includes("pickup") ||
    f.includes("takeout") ||
    f.includes("to-go") ||
    f.includes("togo") ||
    f.includes("carryout") ||
    f.includes("curbside")
  );
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

async function getKnownLocationsAndRange(): Promise<{
  knownLocations: string[];
  minDate: string | null;
  maxDate: string | null;
}> {
  const { data, error } = await supabaseServer
    .from("v_orders")
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
- If the user mentions a specific calendar date like "Jan 2nd" and you can map it, use that.
- Inferred ISO date from the user's text (if any): ${inferredIsoDate ?? "null"}

IMPORTANT VISUALIZATION / ACTION RULES:
1) If user asks about a SPECIFIC DATE (e.g., "sales for Jan 2nd", "revenue on January 3rd") and they do NOT ask for "daily trend" / "week" / "over time":
   - Use query_id = "hourly_sales" with params.order_date = that YYYY-MM-DD
   - This produces a single-day view (hourly line), NOT multiple days.
2) Use "daily_sales" ONLY when the user explicitly asks for a trend/range ("daily", "first week", "over time", "trend").
3) "yesterday" means (latest available date - 1 day), within the available range.
4) If user says "compare A vs B" or "A vs B" and both are locations, set params.locations = ["A","B"] and avoid extra locations.
5) If user says "orders", interpret as counts (use takeout_orders_by_location).
6) If user asks for a date outside the available range, ask EXACTLY ONE clarification question and mention the available range.

Available query_id actions:
- sales_by_location: sums sales/revenue grouped by location (params.metric)
- top_items: top selling items by item sales (order items; metric is always sales)
- hourly_sales: hourly sales/revenue (optional location, REQUIRED order_date for single-day questions; params.metric)
- daily_sales: daily sales/revenue trend (optional location; params.metric)
- delivery_vs_dinein: split by channel (params.metric)
- doordash_revenue: revenue from DoorDash (uses total_cents)
- takeout_orders_by_location: count of pickup/takeout orders grouped by location (counts, not dollars)

Return JSON of this exact shape:
{
  "assistant_message": "short helpful sentence",
  "clarify_question": "optional - ask exactly one question",
  "actions": [
    {
      "query_id": "...",
      "title": "optional widget title",
      "note": "optional note",
      "params": {
        "metric": "sales" | "revenue",
        "location": "optional location",
        "locations": ["optional","list"],
        "order_date": "optional YYYY-MM-DD",
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

async function runAction(
  action: z.infer<typeof PlanSchema>["actions"][number],
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

  if (queryId === "sales_by_location") {
    let q = supabaseServer.from("v_orders").select(`location, ${metricCol}`);

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
      .from("v_orders")
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
      .from("v_orders")
      .select(`order_date, location, ${metricCol}`);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);

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

    return {
      id: `daily_sales:${metric}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title: action.title ?? `Daily ${metricLabel}${scope}`,
      note,
      type: "line",
      data: series,
    };
  }

  if (queryId === "delivery_vs_dinein") {
    let q = supabaseServer
      .from("v_orders")
      .select(`location, order_date, fulfillment, source, ${metricCol}`);

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
      const channel = classifyChannel(r.fulfillment, r.source);
      if (channel === "Delivery") delivery += cents;
      else if (channel === "Dine-in") dinein += cents;
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
      .from("v_orders")
      .select("location, order_date, total_cents, source");

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    q = q.ilike("source", "%DOORDASH%");

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
    let q = supabaseServer.from("v_orders").select("location, fulfillment");
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const counts = new Map<string, number>();
    for (const r of (data ?? []) as any[]) {
      if (!isTakeout(r.fulfillment)) continue;
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
      value_type: "count", // ✅ key fix
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

    // ✅ only run up to 3 widgets
    const actionsToRun = plan.actions.slice(0, 3);

    const widgets: Widget[] = [];
    for (const action of actionsToRun) {
      const w = await runAction(
        action,
        knownLocations,
        metricHint,
        minDate,
        maxDate
      );
      widgets.push(w);
    }

    return NextResponse.json({
      ok: true,
      assistant_message: plan.assistant_message,
      widgets,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
