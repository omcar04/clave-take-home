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

export default function SalesByLocationChart({ data }: { data: Row[] }) {
  const maxVal = Math.max(0, ...data.map((d) => Number(d.sales_cents ?? 0)));
  const treatAsCount = maxVal <= 500; // takeout counts, etc.

  const chartData = data.map((d) => ({
    ...d,
    value: treatAsCount ? d.sales_cents : d.sales_cents, // keep cents as-is; formatting handles display
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
