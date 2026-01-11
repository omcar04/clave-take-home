import { NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LocationEnum = z.enum(["Downtown", "Airport", "Mall", "University"]);

const PlanSchema = z.object({
  widget: z.object({
    title: z.string(),
    note: z.string().nullish(), // ✅ allow null OR undefined
    query_id: z.enum([
      "sales_by_location",
      "top_items",
      "hourly_sales",
      "delivery_vs_dinein",
    ]),
    params: z
      .object({
        location: LocationEnum.nullish(),
        order_date: z.string().nullish(), // YYYY-MM-DD or null
        limit: z.number().int().positive().max(50).nullish(),
      })
      .optional(),
  }),
});

function buildPrompt(userMessage: string) {
  return `
You are a restaurant analytics assistant.
You must respond with ONLY valid JSON. No markdown, no code fences, no commentary.

Data facts:
- Locations are ONLY: "Downtown", "Airport", "Mall", "University"
- Data covers 2025-01-01 to 2025-01-04 (inclusive). There is NO data outside this range.

Supported query_id values:
1) "sales_by_location" -> total sales by location
2) "top_items" -> top selling items by sales
3) "hourly_sales" -> hourly sales line chart (optional filters: location and/or order_date)
4) "delivery_vs_dinein" -> revenue breakdown by channel (Delivery vs Dine-in) (optional filters: location and/or order_date)

Rules:
- If user mentions a specific location, set params.location to exactly one of the allowed locations.
- If user does NOT mention a location, set params.location to null (or omit params).
- If user asks for a specific date:
  - If it is within 2025-01-01..2025-01-04, set params.order_date to "YYYY-MM-DD".
  - If it is OUTSIDE that range, set params.order_date to null AND set widget.note explaining:
    "Data only covers 2025-01-01 to 2025-01-04; ignoring requested date <date>."
- For "top_items":
  - If user says "top 5", set params.limit = 5.
  - Otherwise default to 10.
- For "delivery_vs_dinein":
  - This uses the order fulfillment/channel fields. If unclear, still pick this query_id and omit filters.
- If request is unclear overall, default to query_id = "sales_by_location".

IMPORTANT: If you include "note", it must be a string. If you have no note, omit it.

User message: "${userMessage}"

Return JSON in this exact shape:
{
  "widget": {
    "title": "...",
    "note": "... (optional)",
    "query_id": "sales_by_location" | "top_items" | "hourly_sales" | "delivery_vs_dinein",
    "params": {
      "location": "Downtown" | "Airport" | "Mall" | "University" | null,
      "order_date": "YYYY-MM-DD" | null,
      "limit": number | null
    }
  }
}
`.trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = String(body?.message ?? "").trim();

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY not set" },
        { status: 500 }
      );
    }

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: buildPrompt(message) }],
    });

    const text = resp.choices?.[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Model returned non-JSON", raw: text },
        { status: 500 }
      );
    }

    const plan = PlanSchema.parse(parsed);

    // Normalize note: null -> undefined (so UI and run-widget don’t choke)
    const cleanedNote =
      typeof plan.widget.note === "string" && plan.widget.note.trim()
        ? plan.widget.note.trim()
        : undefined;
    (plan.widget as any).note = cleanedNote;

    // Defaults: top_items limit
    if (plan.widget.query_id === "top_items") {
      const limit = plan.widget.params?.limit ?? 10;
      plan.widget.params = { ...(plan.widget.params ?? {}), limit };
    }

    // Ensure params exists and is consistent
    if (!plan.widget.params) {
      plan.widget.params = {
        location: null,
        order_date: null,
        limit: null,
      };
    } else {
      plan.widget.params = {
        location: plan.widget.params.location ?? null,
        order_date: plan.widget.params.order_date ?? null,
        limit: plan.widget.params.limit ?? null,
      };
    }

    return NextResponse.json(plan);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
