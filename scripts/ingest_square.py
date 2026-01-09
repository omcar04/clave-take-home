import json, os
from dotenv import load_dotenv
from typing import Optional
from supabase import create_client
from normalize import normalize_name, normalize_category

load_dotenv()

sb = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
)

SQUARE_LOC_TO_CANON = {
    "LCN001DOWNTOWN": "Downtown",
    "LCN002AIRPORT": "Airport",
    "LCN003MALL": "Mall",
    "LCN004UNIV": "University",
}

def upsert_location(name: str) -> str:
    sb.table("locations").upsert({"name": name}, on_conflict="name").execute()
    return sb.table("locations").select("id").eq("name", name).single().execute().data["id"]

def to_int_cents(money_obj):
    # Square money is { "amount": 123, "currency": "USD" }
    if not money_obj:
        return 0
    return int(money_obj.get("amount") or 0)

def pick_ordered_at(o: dict) -> Optional[str]:
    return o.get("closed_at") or o.get("created_at")

def build_catalog_maps(catalog):
    """
    Returns:
      variation_id -> {name, item_name, category_name}
    """
    # category_id -> category_name
    category_names = {}
    # item_id -> {item_name, category_id}
    items = {}
    # variation_id -> {variation_name, item_id}
    variations = {}

    for obj in catalog.get("objects", []):
        t = obj.get("type")
        if t == "CATEGORY":
            category_names[obj["id"]] = (obj.get("category_data") or {}).get("name")
        elif t == "ITEM":
            data = obj.get("item_data") or {}
            items[obj["id"]] = {
                "name": data.get("name"),
                "category_id": data.get("category_id"),
            }
            for v in data.get("variations", []):
                variations[v["id"]] = {
                    "variation_name": (v.get("item_variation_data") or {}).get("name"),
                    "item_id": obj["id"],
                }

    variation_map = {}
    for var_id, v in variations.items():
        item = items.get(v["item_id"], {})
        cat_name = category_names.get(item.get("category_id"))
        variation_map[var_id] = {
            "item_name": item.get("name"),
            "variation_name": v.get("variation_name"),
            "category_name": cat_name,
        }

    return variation_map

def main():
    catalog_path = "data/sources/square/catalog.json"
    orders_path = "data/sources/square/orders.json"

    with open(catalog_path, "r") as f:
        catalog = json.load(f)
    with open(orders_path, "r") as f:
        orders_blob = json.load(f)

    variation_map = build_catalog_maps(catalog)

    loc_id = {name: upsert_location(name) for name in set(SQUARE_LOC_TO_CANON.values())}

    orders = orders_blob.get("orders", [])
    for o in orders:
        sq_loc = o.get("location_id")
        canon_loc = SQUARE_LOC_TO_CANON.get(sq_loc)
        if not canon_loc:
            continue

        ordered_at = o.get("closed_at") or o.get("created_at")
        if not ordered_at:
            continue

        fulfillment = "UNKNOWN"
        fulfills = o.get("fulfillments") or []
        if fulfills and isinstance(fulfills, list):
            fulfillment = (fulfills[0] or {}).get("type") or "UNKNOWN"

        item_sales = to_int_cents(o.get("total_money"))
        tax = to_int_cents(o.get("total_tax_money"))
        tip = to_int_cents(o.get("total_tip_money"))
        total = to_int_cents(o.get("total_money"))
        if total == 0:
            total = item_sales + tax + tip

        source_order_id = o.get("id")
        if not source_order_id:
            continue

        order_payload = {
            "source": "SQUARE",
            "source_detail": (o.get("source") or {}).get("name") or "SQUARE",
            "source_order_id": str(source_order_id),
            "location_id": loc_id[canon_loc],
            "ordered_at": ordered_at,
            "fulfillment": fulfillment,
            "item_sales_cents": item_sales,
            "tax_cents": tax,
            "tip_cents": tip,
            "fees_cents": 0,
            "total_cents": total,
        }

        sb.table("orders").upsert(order_payload, on_conflict="source,source_order_id").execute()

        order_id = sb.table("orders").select("id") \
            .eq("source","SQUARE").eq("source_order_id", str(source_order_id)) \
            .single().execute().data["id"]

        sb.table("order_items").delete().eq("order_id", order_id).execute()

        item_rows = []
        for li in o.get("line_items", []):
            qty = float(li.get("quantity") or 1)

            # Resolve name/category from catalog_object_id (variation id)
            catalog_obj_id = li.get("catalog_object_id")
            cat = variation_map.get(catalog_obj_id, {})

            raw_name = li.get("name") or cat.get("item_name") or "unknown"
            # If variation exists, append it lightly so it's still queryable
            variation_name = cat.get("variation_name")
            if variation_name and variation_name.lower() not in ("regular", "default"):
                raw_name = f"{raw_name} - {variation_name}"

            raw_cat = cat.get("category_name")

            line_total = to_int_cents((li.get("total_money") or {}))
            if line_total == 0:
                line_total = to_int_cents(li.get("gross_sales_money"))

            unit_price = None
            if qty and line_total:
                unit_price = int(line_total / qty)

            item_rows.append({
                "order_id": order_id,
                "raw_name": raw_name,
                "normalized_name": normalize_name(raw_name),
                "raw_category": raw_cat,
                "normalized_category": normalize_category(raw_cat),
                "quantity": qty,
                "unit_price_cents": unit_price,
                "line_total_cents": line_total,
            })

        if item_rows:
            sb.table("order_items").insert(item_rows).execute()

    print("Square ingestion done")

if __name__ == "__main__":
    main()
