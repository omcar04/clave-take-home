# Data Source Map (Toast + DoorDash + Square)

## Location Mapping (canonical)

| Canonical  | Toast guid       | DoorDash store_id  | Square location_id |
| ---------- | ---------------- | ------------------ | ------------------ |
| Downtown   | loc_downtown_001 | str_downtown_001   | LCN001DOWNTOWN     |
| Airport    | loc_airport_002  | str_airport_002    | LCN002AIRPORT      |
| Mall       | loc_mall_003     | str_mall_003       | LCN003MALL         |
| University | loc_univ_004     | str_university_004 | LCN004UNIV         |

## Canonical Field Mapping

| Field (canonical)  | Toast                                 | DoorDash                        | Square                                  |
| ------------------ | ------------------------------------- | ------------------------------- | --------------------------------------- |
| canonical_order_id | `toast:order.guid`                    | `doordash:external_delivery_id` | `square:orders.id`                      |
| source             | `TOAST`                               | `DOORDASH`                      | `SQUARE`                                |
| location_id        | `order.restaurantGuid`                | `order.store_id`                | `order.location_id`                     |
| ordered_at         | prefer `paidDate` (else `closedDate`) | `created_at`                    | `closed_at` (else `created_at`)         |
| fulfillment        | `diningOption.behavior`               | `order_fulfillment_method`      | `fulfillments[].type`                   |
| items              | `checks[].selections[]`               | `order_items[]`                 | `line_items[]` (join to `catalog.json`) |
| payments           | `checks[].payments[]`                 | order-level fields              | `payments.json` (join by `order_id`)    |

## Additions (the 3 upgrades)

### 1) Order totals / money fields (all in cents)

| Money field (canonical) | Toast (check-level)                             | DoorDash (order-level)                        | Square (order-level)                                   |
| ----------------------- | ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| item_sales_cents        | `check.amount` (or sum `selection.price`)       | `order.order_subtotal`                        | `order.total_money.amount` (or sum line item totals)   |
| tax_cents               | `check.taxAmount` (or sum `selection.tax`)      | `order.tax_amount`                            | `order.total_tax_money.amount`                         |
| tip_cents               | `check.tipAmount` (and/or sum payment tips)     | `order.dasher_tip`                            | `order.total_tip_money.amount`                         |
| fees_cents              | typically `0` (unless you choose to model fees) | `delivery_fee + service_fee` (optionally add) | typically `0`                                          |
| total_cents             | `check.totalAmount`                             | `total_charged_to_consumer` (or compute)      | `order.total_money.amount` (+ tax/tip already tracked) |

> Notes:
>
> - Toast is easiest if you treat each **check** as the “financial truth” for totals.
> - DoorDash includes platform-ish fields like `commission` and `merchant_payout` — decide if you store them (nice-to-have).
> - Square totals are already present on the order.

### 2) Channel / source detail (what “system” it came from)

| Field (canonical)     | Toast                                   | DoorDash          | Square                                              |
| --------------------- | --------------------------------------- | ----------------- | --------------------------------------------------- |
| source_detail/channel | `order.source` (POS/ONLINE/THIRD_PARTY) | always `DOORDASH` | `orders[].source.name` (Square POS / Square Online) |

### 3) Item price fields (line-item pricing)

| Field (canonical) | Toast selections[]                    | DoorDash order_items[]   | Square line_items[]                         |
| ----------------- | ------------------------------------- | ------------------------ | ------------------------------------------- |
| raw_item_name     | `selection.displayName` / `item.name` | `item.name`              | from `catalog.json` via `catalog_object_id` |
| raw_category      | `selection.itemGroup.name`            | `item.category`          | from catalog item/category_id               |
| quantity          | `selection.quantity` (number)         | `item.quantity` (number) | `line_item.quantity` (string → number)      |
| unit_price_cents  | derive if needed (`price/quantity`)   | `item.unit_price`        | can derive from catalog variation price     |
| line_total_cents  | `selection.price`                     | `item.total_price`       | `line_item.total_money.amount` (or gross)   |

## Cleaning targets (what to normalize later)

- Item name normalization (typos, casing, whitespace)
- Category normalization (strip emojis, casing)
- Variants (e.g., “12pc”, “lg”, “reg”) → optional `variant` field
- Cross-source matching (e.g., Hash Browns vs Hashbrowns)

## Timestamp rule (simple)

- Toast: `paidDate > closedDate > openedDate`
- Square: `closed_at > created_at`
- DoorDash: use `created_at`
