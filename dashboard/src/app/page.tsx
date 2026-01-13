// ✅ MODIFIED FILE: app/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SalesByLocationChart from "@/components/SalesByLocationChart";
import HourlySalesChart from "@/components/HourlySalesChart";
import ChannelRevenueChart from "@/components/ChannelRevenueChart";
import Image from "next/image";

type BarWidget = {
  id: string;
  title: string;
  note?: string;
  type: "bar";
  value_type?: "currency" | "count";
  data: { location_name: string; sales_cents: number }[];
};

type TableWidget = {
  id: string;
  title: string;
  note?: string;
  type: "table";
  value_type?: "currency" | "count";
  data: { normalized_name: string; sales_cents: number }[];
};

type LineWidget = {
  id: string;
  title: string;
  note?: string;
  type: "line";
  data:
    | { hour: number; sales_cents: number }[]
    | { date: string; sales_cents: number }[];
};

type PieWidget = {
  id: string;
  title: string;
  note?: string;
  type: "pie";
  data: { channel: string; sales_cents: number }[];
};

// ✅ NEW metric widget
type MetricWidget = {
  id: string;
  type: "metric";
  title: string;
  value: number; // cents for currency
  value_type: "currency" | "count";
  note?: string;
};

type Widget = BarWidget | TableWidget | LineWidget | PieWidget | MetricWidget;

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  widgets?: Widget[];
};

type AgentResponse = {
  ok: boolean;
  error?: string;
  assistant_message?: string;
  clarify_question?: string | null;
  widgets?: Widget[];
};

function uid(prefix = "t") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatMetricValue(value: number, valueType: "currency" | "count") {
  return valueType === "count" ? `${Math.round(value)}` : dollars(value);
}

function sumSalesCents(
  data:
    | { hour: number; sales_cents: number }[]
    | { date: string; sales_cents: number }[]
): number {
  return (data as any[]).reduce(
    (sum, p) => sum + Number(p?.sales_cents ?? 0),
    0
  );
}

function getPeakPoint(
  data:
    | { hour: number; sales_cents: number }[]
    | { date: string; sales_cents: number }[]
) {
  const arr = data as any[];
  if (!arr.length) return null;

  return arr.reduce((best, p) => {
    const bv = Number(best?.sales_cents ?? 0);
    const pv = Number(p?.sales_cents ?? 0);
    return pv > bv ? p : best;
  }, arr[0]);
}

export default function Page() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [clarifyState, setClarifyState] = useState<{
    originalQuery: string;
    question: string;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: loading ? "auto" : "smooth",
      block: "end",
    });
  }, [turns.length, loading]);

  const canSend = useMemo(
    () => !loading && message.trim().length > 0,
    [loading, message]
  );

  const suggestions = [
    "sales by location",
    "sales for Airport",
    "compare Downtown vs Airport",
    "top items at Mall",
    "daily revenue for first week",
    "how much came from DoorDash",
    "revenue on Jan 3rd", // ✅ nice demo
  ];

  function clearChat() {
    setTurns([]);
    setErr(null);
    setClarifyState(null);
    setMessage("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const trimmed = message.trim();
    if (!trimmed) return;

    setTurns((prev) => [
      ...prev,
      { id: uid("u"), role: "user", text: trimmed },
    ]);
    setLoading(true);

    try {
      const payload = clarifyState
        ? { query: clarifyState.originalQuery, clarification: trimmed }
        : { query: trimmed };

      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = (await res.json()) as AgentResponse;

      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "Agent request failed");
      }

      const assistantText =
        (json.clarify_question ?? "").trim() ||
        (json.assistant_message ?? "").trim() ||
        "Done.";

      const widgets = (json.widgets ?? []) as Widget[];

      setTurns((prev) => [
        ...prev,
        {
          id: uid("a"),
          role: "assistant",
          text: assistantText,
          widgets: widgets.length ? widgets : undefined,
        },
      ]);

      if (json.clarify_question) {
        const original =
          clarifyState?.originalQuery ?? (payload as any).query ?? trimmed;

        setClarifyState({
          originalQuery: original,
          question: json.clarify_question,
        });
      } else {
        setClarifyState(null);
      }

      setMessage("");
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e: any) {
      setErr(
        typeof e?.message === "string"
          ? e.message
          : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen text-zinc-900">
      <div className="fixed inset-0 -z-10 bg-gradient-to-b from-[#A9B8BE] via-[#C7D6D7] to-[#EEF0EC]" />

      <header className="sticky top-0 z-10 border-b border-black/10 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-extrabold tracking-wide">
            <Image
              src="/clave-icon.png"
              alt="Clave"
              width={18}
              height={18}
              className="invert opacity-90"
            />
            <span>CLAVE</span>
          </div>

          <button
            type="button"
            onClick={clearChat}
            className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold hover:bg-black/5"
          >
            Clear
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pt-4 pb-28">
        {turns.length === 0 ? (
          <div className="rounded-2xl border border-black/10 bg-white p-4">
            <div className="text-sm font-semibold">Ask Clave AI</div>
            <div className="mt-1 text-sm text-zinc-600">
              Sales = <span className="font-mono">item_sales_cents</span>,
              Revenue = <span className="font-mono">total_cents</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setMessage(s);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-black/5"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          {turns.map((t) => {
            const isUser = t.role === "user";
            return (
              <div key={t.id} className="space-y-2">
                <div
                  className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={[
                      "max-w-[85%] rounded-2xl border border-black/10 px-4 py-3",
                      isUser
                        ? "bg-zinc-900 text-white"
                        : "bg-white text-zinc-900",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "mb-1 text-[11px]",
                        isUser ? "text-white/70" : "text-zinc-500",
                      ].join(" ")}
                    >
                      {isUser ? "You" : "Assistant"}
                    </div>

                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {t.text}
                    </div>
                  </div>
                </div>

                {t.role === "assistant" && t.widgets?.length ? (
                  <div className="space-y-3">
                    {t.widgets.map((w) => (
                      <section
                        key={w.id}
                        className="rounded-2xl border border-black/10 bg-white p-4"
                      >
                        <h3 className="text-sm font-semibold">{w.title}</h3>

                        {w.note ? (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            {w.note}
                          </div>
                        ) : null}

                        <div className="mt-3">
                          {/* ✅ NEW: metric card rendering */}
                          {w.type === "metric" ? (
                            <div className="rounded-2xl border border-black/10 bg-white p-4">
                              <div className="text-3xl font-extrabold tracking-tight">
                                {formatMetricValue(w.value, w.value_type)}
                              </div>
                              <div className="mt-1 text-sm text-zinc-600">
                                {w.value_type === "currency"
                                  ? "Total"
                                  : "Count"}
                              </div>
                            </div>
                          ) : w.type === "bar" ? (
                            <SalesByLocationChart
                              data={w.data}
                              valueType={w.value_type ?? "currency"}
                            />
                          ) : w.type === "line" ? (
                            <>
                              {Array.isArray(w.data) &&
                              (w.data as any[]).length ? (
                                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-700">
                                  {(() => {
                                    const total = sumSalesCents(w.data as any);
                                    const peak = getPeakPoint(w.data as any);

                                    const peakLabel =
                                      peak && "hour" in peak
                                        ? `${peak.hour}:00`
                                        : peak && "date" in peak
                                        ? String(peak.date)
                                        : "";

                                    return (
                                      <>
                                        <div>
                                          <span className="font-semibold">
                                            Total:
                                          </span>{" "}
                                          {dollars(total)}
                                        </div>

                                        {peak ? (
                                          <div>
                                            <span className="font-semibold">
                                              Peak:
                                            </span>{" "}
                                            {peakLabel} (
                                            {dollars(
                                              Number(peak.sales_cents ?? 0)
                                            )}
                                            )
                                          </div>
                                        ) : null}
                                      </>
                                    );
                                  })()}
                                </div>
                              ) : null}

                              <HourlySalesChart data={w.data as any} />
                            </>
                          ) : w.type === "pie" ? (
                            <ChannelRevenueChart data={w.data} />
                          ) : (
                            <div className="overflow-hidden rounded-xl border border-black/10">
                              <table className="w-full border-collapse text-sm">
                                <thead className="bg-black/5">
                                  <tr>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-zinc-600">
                                      Label
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-semibold text-zinc-600">
                                      Value
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {w.data.map((r) => {
                                    const isCount = w.value_type === "count";
                                    return (
                                      <tr
                                        key={r.normalized_name}
                                        className="border-t border-black/10"
                                      >
                                        <td className="px-3 py-2">
                                          {r.normalized_name}
                                        </td>
                                        <td className="px-3 py-2 text-right font-medium">
                                          {isCount
                                            ? r.sales_cents
                                            : dollars(r.sales_cents)}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          <div ref={bottomRef} className="scroll-mb-28" />

          {err ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {err}
            </div>
          ) : null}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="fixed bottom-6 left-1/2 z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2"
      >
        <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-2 py-2 shadow-sm">
          <input
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={loading}
            placeholder={
              clarifyState
                ? "Answer the clarification…"
                : 'Try: "sales for Airport"'
            }
            className="h-10 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-zinc-400 disabled:opacity-60"
          />

          <button
            type="submit"
            disabled={!canSend}
            className={[
              "h-10 rounded-full px-4 text-sm font-semibold",
              canSend
                ? "bg-zinc-900 text-white hover:bg-zinc-800"
                : "bg-zinc-200 text-zinc-500",
            ].join(" ")}
          >
            {loading ? "Running…" : clarifyState ? "Answer" : "Send"}
          </button>
        </div>
      </form>
    </main>
  );
}
