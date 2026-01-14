// src/app/api/agent/route.ts
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";

import type { Metric, Widget } from "@/lib/agent/types";
import { runAgent, runAgentWithTrace } from "@/lib/agent/graph";
import {
  normalizeAction,
  runAction,
  buildAnswerFirstSummaries,
} from "@/lib/agent/executor";

export const runtime = "nodejs";

const ORDERS_VIEW = "v_orders_enriched";

function cleanStr(x: unknown): string {
  return String(x ?? "").trim();
}

function canonicalISODate(input: unknown): string | null {
  const raw = cleanStr(input);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
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

// month parsing (unchanged)
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

function isComparisonQuery(q: string) {
  const t = q.toLowerCase();
  return (
    t.includes(" vs ") ||
    t.includes("versus") ||
    t.includes("compare") ||
    t.includes("comparison") ||
    t.includes("between")
  );
}

function isTopItemsLikeQuery(q: string) {
  const t = q.toLowerCase();
  return (
    t.includes("top item") ||
    t.includes("top items") ||
    t.includes("best seller") ||
    t.includes("bestseller") ||
    t.includes("popular item") ||
    t.includes("most sold") ||
    t.includes("most selling") ||
    t.includes("best selling") ||
    t.includes("menu item") ||
    t.includes("items")
  );
}

function isDoorDashQuery(q: string) {
  const t = q.toLowerCase();
  return t.includes("doordash") || t.includes("door dash");
}

function hasExplicitDateOrRange(q: string, inferredIsoDate: string | null) {
  const t = q.toLowerCase();
  if (inferredIsoDate) return true;
  if (t.includes("yesterday") || t.includes("today")) return true;
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(t)) return true;
  if (t.includes("daily") || t.includes("hourly")) return true;
  if (
    t.includes("last week") ||
    t.includes("this week") ||
    t.includes("last month") ||
    t.includes("this month") ||
    t.includes("between") ||
    t.includes("from ") ||
    t.includes(" to ") ||
    t.includes("since")
  )
    return true;
  return false;
}

/**
 * tight shortcut: only true “total for one location”
 */
function isSimpleSingleLocationTotalQuery(args: {
  userQuery: string;
  detectedLocations: string[];
  inferredIsoDate: string | null;
}) {
  const { userQuery, detectedLocations, inferredIsoDate } = args;
  const t = userQuery.toLowerCase();

  if (detectedLocations.length !== 1) return false;
  if (isGraphLikeQuery(userQuery)) return false;
  if (isComparisonQuery(userQuery)) return false;
  if (hasExplicitDateOrRange(userQuery, inferredIsoDate)) return false;
  if (isTopItemsLikeQuery(userQuery)) return false;
  if (isDoorDashQuery(userQuery)) return false;

  const looksLikeTotal =
    t.includes("sales") ||
    t.includes("revenue") ||
    t.includes("total") ||
    t.includes("how much");

  return looksLikeTotal;
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

function debugEnabledFromReq(req: Request, body: any) {
  const url = new URL(req.url);
  const qp = url.searchParams.get("debug");
  if (qp === "1" || qp === "true") return true;

  const b = body?.debug;
  if (b === true) return true;
  if (typeof b === "string" && (b === "1" || b.toLowerCase() === "true"))
    return true;

  return false;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userQuery = cleanStr(body?.query);
    const clarification = cleanStr(body?.clarification);

    const debug = debugEnabledFromReq(req, body);

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

    // deterministic: DoorDash total
    if (
      isDoorDashQuery(userQuery) &&
      !isComparisonQuery(userQuery) &&
      !isGraphLikeQuery(userQuery)
    ) {
      const action = normalizeAction({
        userQuery,
        action: {
          query_id: "doordash_total",
          intent: "single_value",
          recommended_widget: "metric",
          title: "DoorDash Revenue — Total",
          params: { metric: "revenue" },
        } as any,
        minDate,
      });

      const widget = await runAction(
        action,
        knownLocations,
        metricHint,
        minDate,
        maxDate
      );

      const summary = buildAnswerFirstSummaries([widget]);

      return NextResponse.json({
        ok: true,
        assistant_message: `Here’s how much revenue came from DoorDash.${summary}`,
        widgets: [widget],
        ...(debug
          ? {
              trace: {
                mode: "deterministic_doorsdash_total",
                action,
              },
            }
          : {}),
      });
    }

    // deterministic: single location total
    if (
      isSimpleSingleLocationTotalQuery({
        userQuery,
        detectedLocations,
        inferredIsoDate,
      })
    ) {
      const loc = detectedLocations[0];

      const action = normalizeAction({
        userQuery,
        action: {
          query_id: "metric_total",
          intent: "single_value",
          recommended_widget: "metric",
          title: `${metricHint === "revenue" ? "Revenue" : "Sales"} — ${loc}`,
          params: { metric: metricHint, location: loc },
        } as any,
        minDate,
      });

      const widget = await runAction(
        action,
        knownLocations,
        metricHint,
        minDate,
        maxDate
      );

      const summary = buildAnswerFirstSummaries([widget]);

      return NextResponse.json({
        ok: true,
        assistant_message: `Here’s the total ${metricHint} for ${loc}.${summary}`,
        widgets: [widget],
        ...(debug
          ? {
              trace: {
                mode: "deterministic_single_location_total",
                action,
              },
            }
          : {}),
      });
    }

    // everything else goes through LangGraph planner -> executor
    if (debug) {
      const out = await runAgentWithTrace({
        userQuery,
        clarification: clarification || null,
        knownLocations,
        detectedLocations,
        metricHint,
        minDate,
        maxDate,
        inferredIsoDate,
      });

      if (out.clarify_question) {
        return NextResponse.json({
          ok: true,
          assistant_message: out.assistant_message,
          clarify_question: out.clarify_question,
          widgets: [],
          trace: out.trace,
        });
      }

      return NextResponse.json({
        ok: true,
        assistant_message: out.assistant_message,
        widgets: out.widgets,
        trace: out.trace,
      });
    } else {
      const out = await runAgent({
        userQuery,
        clarification: clarification || null,
        knownLocations,
        detectedLocations,
        metricHint,
        minDate,
        maxDate,
        inferredIsoDate,
      });

      if (out.clarify_question) {
        return NextResponse.json({
          ok: true,
          assistant_message: out.assistant_message,
          clarify_question: out.clarify_question,
          widgets: [],
        });
      }

      return NextResponse.json({
        ok: true,
        assistant_message: out.assistant_message,
        widgets: out.widgets,
      });
    }
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
