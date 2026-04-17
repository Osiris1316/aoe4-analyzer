# AoE4 Analyzer

Fight-by-fight match analyzer for AoE4 1v1 ladder games. Pulls replay data from aoe4world, detects battles, snapshots unit compositions, and shows you what actually happened — not just who won.

## What it does

- Ingests match + build order data from the [aoe4world API](https://aoe4world.com) for a watchlist of players
- Parses build orders into unit produced/destroyed event streams
- Detects battles by clustering death events with a sliding window algorithm
- Classifies battle severity by proportional army loss (fraction of army killed, not absolute value)
- Snapshots unit compositions before and after each battle
- Segments each game into a timeline of battles and inter-battle periods
- Serves it all through a React dashboard with army value charts, composition panels, and scrubbing

## Prerequisites

- Node.js v20+ (v22 recommended)
- pnpm (`npm install -g pnpm`, or use `npx pnpm` if you don't want to install it globally)

## Setup

```bash
# Clone and install
git clone https://github.com/Osiris1316/aoe4-analyzer.git
cd aoe4-analyzer
pnpm install

# Create the database
npx tsx scripts/migrate.ts

# Fetch unit data from aoe4world (one-time)
npx tsx scripts/fetch-static.ts
```

## Populate with data

```bash
# Add top 50 ladder players to the watchlist
npx tsx scripts/import-top-players.ts

# Fetch games from aoe4world for all active players
npx tsx scripts/ingest.ts run

# Extract unit events from the raw game data
npx tsx scripts/extract.ts

# Run battle detection and analysis
npx tsx scripts/analyze.ts
```

Each step is idempotent — safe to re-run. Ingestion only fetches games not already in the database. Analysis only processes games that haven't been analyzed yet. Use `--all` with analyze to re-process everything.

## Run locally

Two terminals:

```bash
# Terminal 1: API server (port 3001)
npx tsx packages/api/src/index.ts

# Terminal 2: Frontend dev server (port 5173)
cd packages/web
pnpm dev
```

Open `http://localhost:5173`.

## Project structure

```
packages/
  core/     ← ingestion, extraction, analysis (pure logic, no platform deps)
  api/      ← Hono HTTP server (5 read-only endpoints)
  web/      ← React + Vite dashboard
scripts/    ← CLI tools for ingestion, extraction, analysis
static/     ← unit data snapshots from aoe4world
data/       ← SQLite database (gitignored)
```

## Tech stack

TypeScript · SQLite (better-sqlite3) · Hono · React · Vite · Recharts · pnpm monorepo

Designed to port to Cloudflare Workers + D1 + Pages — same Hono routes, same SQL schema, just async DB calls.

## Rate limiting

The ingestion script pauses 2000ms between API calls and tracks failed fetches to avoid re-requesting games that aren't available. Once a game is stored, aoe4world is never contacted for it again.
