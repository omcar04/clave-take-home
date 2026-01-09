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

TOAST_LOC_TO_CANON = {
    "loc_downtown_001": "Downtown",
    "loc_airport_002": "Airport",
    "loc_mall_003": "Mall",
    "loc_univ_004": "University",
}

def pick_ordered_at(o: dict) -> Optional[str]:
    return o.get("paidDate") or o.get("closedDate") or o.get("openedDate")

def upsert_location(name: str) -> str:
    sb.table("locations").upsert({"name": name}, on_conflict="name").execute()
    return sb.table("locations").select("id").eq("name", name).single().execute().data["id"]

def main():
    # adjust this path if your repo differs
    path = "data/sources/toast_pos_export.json"
    with open(path, "r") as f:
        toast = json.load(f)

    loc_id = {name: upsert_location(name) for name in set(TOAST_LOC_TO_CANON.values())}

    for o in toast.get("orders", []):
        canon_loc = TOAST_LOC_TO_CANON.get(o.get("restaurantGuid"))
        if not canon_loc:
            continue

        ordered_at = pick_ordered_at(o)
        if not ordered_at:
            continue

        fulfillment = (o.get("diningOption") or {}).get("behavior") or "UNKNOWN"
        source_detail = o.get("source") or "TOAST"

        item_sales = tax = tip = total = 0
        item_rows = []

        for chk in o.get("checks", []):
            item_sales += int(chk.get("amount") or 0)
            tax       += int(chk.get("taxAmount") or 0)
            tip       += int(chk.get("tipAmount") or 0)
            total     += int(chk.get("totalAmount") or 0)

            for sel in chk.get("selections", []):
                raw_name = sel.get("displayName") or (sel.get("item") or {}).get("name") or "unknown"
                raw_cat = (sel.get("itemGroup") or {}).get("name")
                qty = float(sel.get("quantity") or 1)
                line_total = int(sel.get("price") or 0)

                item_rows.append({
                    "raw_name": raw_name,
                    "normalized_name": normalize_name(raw_name),
                    "raw_category": raw_cat,
                    "normalized_category": normalize_category(raw_cat),
                    "quantity": qty,
                    "unit_price_cents": None,
                    "line_total_cents": line_total,
                })

        order_payload = {
            "source": "TOAST",
            "source_detail": source_detail,
            "source_order_id": o["guid"],
            "location_id": loc_id[canon_loc],
            "ordered_at": ordered_at,
            "fulfillment": fulfillment,
            "item_sales_cents": item_sales,
            "tax_cents": tax,
            "tip_cents": tip,
            "fees_cents": 0,
            "total_cents": total if total else (item_sales + tax + tip),
        }

        # Upsert order
        sb.table("orders").upsert(order_payload, on_conflict="source,source_order_id").execute()

        # Fetch order id
        order_id = sb.table("orders").select("id") \
            .eq("source","TOAST").eq("source_order_id", o["guid"]).single().execute().data["id"]

        # Prevent duplicates if you rerun script
        sb.table("order_items").delete().eq("order_id", order_id).execute()

        # Insert items
        if item_rows:
            for r in item_rows:
                r["order_id"] = order_id
            sb.table("order_items").insert(item_rows).execute()

    print("✅ Toast ingestion done")

if __name__ == "__main__":
    main()
