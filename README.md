# Clave Engineering Take-Home Assessment

## Natural Language Dashboard Generator

### Overview

At Clave, we consolidate restaurant data from multiple sources (POS systems, delivery platforms, etc.) and transform it into actionable insights powered by AI. Your challenge is to build a mini version of this: **a natural language dashboard for restaurant analytics.**

### The Challenge

Build a web application where a restaurant owner can type requests like:
- "Show me sales comparison between Downtown and Airport locations"
- "What were my top 5 selling products last week?"
- "Graph hourly sales for Friday vs Saturday at all stores"
- "Compare delivery vs dine-in revenue this month"

**...and the system generates the appropriate visualization dynamically.**

**Key Challenge**: You have 6 messy JSON files with different schemas. Clean them up, normalize them into a unified format, then build the AI-powered dashboard on top.

---

## What We Provide

Ready-to-use data in `/data/sources/` - representing 3 different restaurant data sources:

| Source | Files | What It Contains |
|--------|-------|------------------|
| **Toast POS** | `toast_pos_export.json` | Orders with checks, payments, menu items |
| **DoorDash** | `doordash_orders.json` | Delivery/pickup orders with items and fees |
| **Square POS** | `square/catalog.json`, `square/orders.json`, `square/payments.json`, `square/locations.json` | Split across multiple files like the real API |

All data covers **4 restaurant locations** (Downtown, Airport, Mall, University) from **January 1-4, 2025**.

⚠️ **The data is intentionally messy!** You'll find:
- Inconsistent product names across locations (e.g., "Hash Browns" vs "Hashbrowns")
- Typos in item names (e.g., "Griled Chiken", "expresso", "coffe")
- Categories with/without emojis (e.g., "🍔 Burgers" vs "Burgers")
- Variations baked into names (e.g., "Churros 12pcs" vs "Churros" with variations)
- Different formats for similar data

**Your job:** Clean, normalize, and combine these into a unified schema, then build the AI dashboard.

---

## Requirements

### 1. Data Cleaning & Normalization
- **Parse all JSON files** and understand their structures
- **Design a Supabase database schema** that unifies all sources
- Handle different formats for: timestamps, amounts, locations, order types, items
- **Clean and normalize** the data (fix inconsistencies, standardize formats)
- **Insert into Supabase** - Write scripts to populate your database
- **Document your approach** - show your thought process and decisions

### 2. Natural Language Query Interface
- Text input where users describe what they want to see
- Use an LLM to interpret requests and map them to data queries
- Handle ambiguous queries gracefully (e.g., "sales" could mean revenue or order count)
- **Structure your prompts** to return structured data for reliable parsing

### 3. Dynamic Visualization Engine
- Generate appropriate chart types based on query intent (bar, line, pie, table, metric cards, etc.)
- The system should choose the visualization type, not the user
- Handle multiple data series and complex comparisons

### 4. Interactive Dashboard
- Generated visualizations appear as "widgets" (charts + text summaries)
- Users can add multiple widgets from different queries
- Clean, usable interface with meaningful insights
- Support for various chart types: bar, line, pie, tables, metrics

---

## Technical Requirements

- **Frontend:** **Next.js** with TypeScript
- **Backend/Data Processing:** Choose what works best for you:
  - Next.js API routes (keep it all in one project)
  - Express.js with TypeScript (separate backend)
  - Python (FastAPI, Flask, or scripts for data transformations)
- **Database:** **Supabase** (PostgreSQL) - Store your normalized data here
- **AI Integration:** You'll need an API key for your chosen LLM provider. Structure your code so we can easily plug in our own key for testing.
- **Charting:** Any library (Recharts, Chart.js, D3, Plotly, etc.)
- **Styling:** Your choice. We care more about functionality than pixel-perfection, but it should be usable.

### Why Supabase?
We use Supabase internally at Clave. This lets us evaluate:
- Your database schema design
- How you model restaurant data
- SQL query patterns for analytics
- Integration with a real database (not just in-memory)

---

## What We're Evaluating

| Area | What We Look For |
|------|------------------|
| **Data Cleaning** | How you parse, understand, and normalize messy JSON data into clean structures |
| **Database Schema** | Your Supabase table design, relationships, and indexing for analytics queries |
| **Data Transformation** | Handling different formats, missing data, and creating consistent representations |
| **AI Integration** | Natural language understanding, query parsing, and visualization generation |
| **Dashboard UX** | Clean interface with meaningful charts, tables, and text summaries |
| **Code Quality** | Well-structured code (TypeScript/Python) with good error handling and documentation |
| **Problem Solving** | Creative solutions to data challenges and edge cases |

---

## Deliverables

1. **GitHub Repository** (public or private with access granted to: `[INSERT_GITHUB_HANDLES]`)
2. **Code Structure** showing:
   - Data ingestion/normalization scripts
   - Supabase schema (migrations or SQL files)
   - AI integration logic
   - Visualization components
3. **README** with:
   - Setup/installation instructions (including Supabase setup)
   - Data cleaning/normalization approach and database schema design
   - AI query parsing and visualization logic
   - Assumptions, tradeoffs, and design decisions
   - What you'd improve with more time
4. **Working Demo** - Deployed (Vercel, Netlify, etc.) or clear local setup instructions
5. **Supabase Project** - Share access or provide SQL export of your schema

---

## Difficulty & Expectations

This assessment tests **real data engineering + AI integration skills**. You'll need to:

- Parse and clean 6 different JSON data formats
- Design a Supabase database schema for restaurant analytics
- Handle data type conversions, missing fields, and structural differences
- Build an AI system that understands natural language queries
- Create a functional dashboard with charts and text using TypeScript

**We expect production-quality code** with proper error handling, clean architecture, and good documentation.

## Suggested Workflow

1. **Explore the data** - Spend time understanding each JSON file's structure
2. **Set up Supabase** - Create a project at [supabase.com](https://supabase.com)
3. **Design your schema** - Plan your database tables and relationships
4. **Build data cleaning** - Write scripts to parse, clean, and insert into Supabase
5. **Create the dashboard** - Build the UI with Next.js (use API routes or Express for backend)
6. **Add AI integration** - Connect LLM to parse queries and generate SQL/visualizations
7. **Polish & test** - Make it look good and handle edge cases

## Time & Deadline

- **Suggested effort:** 8-12 hours (but no hard limit—take the time you need to do it well)
- **Deadline:** `January 3rd, 2026 at 11:59pm`
- **AI Usage:** Encouraged! Use Cursor, Claude Code, and/or whatever tools help you build better.

---

## Questions?

If anything is unclear, reach out to `carlos@tryclave.ai` or `valentina@tryclave.ai`. Asking good questions is a plus, not a minus.

---

## Getting Started

```bash
# Clone this repo
git clone [repo-url]

# Check out the mock data
ls data/sources/

# Set up Next.js (required for frontend)
npx create-next-app@latest my-dashboard --typescript

# Backend options (choose one):
# Option A: Use Next.js API routes (already included)
# Option B: Separate Express backend
mkdir my-api && cd my-api && npm init -y && npm install express typescript @types/express ts-node
# Option C: Python for data processing/API
pip install fastapi uvicorn supabase pandas

# Set up Supabase
# 1. Create a project at https://supabase.com
# 2. Get your project URL and anon key from Settings > API
# 3. Install the client: npm install @supabase/supabase-js (or: pip install supabase)

# Start building!
```

Good luck! We're excited to see what you create. 🚀
