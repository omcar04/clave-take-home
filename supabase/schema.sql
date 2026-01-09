create extension if not exists pgcrypto;

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_detail text,
  source_order_id text not null,
  location_id uuid not null references locations(id),
  ordered_at timestamptz not null,
  fulfillment text not null,
  item_sales_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  tip_cents bigint not null default 0,
  fees_cents bigint not null default 0,
  total_cents bigint not null default 0,
  unique (source, source_order_id)
);

create index if not exists idx_orders_location_time
  on orders (location_id, ordered_at);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  raw_name text not null,
  normalized_name text not null,
  raw_category text,
  normalized_category text,
  quantity numeric not null default 1,
  unit_price_cents bigint,
  line_total_cents bigint not null default 0
);

create index if not exists idx_order_items_order on order_items (order_id);
create index if not exists idx_order_items_norm_name on order_items (normalized_name);
