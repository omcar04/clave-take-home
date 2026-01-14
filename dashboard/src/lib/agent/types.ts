// src/lib/agent/types.ts
import { z } from "zod";

/** -------------------------------
 * Core enums
 * ------------------------------*/
export const MetricEnum = z.enum(["sales", "revenue"]);
export type Metric = z.infer<typeof MetricEnum>;

export const RecommendedWidgetEnum = z.enum([
  "bar",
  "line",
  "pie",
  "table",
  "metric",
]);
export type RecommendedWidget = z.infer<typeof RecommendedWidgetEnum>;

export const IntentEnum = z.enum([
  "comparison",
  "trend",
  "breakdown",
  "ranking",
  "single_value",
]);
export type Intent = z.infer<typeof IntentEnum>;

// ✅ Add aov_by_location here
export const QueryIdEnum = z.enum([
  "metric_total",
  "sales_by_location",
  "top_items",
  "hourly_sales",
  "daily_sales",
  "delivery_vs_dinein",
  "doordash_total",
  "doordash_revenue",
  "takeout_orders_by_location",
  "aov_by_location",

  // ✅ NEW: one query to power both:
  // - “beverage sales by location” (category filter -> bar)
  // - “which category generates most revenue” (ranking -> table)
  "sales_by_location_by_category",
]);
export type QueryId = z.infer<typeof QueryIdEnum>;

/** -------------------------------
 * Plan schema (LLM output)
 * ------------------------------*/
export const PlanActionSchema = z
  .object({
    intent: IntentEnum,
    recommended_widget: RecommendedWidgetEnum.optional(),
    query_id: QueryIdEnum.optional(),
    title: z.string().optional(),
    note: z.string().optional(),
    params: z
      .object({
        metric: MetricEnum.optional(),
        location: z.string().optional(),
        locations: z.array(z.string()).optional(),
        order_date: z.string().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.number().optional(),

        // ✅ NEW: for category filtering (ex: “Beverages”)
        category: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type PlanAction = z.infer<typeof PlanActionSchema>;

export const PlanSchema = z
  .object({
    assistant_message: z.string(),
    clarify_question: z.string().optional(),
    intent: IntentEnum.optional(),
    recommended_widget: RecommendedWidgetEnum.optional(),
    actions: z.array(PlanActionSchema).optional(),
  })
  .strict();

export type Plan = z.infer<typeof PlanSchema>;

/** -------------------------------
 * Widget types (server -> UI)
 * ------------------------------*/
export type BarWidget = {
  id: string;
  title: string;
  note?: string;
  type: "bar";
  value_type?: "currency" | "count";
  data: { location_name: string; sales_cents: number }[];
};

export type TableWidget = {
  id: string;
  title: string;
  note?: string;
  type: "table";
  value_type?: "currency" | "count";
  data: { normalized_name: string; sales_cents: number }[];
};

export type LineWidget = {
  id: string;
  title: string;
  note?: string;
  type: "line";
  data:
    | { hour: number; sales_cents: number }[]
    | { date: string; sales_cents: number }[];
};

export type PieWidget = {
  id: string;
  title: string;
  note?: string;
  type: "pie";
  data: { channel: string; sales_cents: number }[];
};

export type MetricWidget = {
  id: string;
  title: string;
  note?: string;
  type: "metric";
  value: number;
  value_type: "currency" | "count";
};

// ✅ NEW widget: AOV
export type AOVWidget = {
  id: string;
  title: string;
  note?: string;
  type: "aov";
  data: { location_name: string; value_cents: number; orders_count: number }[];
};

export type Widget =
  | BarWidget
  | TableWidget
  | LineWidget
  | PieWidget
  | MetricWidget
  | AOVWidget;
