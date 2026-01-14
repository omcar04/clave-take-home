"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

type Row = { location_name: string; sales_cents: number };

function formatDollarsFromCents(cents: number) {
  const dollars = cents / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDollarsTooltipFromCents(cents: number) {
  const dollars = cents / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function SalesByLocationChart({
  data,
  valueType,
}: {
  data: Row[];
  valueType?: "currency" | "count";
}) {
  // If caller explicitly says "count", treat as count.
  // Otherwise keep your heuristic (helps when older widgets don't send value_type).
  const maxVal = Math.max(
    0,
    ...(data ?? []).map((d) => Number(d.sales_cents ?? 0))
  );
  const treatAsCount = valueType === "count" ? true : maxVal <= 500;

  const chartData = (data ?? []).map((d) => ({
    ...d,
    value: d.sales_cents, // keep cents/counts as-is; formatting controls display
  }));

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="location_name" />
          <YAxis
            tickFormatter={(v) =>
              treatAsCount ? String(v) : formatDollarsFromCents(Number(v))
            }
          />
          <Tooltip
            formatter={(value: any) => {
              const n = Number(value ?? 0);
              if (treatAsCount) return [n, "Orders"];
              return [formatDollarsTooltipFromCents(n), "Sales"];
            }}
            labelFormatter={(label) => `Location: ${label}`}
          />
          <Bar dataKey="value" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
