import json, os
from dotenv import load_dotenv
from supabase import create_client
from normalize import normalize_name, normalize_category

load_dotenv()

sb = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
)

DD_LOC_TO_CANON = {
    "str_downtown_001": "Downtown",
    "str_airport_002": "Airport",
    "str_mall_003": "Mall",
    "str_university_004": "University",
}

def upsert_location(name: str) -> str:
    sb.table("locations").upsert({"name": name}, on_conflict="name").execute()
    return sb.table("locations").select("id").eq("name", name).single().execute().data["id"]

def to_int_cents(x):
    # DoorDash fields might already be ints; handle None safely
    try:
        return int(x or 0)
    except Exception:
        return 0

def main():
    path = "data/sources/doordash_orders.json"
    with open(path, "r") as f:
        dd = json.load(f)

    loc_id = {name: upsert_location(name) for name in set(DD_LOC_TO_CANON.values())}

    # Depending on file shape, orders may live at top-level "orders"
    orders = dd.get("orders", [])
    for o in orders:
        store_id = o.get("store_id")
        canon_loc = DD_LOC_TO_CANON.get(store_id)
        if not canon_loc:
            continue

        ordered_at = o.get("created_at")
        if not ordered_at:
            continue

        fulfillment = o.get("order_fulfillment_method") or "UNKNOWN"

        # money fields (already cents in this dataset)
        item_sales = to_int_cents(o.get("order_subtotal"))
        tax = to_int_cents(o.get("tax_amount"))
        tip = to_int_cents(o.get("dasher_tip"))

        delivery_fee = to_int_cents(o.get("delivery_fee"))
        service_fee = to_int_cents(o.get("service_fee"))
        fees = delivery_fee + service_fee

        total = to_int_cents(o.get("total_charged_to_consumer"))
        if total == 0:
            total = item_sales + tax + tip + fees

        source_order_id = o.get("external_delivery_id") or o.get("id")
        if not source_order_id:
            continue

        order_payload = {
            "source": "DOORDASH",
            "source_detail": "DOORDASH",
            "source_order_id": str(source_order_id),
            "location_id": loc_id[canon_loc],
            "ordered_at": ordered_at,
            "fulfillment": fulfillment,
            "item_sales_cents": item_sales,
            "tax_cents": tax,
            "tip_cents": tip,
            "fees_cents": fees,
            "total_cents": total,
        }

        sb.table("orders").upsert(order_payload, on_conflict="source,source_order_id").execute()

        order_id = sb.table("orders").select("id") \
            .eq("source","DOORDASH").eq("source_order_id", str(source_order_id)) \
            .single().execute().data["id"]

        # prevent duplicates on rerun
        sb.table("order_items").delete().eq("order_id", order_id).execute()

        item_rows = []
        for it in o.get("order_items", []):
            raw_name = it.get("name") or "unknown"
            raw_cat = it.get("category")
            qty = float(it.get("quantity") or 1)

            # in this dataset: item.unit_price / total_price are cents
            unit_price = to_int_cents(it.get("unit_price"))
            line_total = to_int_cents(it.get("total_price"))
            if line_total == 0 and unit_price:
                line_total = int(unit_price * qty)

            item_rows.append({
                "order_id": order_id,
                "raw_name": raw_name,
                "normalized_name": normalize_name(raw_name),
                "raw_category": raw_cat,
                "normalized_category": normalize_category(raw_cat),
                "quantity": qty,
                "unit_price_cents": unit_price or None,
                "line_total_cents": line_total,
            })

        if item_rows:
            sb.table("order_items").insert(item_rows).execute()

    print("✅ DoorDash ingestion done")

if __name__ == "__main__":
    main()
