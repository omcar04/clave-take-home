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

type Row = {
  date: string; // YYYY-MM-DD
  sales_cents: number;
};

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function DailySalesChart({ data }: { data: Row[] }) {
  const chartData = (data ?? []).map((d) => ({
    date: d.date,
    sales_cents: d.sales_cents,
    sales_dollars: d.sales_cents / 100,
  }));

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: any, name) => {
              if (name === "sales_dollars") return dollars(Number(value) * 100);
              return value;
            }}
            labelFormatter={(label) => `Date ${label}`}
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
