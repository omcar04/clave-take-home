// src/lib/agent/executor.ts
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";
import type { Metric, Widget, PlanAction, Plan } from "@/lib/agent/types";
import { QueryIdEnum, RecommendedWidgetEnum } from "@/lib/agent/types";

export const ORDERS_VIEW = "v_orders_enriched";

// ✅ NEW: your derived order-items view with canonical_category
export const ORDER_ITEMS_DERIVED_VIEW = "v_order_items_derived";

/** -------------------------------
 * small helpers
 * ------------------------------*/
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

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

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

function metricToColumn(metric: Metric) {
  return metric === "revenue" ? "total_cents" : "item_sales_cents";
}

/** -------------------------------
 * answer-first summary helpers
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

export function buildAnswerFirstSummaries(widgets: Widget[]): string {
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

    // ✅ NEW: AOV summary
    if (w.type === "aov") {
      const rows = (w as any).data ?? [];
      if (!rows.length) continue;

      const totalOrders = rows.reduce(
        (acc: number, r: any) => acc + Number(r.orders_count ?? 0),
        0
      );

      const weightedTotalCents = rows.reduce((acc: number, r: any) => {
        const aov = Number(r.value_cents ?? 0);
        const n = Number(r.orders_count ?? 0);
        return acc + aov * n;
      }, 0);

      const overallAovCents =
        totalOrders > 0 ? Math.round(weightedTotalCents / totalOrders) : 0;

      const top = rows.reduce((best: any, cur: any) =>
        Number(cur.value_cents ?? 0) > Number(best.value_cents ?? 0)
          ? cur
          : best
      );

      lines.push(
        `• ${w.title}: Overall AOV ${dollars(
          overallAovCents
        )} across ${totalOrders} orders. Top: ${top.location_name} (${dollars(
          Number(top.value_cents ?? 0)
        )}, ${Number(top.orders_count ?? 0)} orders).`
      );
      continue;
    }

    const valueType: "currency" | "count" =
      (w.type === "bar" && ((w as any).value_type ?? "currency")) ||
      (w.type === "table" && ((w as any).value_type ?? "currency")) ||
      (w.type === "line" ? "currency" : "currency");

    if (w.type === "bar") {
      const values = (w as any).data.map((d: any) =>
        Number(d.sales_cents ?? 0)
      );
      const total = sum(values);
      if (total <= 0) continue;

      const top = (w as any).data.reduce((best: any, cur: any) =>
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
      const values = (w as any).data.map((d: any) =>
        Number(d.sales_cents ?? 0)
      );
      const total = sum(values);
      if (total <= 0) continue;

      const top = (w as any).data.reduce((best: any, cur: any) =>
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
      const values = (w as any).data.map((d: any) =>
        Number(d.sales_cents ?? 0)
      );
      const total = sum(values);
      if (total <= 0) continue;

      const top = (w as any).data.reduce((best: any, cur: any) =>
        Number(cur.sales_cents ?? 0) > Number(best.sales_cents ?? 0)
          ? cur
          : best
      );

      const topVal = Number(top.sales_cents ?? 0);
      const pct = topVal / total;

      const vt: "currency" | "count" = (w as any).value_type ?? "currency";

      lines.push(
        `• ${w.title}: Total ${formatValue(total, vt)}. Top: ${
          top.normalized_name
        } (${formatValue(topVal, vt)}, ${formatPct(pct)}).`
      );
      continue;
    }

    if (w.type === "line") {
      const values = ((w as any).data as any[]).map((p) =>
        Number(p.sales_cents ?? 0)
      );
      const total = sum(values);
      if (total <= 0) continue;

      const topPoint = ((w as any).data as any[]).reduce((best, cur) =>
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

/** -------------------------------
 * query_id mapping
 * ------------------------------*/
function expectedWidgetFromQueryId(
  queryId: z.infer<typeof QueryIdEnum>
): z.infer<typeof RecommendedWidgetEnum> {
  switch (queryId) {
    case "metric_total":
    case "doordash_total":
      return "metric";

    case "sales_by_location":
    case "doordash_revenue":
    case "takeout_orders_by_location":
    case "aov_by_location":
    case "sales_by_location_by_category":
      // planner-layer default; executor may return "table" depending on intent
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
  const rw = (args.action as any).recommended_widget;
  const intent = (args.action as any).intent;
  const params = (args.action as any).params ?? {};
  const hasOrderDate = !!canonicalISODate(params.order_date);

  const mentionsDoorDash = q.includes("doordash") || q.includes("door dash");
  const mentionsTakeout =
    q.includes("takeout") || q.includes("pickup") || q.includes("pick up");
  const mentionsOrders = q.includes("orders");

  const mentionsAOV =
    q.includes("aov") ||
    q.includes("avg order value") ||
    q.includes("average order value") ||
    q.includes("average ticket") ||
    q.includes("avg ticket");

  // ✅ CATEGORY detection (only trigger category path when user actually asked for it)
  const canonicalCats = [
    "beverage",
    "beverages",
    "drink",
    "drinks",
    "food",
    "entree",
    "entrees",
    "entrée",
    "dessert",
    "desserts",
    "sweet",
    "sweets",
    "appetizer",
    "appetizers",
    "side",
    "sides",
  ];

  const mentionsCategory =
    q.includes("category") ||
    q.includes("categories") ||
    q.includes("by category") ||
    canonicalCats.some((c) => q.includes(c));

  // ✅ LOCATION ranking detection (fixes: "Which location had the highest sales?")
  // If this is true, we must NOT route to category query.
  const mentionsLocationRanking =
    (q.includes("which location") ||
      q.includes("top location") ||
      q.includes("best location") ||
      q.includes("highest sales") ||
      q.includes("highest revenue") ||
      q.includes("most sales") ||
      q.includes("most revenue") ||
      q.includes("rank") ||
      q.includes("ranking")) &&
    (q.includes("location") || q.includes("store")) &&
    !mentionsCategory;

  if (mentionsLocationRanking) return "sales_by_location";

  // ✅ category queries -> the combined query_id
  if (mentionsCategory) return "sales_by_location_by_category";

  if (rw === "metric" && mentionsDoorDash) return "doordash_total";
  if (rw === "metric") return "metric_total";
  if (rw === "pie") return "delivery_vs_dinein";
  if (rw === "table") return "top_items";

  if (rw === "line") {
    if (hasOrderDate) return "hourly_sales";
    return "daily_sales";
  }

  if (mentionsAOV) return "aov_by_location";
  if (mentionsDoorDash) return "doordash_revenue";
  if (mentionsOrders || mentionsTakeout) return "takeout_orders_by_location";

  if (intent === "ranking" || intent === "comparison" || intent === "breakdown")
    return "sales_by_location";

  return "sales_by_location";
}

export function normalizeAction(args: {
  userQuery: string;
  action: PlanAction;
  minDate?: string | null;
}): PlanAction & {
  query_id: z.infer<typeof QueryIdEnum>;
  recommended_widget?: z.infer<typeof RecommendedWidgetEnum>;
} {
  const a: any = args.action as any;

  const query_id: z.infer<typeof QueryIdEnum> =
    a.query_id ??
    inferQueryIdFromRecommendation({ userQuery: args.userQuery, action: a });

  const expected = expectedWidgetFromQueryId(query_id);

  // ✅ Special case: allow planner to choose bar/table for this query_id
  if (query_id === "sales_by_location_by_category") {
    return {
      ...a,
      query_id,
      recommended_widget: a.recommended_widget ?? expected,
    };
  }

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
 * metric + hourly safety net
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

  const p: any = (action as any).params ?? {};
  const has = canonicalISODate(p.order_date);
  if (has) return action;

  return {
    ...(action as any),
    params: {
      ...p,
      order_date: rel,
    },
  } as any;
}

export function ensureMetricAndHourlyPair(args: {
  userQuery: string;
  maxDate: string | null;
  actions: PlanAction[];
}): PlanAction[] {
  const { userQuery, maxDate } = args;

  const seeded = args.actions.map((a) =>
    applyRelativeDatesToAction(a, userQuery, maxDate)
  );

  const out: PlanAction[] = [...seeded];

  for (const raw of seeded) {
    const a = normalizeAction({ userQuery, action: raw });
    if (a.query_id !== "metric_total") continue;

    const d = canonicalISODate((a as any).params?.order_date);
    if (!d) continue;

    const hasHourly = out.some((x) => {
      const nx = normalizeAction({ userQuery, action: x });
      return nx.query_id === "hourly_sales" && sameScope(nx, a);
    });

    if (!hasHourly) {
      out.push({
        intent: "breakdown",
        recommended_widget: "line",
        title: (a as any).title
          ? `Hourly breakdown — ${(a as any).title}`
          : undefined,
        note: undefined,
        params: {
          ...((a as any).params ?? {}),
          order_date: d,
        },
      } as any);
    }
  }

  for (const raw of seeded) {
    const a = normalizeAction({ userQuery, action: raw });
    if (a.query_id !== "hourly_sales") continue;

    const d = canonicalISODate((a as any).params?.order_date);
    if (!d) continue;

    const hasMetric = out.some((x) => {
      const nx = normalizeAction({ userQuery, action: x });
      return nx.query_id === "metric_total" && sameScope(nx, a);
    });

    if (!hasMetric) {
      out.unshift({
        intent: "single_value",
        recommended_widget: "metric",
        title: (a as any).title
          ? (a as any).title.replace(/^Hourly\s+/i, "")
          : undefined,
        note: undefined,
        params: {
          ...((a as any).params ?? {}),
          order_date: d,
        },
      } as any);
    }
  }

  return out;
}

/** -------------------------------
 *  runAction
 * ------------------------------*/
export async function runAction(
  action: PlanAction & { query_id: z.infer<typeof QueryIdEnum> },
  knownLocations: string[],
  metricHint: Metric,
  minDate: string | null,
  maxDate: string | null
): Promise<Widget> {
  const queryId = action.query_id;
  const params: any = (action as any).params ?? {};
  const note = cleanNote((action as any).note);

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
          .map((loc: string) => {
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

  // ✅ NEW: one query for “category sales by location” + “category ranking”
  // Uses canonical_category from v_order_items_derived
  if (queryId === "sales_by_location_by_category") {
    const wantsRanking = (action as any).intent === "ranking";

    const categoryFilterRaw = cleanStr(params.category || "");
    const categoryFilter = categoryFilterRaw.toLowerCase(); // e.g. "beverages"

    // 1) pull items (derived view)
    const { data: items, error: itemsErr } = await supabaseServer
      .from(ORDER_ITEMS_DERIVED_VIEW)
      .select("order_id, canonical_category, line_total_cents");

    if (itemsErr) throw new Error(itemsErr.message);

    // 2) map order_id -> location (from ORDERS_VIEW)
    const orderIds = Array.from(
      new Set((items ?? []).map((r: any) => r.order_id).filter(Boolean))
    );

    const orderIdToLoc = new Map<string, string>();

    // chunk to avoid .in() limits
    for (let i = 0; i < orderIds.length; i += 500) {
      const ids = orderIds.slice(i, i + 500);

      let oq = supabaseServer
        .from(ORDERS_VIEW)
        .select("id, location, order_date");

      oq = oq.in("id", ids);

      // apply order-level filters here
      if (locFilterSingle) oq = oq.eq("location", locFilterSingle);
      if (locFilterList.length) oq = oq.in("location", locFilterList);
      if (order_date) oq = oq.eq("order_date", order_date);

      const { data: orders, error: ordersErr } = await oq;
      if (ordersErr) throw new Error(ordersErr.message);

      for (const o of (orders ?? []) as any[]) {
        const id = String(o.id ?? "");
        const loc = cleanStr(o.location) || "Unknown";
        if (id) orderIdToLoc.set(id, loc);
      }
    }

    // 3) aggregate (location, category) -> cents
    const byLocCat = new Map<string, number>();

    for (const r of (items ?? []) as any[]) {
      const oid = String(r.order_id ?? "");
      const loc = orderIdToLoc.get(oid);
      if (!loc) continue; // filtered out by ORDERS_VIEW query above

      const cat = cleanStr(r.canonical_category) || "Unknown";
      if (categoryFilter && cat.toLowerCase() !== categoryFilter) continue;

      const cents = Number(r.line_total_cents ?? 0);
      const key = `${loc}|||${cat}`;
      byLocCat.set(key, (byLocCat.get(key) ?? 0) + cents);
    }

    // A) category filter -> bar (category sales by location)
    if (categoryFilter) {
      const totalsByLoc = new Map<string, number>();
      for (const [key, cents] of byLocCat.entries()) {
        const [loc] = key.split("|||");
        totalsByLoc.set(loc, (totalsByLoc.get(loc) ?? 0) + cents);
      }

      const data = Array.from(totalsByLoc.entries())
        .map(([location_name, sales_cents]) => ({ location_name, sales_cents }))
        .sort((a, b) => b.sales_cents - a.sales_cents);

      const titleCat = categoryFilterRaw.trim() || "Category";
      const scope = locFilterList.length
        ? ` — ${locFilterList.join(" vs ")}`
        : locFilterSingle
        ? ` — ${locFilterSingle}`
        : "";

      return {
        id: `sales_by_location_by_category:${titleCat}:${order_date ?? "all"}:${
          locFilterList.join("|") || locFilterSingle || "all"
        }`,
        type: "bar",
        value_type: "currency",
        title:
          (action as any).title ??
          `${titleCat} sales by location${scope}${
            order_date ? ` (${order_date})` : ""
          }`,
        note: note ?? "Based on item line totals (pre-tax/tip/fees).",
        data,
      };
    }

    // B) ranking categories overall -> table
    if (wantsRanking) {
      const totalsByCat = new Map<string, number>();
      for (const [key, cents] of byLocCat.entries()) {
        const [, cat] = key.split("|||");
        totalsByCat.set(cat, (totalsByCat.get(cat) ?? 0) + cents);
      }

      const data = Array.from(totalsByCat.entries())
        .map(([normalized_name, sales_cents]) => ({
          normalized_name,
          sales_cents,
        }))
        .sort((a, b) => b.sales_cents - a.sales_cents);

      const scope = locFilterList.length
        ? ` — ${locFilterList.join(" vs ")}`
        : locFilterSingle
        ? ` — ${locFilterSingle}`
        : "";

      return {
        id: `sales_by_location_by_category:category_ranking:${
          order_date ?? "all"
        }:${locFilterList.join("|") || locFilterSingle || "all"}`,
        type: "table",
        value_type: "currency",
        title: (action as any).title ?? `Revenue by category${scope}`,
        note: note ?? "Based on item line totals (pre-tax/tip/fees).",
        data,
      };
    }

    // C) fallback: flattened “location · category” table
    const data = Array.from(byLocCat.entries())
      .map(([key, sales_cents]) => {
        const [loc, cat] = key.split("|||");
        return { normalized_name: `${loc} · ${cat}`, sales_cents };
      })
      .sort((a, b) => b.sales_cents - a.sales_cents);

    return {
      id: `sales_by_location_by_category:matrix_flat:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      type: "table",
      value_type: "currency",
      title: (action as any).title ?? "Sales by location and category",
      note:
        note ??
        "Flattened (location · category). Based on item line totals (pre-tax/tip/fees).",
      data,
    };
  }

  if (queryId === "doordash_total") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select("location, order_date, total_cents, is_doordash");

    q = q.eq("is_doordash", true);

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let total = 0;
    for (const r of (data ?? []) as any[]) total += Number(r.total_cents ?? 0);

    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `doordash_total:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      type: "metric",
      title:
        (action as any).title ??
        `DoorDash Revenue${scope}${order_date ? ` (${order_date})` : ""}`,
      value: total,
      value_type: "currency",
      note:
        note ?? "DoorDash revenue uses total_cents (includes tax, tip, fees).",
    };
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
    for (const r of (data ?? []) as any[]) total += Number(r[metricCol] ?? 0);

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
        (action as any).title ??
        `${metricLabel}${scope}${order_date ? ` (${order_date})` : ""}`,
      value: total,
      value_type: "currency",
      note,
    };
  }

  // ✅ NEW: AOV by location
  if (queryId === "aov_by_location") {
    let q = supabaseServer
      .from(ORDERS_VIEW)
      .select("location, order_date, total_cents");

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const totalsByLoc = new Map<string, number>();
    const countByLoc = new Map<string, number>();

    for (const r of (data ?? []) as any[]) {
      const loc = cleanStr(r.location) || "Unknown";
      const cents = Number(r.total_cents ?? 0);
      totalsByLoc.set(loc, (totalsByLoc.get(loc) ?? 0) + cents);
      countByLoc.set(loc, (countByLoc.get(loc) ?? 0) + 1);
    }

    const result = Array.from(totalsByLoc.entries())
      .map(([location_name, total_cents]) => {
        const orders_count = countByLoc.get(location_name) ?? 0;
        const value_cents =
          orders_count > 0 ? Math.round(total_cents / orders_count) : 0;
        return { location_name, value_cents, orders_count };
      })
      .sort((a, b) => b.value_cents - a.value_cents);

    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `aov_by_location:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title:
        (action as any).title ??
        `AOV by Location${scope}${order_date ? ` (${order_date})` : ""}`,
      note:
        note ??
        "AOV = total_cents / orders_count (gross: includes tax/tip/fees).",
      type: "aov",
      data: result,
    } as any;
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
      title: (action as any).title ?? `${metricLabel} by Location`,
      note,
      type: "bar",
      value_type: "currency",
      data: result,
    };
  }

  // ✅ FIXED: top_items now respects location/date filters
  if (queryId === "top_items") {
    const limit = Number.isFinite(Number(params.limit))
      ? Math.min(50, Math.max(1, Number(params.limit)))
      : 10;

    let q = supabaseServer
      .from("v_order_items")
      .select(
        ["normalized_name", "line_total_cents", "location", "order_date"].join(
          ","
        )
      );

    if (locFilterSingle) q = q.eq("location", locFilterSingle);
    if (locFilterList.length) q = q.in("location", locFilterList);
    if (order_date) q = q.eq("order_date", order_date);

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `top_items failed. Ensure v_order_items has columns location + order_date. Original error: ${error.message}`
      );
    }

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

    const scope = locFilterList.length
      ? ` — ${locFilterList.join(" vs ")}`
      : locFilterSingle
      ? ` — ${locFilterSingle}`
      : "";

    return {
      id: `top_items:${limit}:${order_date ?? "all"}:${
        locFilterList.join("|") || locFilterSingle || "all"
      }`,
      title:
        (action as any).title ??
        `Top ${limit} Items (by sales)${scope}${
          order_date ? ` (${order_date})` : ""
        }`,
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
        (action as any).title ??
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

    const start_date = canonicalISODate(params.start_date);
    const end_date = canonicalISODate(params.end_date);

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
      title:
        (action as any).title ?? `Daily ${metricLabel}${scope}${rangeLabel}`,
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
        (action as any).title ??
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
      title: (action as any).title ?? `DoorDash Revenue by Location`,
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
        (action as any).title ??
        `Takeout Orders by Location${order_date ? ` (${order_date})` : ""}`,
      note: notes.join(" "),
      type: "bar",
      value_type: "count",
      data: result,
    };
  }

  throw new Error("Unsupported query_id");
}

/** -------------------------------
 *  Execute a Plan -> widgets + message
 * ------------------------------*/
export async function executePlan(args: {
  userQuery: string;
  plan: Plan;
  knownLocations: string[];
  metricHint: Metric;
  minDate: string | null;
  maxDate: string | null;
}): Promise<{
  assistant_message: string;
  clarify_question?: string;
  widgets: Widget[];
}> {
  const { userQuery, knownLocations, metricHint, minDate, maxDate } = args;
  const plan = args.plan as any;

  if (plan.clarify_question) {
    return {
      assistant_message: plan.assistant_message,
      clarify_question: plan.clarify_question,
      widgets: [],
    };
  }

  plan.actions = ensureMetricAndHourlyPair({
    userQuery,
    maxDate,
    actions: plan.actions ?? [],
  });

  const actionsToRun = (plan.actions ?? []).slice(0, 3);

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

  return {
    assistant_message: `${plan.assistant_message}${summary}`,
    widgets,
  };
}
