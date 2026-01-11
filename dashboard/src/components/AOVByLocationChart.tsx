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

type Row = { location_name: string; value_cents: number; orders_count: number };

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AOVByLocationChart({
  data,
  valueLabel = "Value",
}: {
  data: Row[];
  valueLabel?: string;
}) {
  const chartData = (data ?? []).map((d) => ({
    ...d,
    value_dollars: d.value_cents / 100,
  }));

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="location_name" />
          <YAxis tickFormatter={(v) => `$${v}`} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p: any = payload[0].payload;
              return (
                <div
                  style={{
                    background: "white",
                    border: "1px solid #ddd",
                    borderRadius: 10,
                    padding: 10,
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    {label}
                  </div>
                  <div>
                    {valueLabel}:{" "}
                    <b>{dollars(Math.round(p.value_dollars * 100))}</b>
                  </div>
                  <div>
                    Orders: <b>{p.orders_count}</b>
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="value_dollars" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
