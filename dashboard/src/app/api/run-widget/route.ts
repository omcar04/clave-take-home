import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";

type QueryId =
  | "sales_by_location"
  | "top_items"
  | "hourly_sales"
  | "delivery_vs_dinein";

type RunWidgetBody = {
  query_id: QueryId;
  title?: string;
  note?: string;
  params?: Record<string, any>;
};

function canonicalLocation(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const key = raw.toLowerCase();
  const map: Record<string, string> = {
    downtown: "Downtown",
    airport: "Airport",
    mall: "Mall",
    "mall location": "Mall",
    university: "University",
  };

  return map[key] ?? raw;
}

function canonicalISODate(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function cleanNote(input: unknown): string | undefined {
  const s = typeof input === "string" ? input.trim() : "";
  return s ? s : undefined;
}

function classifyChannel(fulfillmentRaw: unknown, sourceRaw: unknown) {
  const fulfillment = String(fulfillmentRaw ?? "")
    .toLowerCase()
    .trim();
  const source = String(sourceRaw ?? "")
    .toLowerCase()
    .trim();

  // Strong signal: DoorDash => delivery/off-premise
  if (source.includes("doordash")) return "Delivery";

  // Fulfillment-based classification
  if (
    fulfillment.includes("delivery") ||
    fulfillment.includes("pickup") ||
    fulfillment.includes("takeout") ||
    fulfillment.includes("to-go") ||
    fulfillment.includes("togo") ||
    fulfillment.includes("carryout") ||
    fulfillment.includes("curbside")
  ) {
    return "Delivery"; // grouped with delivery for this widget
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RunWidgetBody;

    if (!body?.query_id) {
      return NextResponse.json({ error: "Missing query_id" }, { status: 400 });
    }

    const noteFromBody = cleanNote(body.note);

    // 1) Sales by Location (bar)
    if (body.query_id === "sales_by_location") {
      const { data, error } = await supabaseServer
        .from("v_orders")
        .select("location, total_cents");

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const rows = (data ?? []) as { location: string; total_cents: number }[];

      const totalsByLocation = new Map<string, number>();
      for (const r of rows) {
        const loc = r.location ?? "Unknown";
        const cents = Number(r.total_cents ?? 0);
        totalsByLocation.set(loc, (totalsByLocation.get(loc) ?? 0) + cents);
      }

      const result = Array.from(totalsByLocation.entries())
        .map(([location_name, sales_cents]) => ({ location_name, sales_cents }))
        .sort((a, b) => b.sales_cents - a.sales_cents);

      return NextResponse.json({
        widget: {
          id: "sales_by_location",
          title: body.title ?? "Sales by Location",
          note: noteFromBody,
          type: "bar",
          data: result,
        },
      });
    }

    // 2) Top Items (table)
    if (body.query_id === "top_items") {
      const limitRaw = body.params?.limit;
      const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 10;

      const { data, error } = await supabaseServer
        .from("v_order_items")
        .select("normalized_name, line_total_cents");

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const rows = (data ?? []) as {
        normalized_name: string;
        line_total_cents: number;
      }[];

      const totalsByItem = new Map<string, number>();
      for (const r of rows) {
        const name = r.normalized_name ?? "unknown";
        const cents = Number(r.line_total_cents ?? 0);
        totalsByItem.set(name, (totalsByItem.get(name) ?? 0) + cents);
      }

      const result = Array.from(totalsByItem.entries())
        .map(([normalized_name, sales_cents]) => ({
          normalized_name,
          sales_cents,
        }))
        .sort((a, b) => b.sales_cents - a.sales_cents)
        .slice(0, limit);

      return NextResponse.json({
        widget: {
          id: `top_items:${limit}`,
          title: body.title ?? "Top Items (by sales)",
          note: noteFromBody,
          type: "table",
          data: result,
        },
      });
    }

    // 3) Hourly Sales (line)
    if (body.query_id === "hourly_sales") {
      const location = canonicalLocation(body.params?.location);
      const order_date = canonicalISODate(body.params?.order_date);

      let q = supabaseServer
        .from("v_hourly_sales")
        .select("order_hour, sales_cents, location, order_date");

      if (location) q = q.eq("location", location);
      if (order_date) q = q.eq("order_date", order_date);

      const { data, error } = await q;

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const totals = new Map<number, number>();
      for (const r of (data ?? []) as any[]) {
        const hr = Number(r.order_hour);
        if (!Number.isFinite(hr)) continue;
        const cents = Number(r.sales_cents ?? 0);
        totals.set(hr, (totals.get(hr) ?? 0) + cents);
      }

      const series = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        sales_cents: totals.get(hour) ?? 0,
      }));

      const id = `hourly_sales:${location ?? "all"}:${order_date ?? "all"}`;

      return NextResponse.json({
        widget: {
          id,
          title:
            body.title ??
            `Hourly Sales${location ? ` — ${location}` : ""}${
              order_date ? ` (${order_date})` : ""
            }`,
          note: noteFromBody,
          type: "line",
          data: series,
        },
      });
    }

    // 4) Delivery vs Dine-in (pie)
    if (body.query_id === "delivery_vs_dinein") {
      const location = canonicalLocation(body.params?.location);
      const order_date = canonicalISODate(body.params?.order_date);

      let q = supabaseServer
        .from("v_orders")
        .select("total_cents, fulfillment, source, location, order_date");

      if (location) q = q.eq("location", location);
      if (order_date) q = q.eq("order_date", order_date);

      const { data, error } = await q;

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      let delivery = 0;
      let dinein = 0;
      let unknown = 0;

      for (const r of (data ?? []) as any[]) {
        const cents = Number(r.total_cents ?? 0);
        const channel = classifyChannel(r.fulfillment, r.source);

        if (channel === "Delivery") delivery += cents;
        else if (channel === "Dine-in") dinein += cents;
        else unknown += cents;
      }

      const extraNotes: string[] = [];
      if (noteFromBody) extraNotes.push(noteFromBody);

      extraNotes.push(
        `Delivery includes delivery + pickup/takeout when fulfillment indicates off-premise.`
      );

      if (unknown > 0) {
        extraNotes.push(
          `Some revenue couldn't be confidently classified and is shown as "Unknown" ($${(
            unknown / 100
          ).toFixed(2)}).`
        );
      }

      const result = [
        { channel: "Delivery", sales_cents: delivery },
        { channel: "Dine-in", sales_cents: dinein },
        { channel: "Unknown", sales_cents: unknown },
      ].filter((x) => x.sales_cents > 0);

      const id = `delivery_vs_dinein:${location ?? "all"}:${
        order_date ?? "all"
      }`;

      return NextResponse.json({
        widget: {
          id,
          title:
            body.title ??
            `Delivery vs Dine-in Revenue${location ? ` — ${location}` : ""}${
              order_date ? ` (${order_date})` : ""
            }`,
          note: extraNotes.join(" "),
          type: "pie",
          data: result,
        },
      });
    }

    return NextResponse.json({ error: "Unknown query_id" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
