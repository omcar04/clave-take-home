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

export default function SalesByLocationChart({ data }: { data: Row[] }) {
  const chartData = data.map((d) => ({
    ...d,
    sales_dollars: Number((d.sales_cents / 100).toFixed(2)),
  }));

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="location_name" />
          <YAxis />
          <Tooltip
            formatter={(value) => [`$${value}`, "Sales"]}
            labelFormatter={(label) => `Location: ${label}`}
          />
          <Bar dataKey="sales_dollars" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
