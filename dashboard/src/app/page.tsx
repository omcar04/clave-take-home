"use client";

import { useMemo, useState } from "react";
import SalesByLocationChart from "@/components/SalesByLocationChart";
import HourlySalesChart from "@/components/HourlySalesChart";
import ChannelRevenueChart from "@/components/ChannelRevenueChart";

type BarWidget = {
  id: string;
  title: string;
  note?: string;
  type: "bar";
  data: { location_name: string; sales_cents: number }[];
};

type TableWidget = {
  id: string;
  title: string;
  note?: string;
  type: "table";
  data: { normalized_name: string; sales_cents: number }[];
};

type LineWidget = {
  id: string;
  title: string;
  note?: string;
  type: "line";
  data: { hour: number; sales_cents: number }[];
};

type PieWidget = {
  id: string;
  title: string;
  note?: string;
  type: "pie";
  data: { channel: string; sales_cents: number }[];
};

type Widget = BarWidget | TableWidget | LineWidget | PieWidget;

type NLResponse = {
  widget?: {
    title?: string;
    note?: string | null;
    query_id: string;
    params?: Record<string, any>;
  };
  error?: string;
};

const SUPPORTED_QUERY_IDS = new Set([
  "sales_by_location",
  "top_items",
  "hourly_sales",
  "delivery_vs_dinein",
]);

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Page() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canRun = useMemo(() => {
    return !loading && message.trim().length > 0;
  }, [loading, message]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const trimmed = message.trim();
    if (!trimmed) return;

    setLoading(true);

    try {
      const nlRes = await fetch("/api/nl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      const nlJson = (await nlRes.json()) as NLResponse;

      if (!nlRes.ok || nlJson.error || !nlJson.widget?.query_id) {
        throw new Error(nlJson.error ?? "Natural language step failed");
      }

      const { query_id, params, title, note } = nlJson.widget;

      if (!SUPPORTED_QUERY_IDS.has(query_id)) {
        setErr(
          `I can currently do: "sales by location", "top items", "hourly sales", and "delivery vs dine-in".`
        );
        return;
      }

      const runRes = await fetch("/api/run-widget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query_id,
          params,
          title,
          note: note ?? undefined,
        }),
      });

      const runJson = await runRes.json();

      if (!runRes.ok || runJson.error || !runJson.widget) {
        throw new Error(runJson.error ?? "Run-widget step failed");
      }

      const newWidget = runJson.widget as Widget;

      setWidgets((prev) => {
        const withoutSameId = prev.filter((w) => w.id !== newWidget.id);
        return [newWidget, ...withoutSameId];
      });

      setMessage("");
    } catch (e: any) {
      setErr(e?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 900 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Restaurant Dashboard</h1>

      <form
        onSubmit={onSubmit}
        style={{ marginTop: 16, display: "flex", gap: 8 }}
      >
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Try: "delivery vs dine-in revenue"'
          disabled={loading}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            opacity: loading ? 0.7 : 1,
          }}
        />
        <button
          type="submit"
          disabled={!canRun}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: !canRun ? "#f3f3f3" : "white",
            cursor: !canRun ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {loading ? "Running..." : "Run"}
        </button>
      </form>

      {err ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 10,
            border: "1px solid #f5c2c7",
            background: "#f8d7da",
          }}
        >
          {err}
        </div>
      ) : null}

      {widgets.length === 0 ? (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 12,
            border: "1px dashed #ddd",
            color: "#555",
          }}
        >
          Ask a question to generate a widget.
          <div style={{ marginTop: 8, color: "#777" }}>
            Examples: “show me hourly sales”, “show me sales by location”, “top
            items”, “delivery vs dine-in revenue”
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
        {widgets.map((w) => (
          <section
            key={w.id}
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              {w.title}
            </h2>

            {w.note ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ffe69c",
                  background: "#fff3cd",
                  color: "#664d03",
                  fontSize: 14,
                }}
              >
                {w.note}
              </div>
            ) : null}

            {w.type === "bar" ? (
              <SalesByLocationChart data={w.data} />
            ) : w.type === "line" ? (
              <HourlySalesChart data={w.data} />
            ) : w.type === "pie" ? (
              <ChannelRevenueChart data={w.data} />
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid #ddd",
                        paddingBottom: 8,
                      }}
                    >
                      Item
                    </th>
                    <th
                      style={{
                        textAlign: "right",
                        borderBottom: "1px solid #ddd",
                        paddingBottom: 8,
                      }}
                    >
                      Sales
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {w.data.map((r) => (
                    <tr key={r.normalized_name}>
                      <td style={{ paddingTop: 8 }}>{r.normalized_name}</td>
                      <td style={{ paddingTop: 8, textAlign: "right" }}>
                        {dollars(r.sales_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
