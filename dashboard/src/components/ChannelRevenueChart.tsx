"use client";

import {
  PieChart,
  Pie,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";

type Row = { channel: string; sales_cents: number };

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ✅ simple palette (you can tweak these)
const COLORS = ["#4F46E5", "#22C55E", "#F59E0B", "#EF4444", "#06B6D4"];

export default function ChannelRevenueChart({ data }: { data: Row[] }) {
  const chartData = (data ?? []).map((d) => ({
    ...d,
    sales_dollars: d.sales_cents / 100,
  }));

  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="sales_dollars"
            nameKey="channel"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
          >
            {chartData.map((_, idx) => (
              <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Pie>

          <Tooltip
            formatter={(value: any) => dollars(Math.round(Number(value) * 100))}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
