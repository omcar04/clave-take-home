import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";

type LocationRow = { id: string; name: string };
type OrderRow = {
  location_id: string;
  total_cents: number;
  ordered_at: string;
};
type OrderItemRow = { normalized_name: string; line_total_cents: number };
type OrderIdRow = { id: string };

export async function GET() {
  // locations lookup
  const locRes = await supabaseServer.from("locations").select("id,name");
  if (locRes.error)
    return NextResponse.json({ error: locRes.error.message }, { status: 500 });

  const locs = (locRes.data || []) as LocationRow[];
  const locNameById = new Map(locs.map((l) => [l.id, l.name]));

  // orders (for sales by location)
  const ordersRes = await supabaseServer
    .from("orders")
    .select("location_id,total_cents,ordered_at");
  if (ordersRes.error)
    return NextResponse.json(
      { error: ordersRes.error.message },
      { status: 500 }
    );

  const orders = (ordersRes.data || []) as OrderRow[];

  const salesByLocationMap = new Map<string, number>();
  for (const o of orders) {
    const name = locNameById.get(o.location_id) || "Unknown";
    const total = Number(o.total_cents ?? 0);
    salesByLocationMap.set(name, (salesByLocationMap.get(name) || 0) + total);
  }

  const salesByLocation = Array.from(salesByLocationMap.entries())
    .map(([location_name, sales_cents]) => ({ location_name, sales_cents }))
    .sort((a, b) => b.sales_cents - a.sales_cents);

  // get order ids (so we only count items that belong to real orders)
  const orderIdsRes = await supabaseServer.from("orders").select("id");
  if (orderIdsRes.error)
    return NextResponse.json(
      { error: orderIdsRes.error.message },
      { status: 500 }
    );

  const orderIds = new Set(
    ((orderIdsRes.data || []) as OrderIdRow[]).map((r) => r.id)
  );

  // order_items (top items)
  const itemsRes = await supabaseServer
    .from("order_items")
    .select("order_id,normalized_name,line_total_cents");
  if (itemsRes.error)
    return NextResponse.json(
      { error: itemsRes.error.message },
      { status: 500 }
    );

  const itemsRaw = itemsRes.data || [];
  const topItemsMap = new Map<string, number>();

  for (const it of itemsRaw as any[]) {
    if (!orderIds.has(it.order_id)) continue;
    const name = (it.normalized_name || "unknown").trim();
    const sales = Number(it.line_total_cents ?? 0);
    topItemsMap.set(name, (topItemsMap.get(name) || 0) + sales);
  }

  const topItems = Array.from(topItemsMap.entries())
    .map(([normalized_name, sales_cents]) => ({ normalized_name, sales_cents }))
    .sort((a, b) => b.sales_cents - a.sales_cents)
    .slice(0, 10);

  return NextResponse.json({
    widgets: [
      {
        id: "sales_by_location",
        title: "Sales by Location",
        type: "bar",
        data: salesByLocation,
      },
      {
        id: "top_items",
        title: "Top Items (by sales)",
        type: "table",
        data: topItems,
      },
    ],
  });
}
