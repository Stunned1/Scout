# Architecture of Scout — Real-Estate Intelligence Platform

## Overview

Scout is a full-stack geospatial intelligence platform for real-estate analysts. An analyst loads any U.S. market (ZIP, city, county, or metro), explores it on an interactive map, asks questions in natural language, and exports a polished PDF report — all in one browser session. Three core ideas drive the architecture:

1. **Google-first stack** — Google Maps, Gemini 2.5 Flash, BigQuery, Vertex AI, Geocoding, Places, and Routes APIs do the heavy lifting throughout.
2. **Bounded intent lanes** — rather than open-ended LLM tool-calling, every prompt is classified into a narrow handler that fetches data deterministically; Gemini is used only for synthesis, never for inventing numbers.
3. **Multi-layer caching** — live public APIs (Census, FRED, HUD, FEMA) flow through a three-tier cache (in-memory → Supabase operational store → BigQuery historical store) to keep repeated queries fast and cheap.

---

## How Google Technology Is Used

### Google Maps + deck.gl

The entire visualization canvas is built on `@vis.gl/react-google-maps` (the official React wrapper for the Google Maps JavaScript API). On top of the base map, `@deck.gl/google-maps` mounts a WebGL overlay that renders all data layers simultaneously at 60 fps:

- **GeoJsonLayer** — ZIP/county/metro boundary outlines and rent choropleth fills
- **ScatterplotLayer** — transit stops, permit locations, shortlist pins, uploaded CSV markers
- **H3HexagonLayer** — permit density by H3 hexagon (NYC DOB data)
- **HeatmapLayer** — amenity heatmap (OSM/Overture POI weights)
- **PathLayer** — transit route polylines
- **ColumnLayer** — extruded 3D columns for permit or density views
- **IconLayer** — custom SVG pins for uploaded markers and analysis sites

Without deck.gl's WebGL approach, rendering tens of thousands of NYC parcel or permit points on a standard SVG/DOM layer would be impossible.

### Gemini 2.5 Flash

`@google/generative-ai` with the `gemini-2.5-flash` model is used in four distinct places:

| Use | File | Mode |
|-----|------|------|
| Agent EDA synthesis (streaming chat answers) | `lib/server/agent-pipeline.ts` | Streaming JSON |
| Map-control NLP parsing ("show me Austin") | `lib/server/agent-pipeline.ts` | JSON mode |
| PDF market brief + dossier narrative | `lib/report/gemini-brief.ts`, `gemini-market-dossier.ts` | JSON mode |
| CSV column classification (address detection) | `lib/upload/suggest-location-column.ts` | JSON mode |

Gemini always receives a structured context string built from real fetched data and is asked to return structured JSON — never free-form prose that could hallucinate numbers.

### Google BigQuery

`@google-cloud/bigquery` (dataset `scout_analytics`, project `scout-493604`) serves as the cold tier of the data stack:

- Historical metric series (rent, unemployment, permit units going back years)
- Texas ZCTA dimension data (centroids, metro assignments) for cities not covered by Zillow's ZIP table
- EDA distribution history for the exploratory data panel

### Google Cloud Vertex AI

`lib/vertex-ai-client.ts` wraps the Vertex AI `generateContent` endpoint and supports three grounding modes — `vertex_search`, `google_search`, and `google_maps` — used by the agent's grounding validator to verify that responses cite real evidence rather than synthesized claims.

### Google Geocoding API

`lib/google-forward-geocode.ts` batch-geocodes addresses from user-uploaded CSV files using `maps.googleapis.com/maps/api/geocode/json`. Results are cached in a Supabase `address_geocode_cache` table (24-hour in-memory TTL + Supabase deduplication) so the same address is never geocoded twice.

### Google Places API

`lib/google-places-site-context.ts` calls `places.googleapis.com/v1/places:searchNearby` to build a "site context" card for any lat/lng — counting nearby restaurants, retail, schools, parks, and transit. This feeds the agent's place-grounding intent lane.

### Google Maps Routes API

`lib/agent-drive-time-grounding.ts` calls the Routes API to answer commute/drive-time questions ("30-minute drive from 78701") as one of the agent's specialized intent lanes.

### Google Trends

`lib/fetchTrends.ts` (via the `google-trends-api` package) fetches keyword search-interest time series by geography, adding a consumer-sentiment signal to the market report.

---

## High-Level Architecture

```
Browser
  ├─ CommandMap (Google Maps + deck.gl WebGL)
  ├─ AgentTerminal (streaming chat)
  ├─ SavedChartsExportDialog (PDF builder)
  └─ CommandCenterSidebar (search, shortlist, uploads)
          │ HTTPS
          ▼
Next.js API Layer (app/api/*)
  ├─ /api/agent ──► agent-pipeline.ts
  │                  ├─ Intent classifier
  │                  ├─ Lane handlers
  │                  ├─ Gemini 2.5 Flash
  │                  └─ Grounding validators
  ├─ /api/market, /aggregate, /metro …
  │       └─ lib/data/market-data-router.ts
  │               ├─ Supabase (7-day operational cache)
  │               └─ BigQuery (historical bulk)
  ├─ /api/permits, /parcels, /tracts …
  │       ├─ Supabase nyc_permits
  │       └─ NYC OpenData PLUTO / BigQuery Texas
  ├─ /api/transit, /amenities, /floodrisk …
  │       ├─ Overpass API (OSM)
  │       └─ FEMA NFHL ArcGIS REST
  └─ /api/report/pdf
          ├─ Gemini 2.5 Flash (narrative)
          └─ @react-pdf/renderer (PDF binary)

External Data Sources
  ├─ Google: Maps, Geocoding, Places, Routes, Trends, BigQuery, Vertex AI, Gemini
  ├─ U.S. Gov: Census ACS/BPS, FRED, HUD, FEMA NFHL, NYC OpenData
  ├─ Zillow: ZORI/ZHVI (pre-ingested snapshots in Supabase)
  ├─ Overture Maps: POI supply density
  └─ Transitland: GTFS transit routes
```

---

## Component Responsibilities

### `CommandMap` — Interactive Geospatial Canvas
**File:** `components/CommandMap.tsx` (~2,700 lines)

The visual core of the product. Mounts a Google Maps base layer and a deck.gl WebGL overlay managing 12 toggleable data layers:

| Layer | Data Source | Visual Type |
|-------|-------------|-------------|
| ZIP boundaries | `/api/boundaries` | Outline polygon |
| Rent choropleth | Zillow ZORI/ZHVI snapshot | Filled polygon (purple gradient) |
| Transit stops/routes | `/api/transit` (Overpass/OSM) + Transitland | Scatter + path lines |
| Parcels | `/api/parcels` (NYC PLUTO) | Extruded column (by value) |
| Census tracts | `/api/tracts` | GeoJson fill |
| Amenity heatmap | `/api/amenities` (Overpass OSM) | HeatmapLayer |
| Flood risk | `/api/floodrisk` (FEMA) | GeoJson fill (red/yellow) |
| NYC permits | `/api/permits` (Supabase) | Scatter or heatmap |
| Permit H3 | Same permit data | H3HexagonLayer |
| POIs | `/api/pois` | IconLayer |
| Momentum | `/api/momentum` | ZIP fill (fuchsia gradient) |
| Client CSV data | User upload (sessionStorage) | Custom SVG IconLayer |

Responds to agent-driven camera commands (tilt, heading, fly-to) and emits `onLayersChange` snapshots for the PDF export pipeline.

---

### `AgentTerminal` + `AgentChat` — Conversational AI Interface
**Files:** `components/AgentTerminal.tsx`, `components/AgentChat.tsx`, `lib/use-agent-intelligence.ts`

The terminal-style chat panel where analysts type natural language questions and slash commands.

- **Slash commands processed client-side** (`lib/slash-commands.ts`) — `/tilt`, `/layers:transit`, `/clear:workspace`, `/view 3d` never hit the server.
- **Analytical prompts stream via NDJSON** — POST `/api/agent` with `stream: true`, consuming one JSON line at a time via `lib/consume-agent-ndjson-stream.ts`, animating text at 72 ms/chunk.
- **Chat history persisted to `sessionStorage`** — survives page reloads within the same browser session.
- **Action dispatch** — agent responses carry an `action` object (e.g., `{ type: 'toggle_layer', layer: 'nycPermits', value: true }`) that the parent page applies to the map directly.

---

### `lib/server/agent-pipeline.ts` — The Agent Brain

The POST handler for `/api/agent`. Every user message flows through this pipeline:

```
1. Policy check (evaluateAgentRequestPolicy)
2. Intent classification:
   a. direct_map_control  →  NLP or rule-based map action
   b. history/comparison  →  market-data-router (Postgres/BigQuery) + chart
   c. consumer_market     →  Gemini plans → Census + Overture fetch → Gemini synthesizes
   d. public_macro        →  Census ACS / FRED / HUD lookup
   e. drive_time          →  Google Maps Routes API
   f. place_grounding     →  Google Places API
   g. fallback EDA        →  workspace context string → Gemini synthesis
3. Chart pre-generation (rent trend, unemployment, permits)
4. Gemini synthesis (JSON mode: { message, trace })
5. Claim tagging ([source: label] annotations on every quantitative sentence)
6. Grounding validation
7. Return NDJSON stream or single JSON response
```

By routing to deterministic handlers first (steps 2a–2f) and invoking Gemini only for synthesis (step 4), every quantitative claim in the response traces to a real fetched value.

---

### `lib/data/market-data-router.ts` — Dual-Database Query Router

Abstracts the dual-database architecture. For any `(submarket_id, metric_name, time_window)` query:

- **Postgres/Supabase** — fresh operational data (last 7 days cached), single-ZIP lookups, low-latency reads.
- **BigQuery** — bulk historical series (years of data), Texas ZCTA dimension data, EDA distribution queries.

Also handles analytical comparison mode: fetching the same metric for a subject market and peer markets, returning normalized series for side-by-side charting.

---

### `app/api/*` — Data API Layer (~25 routes)

Each route validates parameters, checks the Supabase cache, calls the appropriate external source, upserts results back to cache, and returns JSON.

| Route | Primary Source | Cache TTL |
|-------|----------------|-----------|
| `/api/market` | FRED + Census + HUD + Zillow | Supabase 7-day |
| `/api/aggregate` | Supabase master_data | None (computed) |
| `/api/parcels` | NYC PLUTO SoDA API | Next.js ISR 7-day |
| `/api/permits` | Supabase nyc_permits table | None (pre-ingested) |
| `/api/tracts` | Census TIGER + ACS | Next.js ISR |
| `/api/floodrisk` | FEMA NFHL ArcGIS REST | Next.js ISR 30-day |
| `/api/amenities` | Overpass API (OSM) | In-memory 5-min |
| `/api/transit` | Overpass API + Transitland | In-memory 5-min |
| `/api/trends` | Google Trends API | None |
| `/api/momentum` | Internal scoring (FRED + Census + Zillow) | None |
| `/api/report/pdf` | Gemini + Zillow + all above | None |

---

### `lib/report/` — PDF Report Generation

Generates polished analyst-facing market reports via `/api/report/pdf`:

```
Payload → Build signal indicators (rent/vacancy/permits/employment trend direction)
        → Gemini generates cycle headline + 2–3 sentence narrative
        → Fetch Zillow ZORI monthly series (main chart)
        → Fetch metro peer benchmark (comparison bars)
        → Gemini generates full market dossier (multi-metric synthesis)
        → @react-pdf/renderer renders A4 PDF layout
        → Return PDF binary
```

A separate saved-charts PDF flow exports any charts or stat cards accumulated during the analyst's session, with custom section titles and notes.

---

### `lib/slash-commands.ts` — Command Palette

A client-side command interpreter giving analysts direct, deterministic control over the workspace:

| Command | Effect |
|---------|--------|
| `/go <zip\|city\|county\|metro>` | Navigate the map |
| `/layers:transit,parcels` | Toggle map layers by name |
| `/tilt 45` | Set camera pitch (0–67.5°) |
| `/rotate 90` | Set map heading |
| `/view 3d\|2d` | Toggle perspective mode |
| `/save [name]` | Persist market to shortlist |
| `/export` | Open PDF builder dialog |
| `/clear:layers\|terminal\|memory\|workspace` | Reset state scopes |
| `/restart` | Two-step full workspace wipe |

Commands that change local UI state run immediately client-side; commands that need server data (`/go`, `/save`) dispatch to the appropriate API.

---

### State Management — Zustand + Storage

Three state scopes with different persistence strategies:

| Store | File | Persistence | Data |
|-------|------|-------------|------|
| `useSitesStore` | `lib/sites-store.ts` | Supabase (anonymous auth) | Shortlist: saved ZIPs, notes, cycle stages |
| `useSavedChartsStore` | `lib/saved-charts-store.ts` | sessionStorage | Charts, stat cards, permit details |
| `useClientUploadMarkersStore` | `lib/client-upload-markers-store.ts` | sessionStorage | Uploaded CSV markers |

Map state (active layers, tilt, heading, active ZIP) lives in `page.tsx` via `useState` — not persisted, reconstructed on each market load.

---

### `AgenticNormalizer` — CSV Import + Geocoding
**Files:** `components/AgenticNormalizer.tsx`, `lib/google-forward-geocode.ts`, `lib/upload/suggest-location-column.ts`

When an analyst uploads a CSV file:
1. Gemini classifies which columns represent addresses/coordinates (JSON mode).
2. The app batch-geocodes detected address columns through the Google Geocoding API, caching results in Supabase.
3. Resolved lat/lng pairs become `ClientUploadMarker` objects plotted on the map as teal SVG pins.
4. The dataset's EDA profile (distributions, outliers, trends) is attached to the workspace context so the agent can answer questions about it.

---

## Key Design Choices and Problems They Solve

### Problem: LLM Hallucination of Market Data
**Solution:** Bounded intent lanes + synthesis-only Gemini use. The agent never asks Gemini to invent a number. Every quantitative claim comes from a real data fetch (Zillow, Census, FRED, Supabase) and is tagged with `[source: Label]` in the response. A grounding validator (`lib/agent-grounding-validator.ts`) classifies responses as `grounded`, `citation_incomplete`, or `synthetic`.

### Problem: Google Maps Can't Render Tens of Thousands of Points Efficiently
**Solution:** deck.gl WebGL overlay via `@deck.gl/google-maps`. All layers render in a single GPU context at 60 fps. Zoom-aware payloads (e.g., NYC permits: heatmap at zoom < 13, scatter at 13–15, bbox-filtered at ≥ 16) keep data transfer proportionate to what the user can actually see.

### Problem: Rate Limits and Cost on Live Public APIs
**Solution:** Three-layer cache:
1. **In-memory** (`lib/request-cache.ts`) — 5-min TTL, deduplicates in-flight requests.
2. **Supabase operational store** — 7-day TTL for live API results, checked before any external call.
3. **Next.js ISR** — `next: { revalidate }` caching for boundary GeoJSON and parcel data (7–30 days) at the CDN edge.

### Problem: Texas Cities Not Covered by Zillow's ZIP Table
**Solution:** BigQuery Texas ZCTA dimension table (ingested from Census + Texas open data) supplements Zillow coverage when the `zip_metro_lookup` table is incomplete. A merge function (`shouldMergeTexasCityCoverage`) detects the gap and fills it automatically.

### Problem: Agent Responses Need to Drive Map State
**Solution:** Agent returns a structured `AgentAction` object alongside the message. The client hook (`use-agent-intelligence.ts`) dispatches it to the parent page's state handlers — the agent describes what should change, the client applies it. The agent never directly mutates UI state.

### Problem: Analysts Need Evidence, Not Just Answers
**Solution:** Every agent response includes a full `AgentTrace` — task type, methodology, key findings, caveats, next questions, and a citations array. The `AgentThinkingPanel` renders this live as the response streams, giving analysts complete visibility into sources and reasoning.
