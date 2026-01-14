"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

type HourPoint = { hour: number; sales_cents: number };
type DatePoint = { date: string; sales_cents: number };

export type LineSeriesPoint = HourPoint | DatePoint;

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function isHourlyPoint(p: any): p is HourPoint {
  return p && typeof p.hour === "number";
}

export default function LineSeriesChart({
  data,
  valueLabel = "Sales",
}: {
  data: LineSeriesPoint[];
  valueLabel?: string;
}) {
  const arr = Array.isArray(data) ? data : [];
  const first = arr[0];

  const mode: "hourly" | "daily" = isHourlyPoint(first) ? "hourly" : "daily";
  const xKey = mode === "hourly" ? "hour_label" : "date";

  const chartData = arr.map((p: any) => {
    const sales_cents = Number(p?.sales_cents ?? 0);
    const sales_dollars = sales_cents / 100;

    if (mode === "hourly") {
      const h = Number(p?.hour ?? 0);
      const hour_label = Number.isFinite(h) ? `${h}:00` : "";
      return { hour: h, hour_label, sales_cents, sales_dollars };
    }

    return { date: String(p?.date ?? ""), sales_cents, sales_dollars };
  });

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xKey} />
          <YAxis tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: any, name) => {
              if (name === "sales_dollars") return dollars(Number(value) * 100);
              return value;
            }}
            labelFormatter={(label) =>
              mode === "hourly" ? `Hour ${label}` : `Date ${label}`
            }
          />
          <Line
            type="monotone"
            dataKey="sales_dollars"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
