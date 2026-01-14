// src/lib/agent/graph.ts
import { Annotation, END, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

import type { Metric, Widget, Plan } from "@/lib/agent/types";
import { PlanSchema } from "@/lib/agent/types";
import { buildPlannerPrompt } from "@/lib/agent/prompt";
import { executePlan } from "@/lib/agent/executor";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match?.[0]) return JSON.parse(match[0]);
    throw new Error("Model returned non-JSON");
  }
}

type AgentContext = {
  userQuery: string;
  clarification?: string | null;
  knownLocations: string[];
  detectedLocations: string[];
  metricHint: Metric;
  minDate: string | null;
  maxDate: string | null;
  inferredIsoDate: string | null;
};

type PlannerTraceAttempt = {
  attempt: "first" | "retry_json_only" | "forced_nonempty_actions";
  prompt: string;
  output_text: string;
  ok: boolean;
  error?: string;
  ms: number;
};

export type AgentDebugTrace = {
  enabled: boolean;
  started_at: string;
  finished_at: string;
  ms_total: number;

  planner: {
    model: string;
    temperature: number;
    attempts: PlannerTraceAttempt[];
    used_attempt: PlannerTraceAttempt["attempt"];
    actions_len: number;
    has_clarify_question: boolean;
  };

  executor: {
    ms: number;
    widgets_len: number;
  };

  ctx: {
    userQuery: string;
    clarification?: string | null;
    detectedLocations: string[];
    metricHint: Metric;
    minDate: string | null;
    maxDate: string | null;
    inferredIsoDate: string | null;
  };
};

const GraphState = Annotation.Root({
  ctx: Annotation<AgentContext>(),
  prompt: Annotation<string>(),

  plan: Annotation<Plan | null>(),
  assistant_message: Annotation<string>(),
  clarify_question: Annotation<string | undefined>(),
  widgets: Annotation<Widget[]>(),

  // ✅ NEW: debug trace stored in state (optional)
  debug: Annotation<AgentDebugTrace | null>(),
  debug_enabled: Annotation<boolean>(),
});

const modelName = "gpt-4o-mini";
const modelTemp = 0;

const model = new ChatOpenAI({
  model: modelName,
  temperature: modelTemp,
  apiKey: process.env.OPENAI_API_KEY,
});

function nowISO() {
  return new Date().toISOString();
}

const plannerNode = async (state: typeof GraphState.State) => {
  const t0 = Date.now();

  // 1) build prompt from ctx
  const basePrompt =
    state.prompt ||
    buildPlannerPrompt({
      userQuery: state.ctx.userQuery,
      clarification: state.ctx.clarification ?? null,
      knownLocations: state.ctx.knownLocations,
      detectedLocations: state.ctx.detectedLocations,
      metricHint: state.ctx.metricHint,
      minDate: state.ctx.minDate,
      maxDate: state.ctx.maxDate,
      inferredIsoDate: state.ctx.inferredIsoDate,
    });

  const attempts: PlannerTraceAttempt[] = [];

  const runAttempt = async (args: {
    attempt: PlannerTraceAttempt["attempt"];
    prompt: string;
  }): Promise<{
    plan: Plan | null;
    ok: boolean;
    error?: string;
    text: string;
  }> => {
    const a0 = Date.now();
    try {
      const resp = await model.invoke([new HumanMessage(args.prompt)]);
      const text = resp.content?.toString?.() ?? String(resp.content ?? "");
      const parsed = safeJsonParse(text);
      const plan = PlanSchema.parse(parsed);

      attempts.push({
        attempt: args.attempt,
        prompt: args.prompt,
        output_text: text,
        ok: true,
        ms: Date.now() - a0,
      });

      return { plan, ok: true, text };
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "unknown error";
      // try to capture raw output if available; in this node, we only have it if invoke succeeded,
      // but parsing failed — which gets caught here too. We'll keep output_text empty in that case.
      attempts.push({
        attempt: args.attempt,
        prompt: args.prompt,
        output_text: "",
        ok: false,
        error: msg,
        ms: Date.now() - a0,
      });
      return { plan: null, ok: false, error: msg, text: "" };
    }
  };

  // 2) attempt #1
  let plan: Plan | null = null;
  let usedAttempt: PlannerTraceAttempt["attempt"] = "first";

  {
    const first = await model.invoke([new HumanMessage(basePrompt)]);
    const text1 = first.content?.toString?.() ?? String(first.content ?? "");

    const a0 = Date.now();
    try {
      const parsed = safeJsonParse(text1);
      plan = PlanSchema.parse(parsed);
      attempts.push({
        attempt: "first",
        prompt: basePrompt,
        output_text: text1,
        ok: true,
        ms: Date.now() - a0,
      });
      usedAttempt = "first";
    } catch (e: any) {
      attempts.push({
        attempt: "first",
        prompt: basePrompt,
        output_text: text1,
        ok: false,
        error: e?.message ? String(e.message) : "parse error",
        ms: Date.now() - a0,
      });

      // retry with strict JSON-only suffix
      const retryPrompt =
        basePrompt + "\n\nIMPORTANT: Return ONLY valid JSON. No extra text.";
      const second = await model.invoke([new HumanMessage(retryPrompt)]);
      const text2 =
        second.content?.toString?.() ?? String(second.content ?? "");

      const b0 = Date.now();
      const parsed2 = safeJsonParse(text2);
      plan = PlanSchema.parse(parsed2);
      attempts.push({
        attempt: "retry_json_only",
        prompt: retryPrompt,
        output_text: text2,
        ok: true,
        ms: Date.now() - b0,
      });
      usedAttempt = "retry_json_only";
    }
  }

  if (!plan) throw new Error("Planner produced no plan");

  // 3) if empty actions and no clarify_question, force one more time
  const actionsLen = (plan as any).actions?.length ?? 0;
  const hasClarify = !!(plan as any).clarify_question;

  if (!hasClarify && actionsLen === 0) {
    const forcedPrompt =
      basePrompt +
      "\n\nYou returned zero actions. You MUST return at least one action unless you ask a clarify_question.";

    const forced = await model.invoke([new HumanMessage(forcedPrompt)]);
    const forcedText =
      forced.content?.toString?.() ?? String(forced.content ?? "");

    const c0 = Date.now();
    const forcedParsed = safeJsonParse(forcedText);
    plan = PlanSchema.parse(forcedParsed);
    attempts.push({
      attempt: "forced_nonempty_actions",
      prompt: forcedPrompt,
      output_text: forcedText,
      ok: true,
      ms: Date.now() - c0,
    });
    usedAttempt = "forced_nonempty_actions";
  }

  // If debug enabled, initialize/extend trace in state
  const debug = state.debug_enabled
    ? ({
        enabled: true,
        started_at: state.debug?.started_at ?? nowISO(),
        finished_at: "",
        ms_total: 0,
        planner: {
          model: modelName,
          temperature: modelTemp,
          attempts,
          used_attempt: usedAttempt,
          actions_len: ((plan as any).actions?.length ?? 0) as number,
          has_clarify_question: !!(plan as any).clarify_question,
        },
        executor: {
          ms: 0,
          widgets_len: 0,
        },
        ctx: {
          userQuery: state.ctx.userQuery,
          clarification: state.ctx.clarification ?? null,
          detectedLocations: state.ctx.detectedLocations,
          metricHint: state.ctx.metricHint,
          minDate: state.ctx.minDate,
          maxDate: state.ctx.maxDate,
          inferredIsoDate: state.ctx.inferredIsoDate,
        },
      } satisfies AgentDebugTrace)
    : null;

  return { prompt: basePrompt, plan, debug };
};

const executorNode = async (state: typeof GraphState.State) => {
  if (!state.plan) throw new Error("Planner produced no plan");

  const t0 = Date.now();

  const out = await executePlan({
    userQuery: state.ctx.userQuery,
    plan: state.plan,
    knownLocations: state.ctx.knownLocations,
    metricHint: state.ctx.metricHint,
    minDate: state.ctx.minDate,
    maxDate: state.ctx.maxDate,
  });

  const ms = Date.now() - t0;

  const debug =
    state.debug_enabled && state.debug
      ? ({
          ...state.debug,
          executor: {
            ms,
            widgets_len: (out.widgets ?? []).length,
          },
        } satisfies AgentDebugTrace)
      : state.debug_enabled
      ? // if planner didn't set it for some reason, still create minimal trace
        ({
          enabled: true,
          started_at: nowISO(),
          finished_at: "",
          ms_total: 0,
          planner: {
            model: modelName,
            temperature: modelTemp,
            attempts: [],
            used_attempt: "first",
            actions_len: 0,
            has_clarify_question: false,
          },
          executor: { ms, widgets_len: (out.widgets ?? []).length },
          ctx: {
            userQuery: state.ctx.userQuery,
            clarification: state.ctx.clarification ?? null,
            detectedLocations: state.ctx.detectedLocations,
            metricHint: state.ctx.metricHint,
            minDate: state.ctx.minDate,
            maxDate: state.ctx.maxDate,
            inferredIsoDate: state.ctx.inferredIsoDate,
          },
        } satisfies AgentDebugTrace)
      : null;

  return {
    assistant_message: out.assistant_message,
    clarify_question: out.clarify_question,
    widgets: out.widgets,
    debug,
  };
};

const graph = new StateGraph(GraphState)
  .addNode("planner", plannerNode)
  .addNode("executor", executorNode)
  .addEdge("__start__", "planner")
  .addEdge("planner", "executor")
  .addEdge("executor", END)
  .compile();

export async function runAgent(ctx: AgentContext): Promise<{
  assistant_message: string;
  clarify_question?: string;
  widgets: Widget[];
}> {
  const out = await graph.invoke({
    ctx,
    prompt: "",
    plan: null,
    assistant_message: "",
    clarify_question: undefined,
    widgets: [],
    debug: null,
    debug_enabled: false,
  });

  return {
    assistant_message: out.assistant_message,
    clarify_question: out.clarify_question,
    widgets: out.widgets ?? [],
  };
}

// ✅ NEW: debug trace variant
export async function runAgentWithTrace(ctx: AgentContext): Promise<{
  assistant_message: string;
  clarify_question?: string;
  widgets: Widget[];
  trace: AgentDebugTrace;
}> {
  const started = Date.now();
  const out = await graph.invoke({
    ctx,
    prompt: "",
    plan: null,
    assistant_message: "",
    clarify_question: undefined,
    widgets: [],
    debug: {
      enabled: true,
      started_at: nowISO(),
      finished_at: "",
      ms_total: 0,
      planner: {
        model: modelName,
        temperature: modelTemp,
        attempts: [],
        used_attempt: "first",
        actions_len: 0,
        has_clarify_question: false,
      },
      executor: { ms: 0, widgets_len: 0 },
      ctx: {
        userQuery: ctx.userQuery,
        clarification: ctx.clarification ?? null,
        detectedLocations: ctx.detectedLocations,
        metricHint: ctx.metricHint,
        minDate: ctx.minDate,
        maxDate: ctx.maxDate,
        inferredIsoDate: ctx.inferredIsoDate,
      },
    },
    debug_enabled: true,
  });

  const finished = Date.now();

  const trace: AgentDebugTrace = out.debug
    ? {
        ...out.debug,
        finished_at: nowISO(),
        ms_total: finished - started,
      }
    : {
        enabled: true,
        started_at: nowISO(),
        finished_at: nowISO(),
        ms_total: finished - started,
        planner: {
          model: modelName,
          temperature: modelTemp,
          attempts: [],
          used_attempt: "first",
          actions_len: 0,
          has_clarify_question: false,
        },
        executor: {
          ms: 0,
          widgets_len: (out.widgets ?? []).length,
        },
        ctx: {
          userQuery: ctx.userQuery,
          clarification: ctx.clarification ?? null,
          detectedLocations: ctx.detectedLocations,
          metricHint: ctx.metricHint,
          minDate: ctx.minDate,
          maxDate: ctx.maxDate,
          inferredIsoDate: ctx.inferredIsoDate,
        },
      };

  return {
    assistant_message: out.assistant_message,
    clarify_question: out.clarify_question,
    widgets: out.widgets ?? [],
    trace,
  };
}
