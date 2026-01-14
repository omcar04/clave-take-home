# Natural Language Dashboard Generator

## Clave Engineering Take-Home Assessment

A natural language analytics platform for restaurant data. This system ingests fragmented, **messy data** from multiple POS and delivery providers, normalizes it into a **canonical schema**, and provides a **GPT-powered interface** for querying insights and generating dashboards.

---

## Live Demo

https://clave-take-home-five.vercel.app/

---

## ✨ What this does

- Ingests data from multiple sources (POS + delivery providers)
- Normalizes raw JSON into a consistent Postgres schema
- Exposes “Gold Layer” analytics views for clean querying
- Uses a LangGraph-based agent to convert natural language → structured “widget” outputs
- Renders widgets dynamically in a Next.js UI (charts, tables, metric cards)

---

## 🚀 Setup & Installation

### 1) Prerequisites

- **Node.js** v18+
- **Python** 3.9+ (for data ingestion)
- **Supabase** account (Postgres + Auth)
- **OpenAI API Key** (for the LangGraph agent)

---

### 2) Database Setup (Supabase)

1. Create a new Supabase project.
2. Run the contents of `schema.sql` in the Supabase SQL Editor to create base tables:
   - `locations`
   - `orders`
   - `order_items`
3. Run the contents of `views.sql` to create the “Gold Layer” analytics views:
   - `v_orders_enriched`
   - `v_order_items_derived`
4. Apply the following indexes for performance:

```sql
CREATE INDEX idx_orders_location_time ON orders (location_id, ordered_at);
CREATE INDEX idx_order_items_order ON order_items (order_id);
CREATE INDEX idx_order_items_norm_name ON order_items (normalized_name);
```

---

### 3) Environment Variables

Create a `.env` file in the project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_key
OPENAI_API_KEY=your_openai_key
```

---

### 4) Data Ingestion

Install Python dependencies and run ingestion scripts to populate the database:

```bash
pip install -r requirements.txt
python ingest_toast.py
python ingest_doordash.py
python ingest_square.py
```

---

## 📊 Database Schema & Data Normalization

### Schema Design

The architecture uses a normalized Postgres schema designed for high-performance aggregations.

### Cleaning & Normalization Approach

- **Deduplication / Idempotency**  
  Uses a stable source key `(source, source_order_id)` to ensure ingestion can be re-run safely without creating duplicates.

- **Monetary Precision**  
  All currency is stored as integer cents (`bigint`) to avoid floating-point rounding errors:

  - `item_sales_cents`: Net sales (pre-tax/tip)
  - `total_cents`: Gross revenue (includes tax, tip, fees)

- **Text Normalization**  
  Centralized in `normalize.py`:

  - strips emojis
  - collapses whitespace
  - standardizes casing for item names and categories

- **Canonical Categories**  
  Maps disparate source categories into predictable buckets:
  - `Beverages`
  - `Food`
  - `Desserts`
  - `Entrees` (default)

---

## 🤖 AI Query Parsing & Visualization Logic

The dashboard uses a **LangGraph-based agent workflow** to translate natural-language questions into **structured analytics actions**, execute them deterministically against Supabase, and return **render-ready widgets** to the UI.

### High-level flow

1. User types a question in the UI
2. UI calls `POST /api/agent`
3. Backend converts the question → **Plan JSON**
4. Executor runs the plan against Supabase views
5. Response returns **widgets** (charts/tables/KPIs) + optional summaries

---

## Agent Pipeline

### 1) Planner (GPT-4o-mini)

The Planner is an LLM node responsible for **interpretation + planning**, not execution.

**Inputs**

- User query text
- Known restaurant locations (fetched from Supabase)
- Available date range / constraints (so it doesn’t hallucinate impossible dates)
- Global metric definitions:
  - `sales = item_sales_cents`
  - `revenue = total_cents`

**What it produces**
A **strict JSON Plan** containing:

- `actions[]` (1–3 actions), each describing:
  - intent (total / comparison / trend / ranking / breakdown)
  - metric (sales vs revenue)
  - scope filters (location(s), date or date range, channel)
  - recommended widget type (bar/line/pie/table/metric/aov)
- optional `clarify_question` if the request is ambiguous (e.g., unclear metric or location scope)

**Why planning is separated**
Keeping the planner “read-only” (no DB access) makes results more consistent:

- LLM decides **what** to compute and **how to visualize**
- Executor decides **how** to compute it safely and correctly

---

### 2) Executor (Truth Layer)

The Executor is the deterministic layer that turns planner actions into **actual database queries** and ensures consistent UX.

**Responsibilities**

- Validate the plan against a schema (reject malformed/unsafe output)
- Normalize missing fields (fill defaults for metric, date scope, query_id, etc.)
- Query Supabase (views) and return **typed widgets**
- Attach small “answer-first” summaries when possible (totals, peaks, top contributors)

#### Self-correction / Guardrails

To avoid flaky or incomplete LLM output, the executor applies guardrails:

- **Single-day auto pairing**

  - If the user asks for a single day total (e.g., “Revenue on Jan 3rd”),
    the executor ensures the response includes:
    1. a **metric total** widget
    2. an **hourly line breakdown** widget
  - Even if the planner returns only one action, the executor injects the second
    so the UI always shows “total + breakdown” for single-day questions.

- **Deterministic routing (fast paths)**

  - High-confidence queries bypass the LLM for speed + accuracy.
  - Example: queries that clearly ask for “DoorDash totals” return a metric directly
    from `doordash_total` logic without planning.

- **Expected widget enforcement**
  - Certain query types must map to specific widget types
    (e.g., time trends → line, comparisons → bar, breakdown → pie/table).
  - If the planner suggests an odd widget type, the executor corrects it.

---

## Output: Widget Contract

The backend returns a union of render-ready widgets. The frontend only renders—
it doesn’t need to re-interpret intent.

Supported widget types:

- **Metric**: single KPI card (sales/revenue total)
- **Line**: time series (hourly/daily trends)
- **Bar**: comparisons (locations, rankings)
- **Pie**: breakdowns (delivery vs dine-in, channel mix)
- **Table**: top items, category rankings, detail views
- **AOV**: average order value per location (value + order count)

Each widget includes a stable identifier (e.g., `query_id`) and typed `data`
so the UI can render it reliably.

---

## 🧩 UI Rendering

The frontend (Next.js) dynamically renders components based on widget type:

- **Metric Cards**: High-level KPIs (e.g., total revenue, total order count) for immediate "big-picture" awareness.

- **AOV Charts**: Specialized logic for Average Order Value by location, allowing operators to compare spend per customer across different stores.

- **Summary Block**: An "answer-first" text summary generated by the executor that programmatically identifies peaks, totals, and outliers.

- **Bar Charts**: Ideal for comparing rankings, such as sales by location or top-performing menu items.

- **Line Graph**s: Used for time-series data to visualize hourly or daily sales trends.

- **Pie Charts**: Best for categorical breakdowns, such as delivery vs dine in share.

---

## 🧠 Design Decisions & Tradeoffs

- **View-Based Analytics (Gold Layer)**  
  Postgres Views keep application logic simple; the LLM queries clean views rather than building complex joins in prompts.

- **Integer Math for Money**  
  Storing cents instead of decimals is non-negotiable for financial correctness in restaurant analytics.

- **LangGraph over Simple Chains**  
  A graph supports future expansion (multi-step reasoning, clarifying questions, tool routing) better than a single prompt-to-SQL chain.

- **Safe JSON Parsing**  
  Includes a fallback parser for cases where the model wraps JSON in markdown code blocks.

---

## 📈 Improvements I’d Make with More Time

### 1) Make the agent more “agentic” (without sacrificing safety)

- **Add a Validator/Critic node** between Planner → Executor to reject or auto-repair bad plans (missing fields, invalid date ranges, unknown locations, etc.).
- **Richer clarification loop**: when a query is ambiguous (“sales” vs “revenue”, missing time range, “all stores”), generate **one best follow-up question** and resume the original query once clarified.
- **Multi-step planning**: support more complex requests by decomposing into multiple actions (e.g., “compare Fri vs Sat hourly + top items + delivery vs dine-in”) and returning a cohesive set of widgets.
- **Insight post-processor**: after widgets are computed, run deterministic analysis to generate highlights (peaks, biggest contributor, percent deltas, anomalies) to make responses more “assistant-like” beyond charts.

### 2) Stronger reproducibility + operational polish

- **Check in all SQL artifacts** (`sql/schema.sql`, `sql/views.sql`, `sql/indexes.sql`) so reviewers can recreate the database from scratch without relying on Supabase editor history.
- **Add hard limits + guardrails**:
  - max actions per request (e.g., 3)
  - max date range (e.g., 90 days)
  - max rows returned per table widget (e.g., 200)
  - strict allowlist for query_ids and canonical categories
- **Explain mode / debug UX**: expose the agent’s structured interpretation (metric chosen, locations detected, inferred date range, chosen query_ids) so results are easy to audit.

---

## 🔒 Why I Avoided a Sandbox “LLM Writes Code” Executor

A sandboxed executor can look impressive, but it’s a **high-risk design choice** for a take-home setting.

The pattern “LLM writes Python/SQL → backend executes it” effectively turns the API into a **remote code execution (RCE) surface**. Even with sandboxing, it adds meaningful security and reliability risks that require production-grade hardening.

### Key reasons:

- **Security surface area**
  - Generated code introduces risk of sandbox escape and data exfiltration.
  - Proper isolation requires strict network controls, filesystem restrictions, resource quotas, and auditing.
- **Debugging + review reliability**
  - Failures become harder to reproduce (model output variability, dependency issues, runtime quirks).
  - Debugging generated code increases iteration time and can fail unpredictably in a reviewer’s environment.
- **Infrastructure overhead**
  - A real sandbox typically requires container isolation (or Firecracker), CPU/memory/time limits, safe dependency handling, and logging.
  - Many review/CI environments restrict Docker or system-level execution, increasing the chance of evaluation failures.

### What I did instead (Safety by Construction)

- The LLM only returns a **constrained JSON Plan** validated by a schema.
- The Executor runs an **allowlisted set of query actions** (`query_id`) with validated parameters against curated Supabase views (“Gold Layer”).
- This keeps the system **deterministic, reviewable, and secure** while still feeling agentic via planning, routing, and self-correction.

### Future direction (if productized)

If this were expanded beyond a take-home prototype, a sandboxed compute layer could be considered **only with strict controls** (no outbound network, read-only datasets, resource limits, signed artifacts, audit logs). For this project, the safer and more reliable choice was a validated-plan + allowlisted-executor architecture.
