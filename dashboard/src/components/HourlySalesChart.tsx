"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type HourPoint = { hour: number; sales_cents: number };
type DayPoint = { date: string; sales_cents: number };

export default function HourlySalesChart(props: {
  data: (HourPoint | DayPoint)[];
}) {
  const { data } = props;

  const isDaily = data.length > 0 && "date" in (data[0] as any);
  const xKey = isDaily ? "date" : "hour";

  function formatCurrency(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer>
        <LineChart data={data as any}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            tickFormatter={(v) => (isDaily ? String(v) : `${v}:00`)}
          />
          <YAxis tickFormatter={(v) => String(v)} />
          <Tooltip
            formatter={(value: any) => {
              // Heuristic:
              // - if values look like small counts (<= 200), show as number
              // - else treat as cents
              const n = Number(value ?? 0);
              if (Number.isFinite(n) && n <= 200) return [n, "Value"];
              return [formatCurrency(n), "Value"];
            }}
            labelFormatter={(label) =>
              isDaily ? `Date: ${label}` : `Hour: ${label}:00`
            }
          />
          <Line type="monotone" dataKey="sales_cents" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
