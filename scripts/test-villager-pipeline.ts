#!/usr/bin/env npx tsx
/**
 * test-villager-pipeline.ts
 *
 * End-to-end test: D1 blob → extraction → timeline → analysis → printed results.
 * Combines discovery (what's in the blob?) with analysis (does the pipeline work?).
 *
 * Usage:
 *   npx tsx scripts/test-villager-pipeline.ts <game_id> <profile_id> [civ]
 *
 * Environment variables (required):
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_D1_DATABASE_ID
 *
 * Placement: scripts/test-villager-pipeline.ts
 */

import { buildTimeline, type CivRule, type GameEvent } from "../packages/core/src/analysis/timeline-builder";
import { analyzeVillagerProduction, type AnalysisInput } from "../packages/core/src/analysis/villager-analysis";

// ── CLI Args ───────────────────────────────────────────────

const gameId = process.argv[2];
const profileId = process.argv[3];
const civOverride = process.argv[4] || "";

if (!gameId || !profileId) {
  console.error("Usage: npx tsx scripts/test-villager-pipeline.ts <game_id> <profile_id> [civ]");
  process.exit(1);
}

// ── D1 REST API ────────────────────────────────────────────

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID;

if (!API_TOKEN || !ACCOUNT_ID || !DATABASE_ID) {
  console.error("Missing environment variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID");
  process.exit(1);
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function queryD1(sql: string, params: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  const resp = await fetch(D1_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`D1 query failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as {
    result: Array<{ results: Record<string, unknown>[]; success: boolean }>;
    success: boolean;
  };

  if (!data.success || !data.result?.[0]?.success) {
    throw new Error(`D1 query error: ${JSON.stringify(data)}`);
  }

  return data.result[0].results;
}

// ── Discovery Helpers ──────────────────────────────────────

function describeValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[] (empty array)";
    return `[${typeof v[0]}] × ${v.length} (first: ${JSON.stringify(v[0])}, last: ${JSON.stringify(v[v.length - 1])})`;
  }
  if (typeof v === "object") return `{${Object.keys(v as object).join(", ")}}`;
  if (typeof v === "string" && v.length > 80) return `"${v.slice(0, 80)}..." (${v.length} chars)`;
  return JSON.stringify(v);
}

function dumpBlobStructure(label: string, blob: unknown): void {
  console.log(`\n── ${label} ──`);
  if (blob === null || blob === undefined) {
    console.log("  NULL / missing");
    return;
  }
  if (Array.isArray(blob)) {
    console.log(`  Array with ${blob.length} entries`);
    // Show first 3 entries' shapes
    for (let i = 0; i < Math.min(3, blob.length); i++) {
      const entry = blob[i];
      if (typeof entry === "object" && entry !== null) {
        console.log(`  [${i}] keys: ${Object.keys(entry).join(", ")}`);
        console.log(`       type=${(entry as any).type}, id=${(entry as any).id}`);
        if ((entry as any).icon) console.log(`       icon=${(entry as any).icon}`);
        if ((entry as any).displayName) console.log(`       displayName=${(entry as any).displayName}`);
        // Show array fields and their shapes
        for (const [k, v] of Object.entries(entry)) {
          if (Array.isArray(v) && v.length > 0) {
            console.log(`       ${k}: ${describeValue(v)}`);
          }
        }
      } else {
        console.log(`  [${i}] ${describeValue(entry)}`);
      }
    }
    if (blob.length > 3) console.log(`  ... and ${blob.length - 3} more entries`);
  } else if (typeof blob === "object") {
    const keys = Object.keys(blob as object);
    console.log(`  Object with keys: ${keys.join(", ")}`);
    for (const key of keys) {
      console.log(`  .${key}: ${describeValue((blob as any)[key])}`);
    }
  } else {
    console.log(`  ${typeof blob}: ${describeValue(blob)}`);
  }
}

// ── Extraction Logic ───────────────────────────────────────

interface ExtractionResult {
  startCount: number;
  completions: number[];
  tcEvents: GameEvent[];
  villagerEntryFound: boolean;
  tcEntryFound: boolean;
  villagerEntryId: string;
  tcEntryId: string;
}

function extractVillagerData(blob: unknown): ExtractionResult {
  // Resolve to an array of entries
  let entries: any[];
  if (Array.isArray(blob)) {
    entries = blob;
  } else if (typeof blob === "object" && blob !== null) {
    // Try known keys: buildOrder, units, entries
    const obj = blob as Record<string, unknown>;
    entries = (obj.buildOrder ?? obj.units ?? obj.entries ?? []) as any[];
    if (!Array.isArray(entries)) {
      console.log("  ⚠ Could not find array within blob object. Keys:", Object.keys(obj).join(", "));
      entries = [];
    }
  } else {
    entries = [];
  }

  console.log(`\n── Extraction: scanning ${entries.length} entries ──`);

  // ── Find villager entry ──────────────────────────────
  const villagerEntry = entries.find((e: any) => {
    const id = String(e.id || "").toLowerCase();
    const icon = String(e.icon || "").toLowerCase();
    const name = String(e.displayName || e.name || "").toLowerCase();
    return (
      id.includes("villager") ||
      icon.includes("villager") ||
      name.includes("villager")
    );
  });

  // ── Find TC entry ────────────────────────────────────
  const tcEntry = entries.find((e: any) => {
    const id = String(e.id || "").toLowerCase();
    const icon = String(e.icon || "").toLowerCase();
    const name = String(e.displayName || e.name || "").toLowerCase();
    return (
      id.includes("town_center") || id.includes("towncenter") || id.includes("town-center") ||
      icon.includes("town_center") || icon.includes("towncenter") ||
      name.includes("town center") || name.includes("town_center")
    );
  });

  // ── Parse villager finished array ────────────────────
  let startCount = 6; // default
  let completions: number[] = [];

  if (villagerEntry?.finished && Array.isArray(villagerEntry.finished)) {
    const finished: number[] = villagerEntry.finished;
    // Leading zeros = starting units
    startCount = 0;
    while (startCount < finished.length && finished[startCount] === 0) {
      startCount++;
    }
    completions = finished.slice(startCount);
    console.log(`  Villager entry: id="${villagerEntry.id}", icon="${villagerEntry.icon}"`);
    console.log(`  finished array: ${finished.length} elements, ${startCount} starting, ${completions.length} produced`);
    console.log(`  First 5 completions: [${completions.slice(0, 5).join(", ")}]`);
    console.log(`  Last 5 completions: [${completions.slice(-5).join(", ")}]`);
  } else if (villagerEntry) {
    console.log(`  ⚠ Villager entry found but no 'finished' array. Keys: ${Object.keys(villagerEntry).join(", ")}`);
    // Try other possible field names
    for (const key of ["finished", "produced", "completed", "created"]) {
      if (Array.isArray(villagerEntry[key])) {
        console.log(`  → Found array under '${key}': ${villagerEntry[key].length} elements`);
      }
    }
  } else {
    console.log("  ⚠ No villager entry found in blob entries");
    // List all entry ids for debugging
    const ids = entries.slice(0, 20).map((e: any) => `${e.type}:${e.id}`);
    console.log(`  Available entries (first 20): ${ids.join(", ")}`);
  }

  // ── Parse TC events ──────────────────────────────────
  const tcEvents: GameEvent[] = [];

  if (tcEntry) {
    console.log(`  TC entry: id="${tcEntry.id}", icon="${tcEntry.icon}"`);

    const constructed: number[] = tcEntry.constructed || [];
    const destroyed: number[] = tcEntry.destroyed || [];

    console.log(`  constructed: [${constructed.join(", ")}]`);
    console.log(`  destroyed: [${destroyed.join(", ")}]`);

    for (const t of constructed) {
      if (t > 0) {
        tcEvents.push({ event_type: "tc_constructed", timestamp_sec: t });
      }
    }
    for (const t of destroyed) {
      tcEvents.push({ event_type: "tc_destroyed", timestamp_sec: t });
    }
    tcEvents.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  } else {
    console.log("  ⚠ No TC entry found in blob entries");
    // List building-type entries for debugging
    const buildings = entries.filter((e: any) => String(e.type || "").toLowerCase() === "building");
    const bIds = buildings.slice(0, 10).map((e: any) => e.id);
    console.log(`  Building entries (first 10): ${bIds.join(", ")}`);
  }

  return {
    startCount,
    completions,
    tcEvents,
    villagerEntryFound: !!villagerEntry,
    tcEntryFound: !!tcEntry,
    villagerEntryId: villagerEntry?.id || "(none)",
    tcEntryId: tcEntry?.id || "(none)",
  };
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  VILLAGER ANALYSIS PIPELINE TEST                 ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\nGame: ${gameId}  Player: ${profileId}  Civ override: ${civOverride || "(auto-detect)"}\n`);

  // ── Step 1: Fetch game metadata ────────────────────────
  console.log("═══ STEP 1: Fetch game metadata ═══");

  const gameRows = await queryD1("SELECT * FROM games WHERE game_id = ?", [Number(gameId)]);
  if (gameRows.length === 0) {
    console.error(`Game ${gameId} not found in games table`);
    process.exit(1);
  }

  const game = gameRows[0];
  console.log(`Game table columns: ${Object.keys(game).join(", ")}`);

  const durationSec = (game.duration_sec ?? game.durationSec ?? game.duration ?? 0) as number;
  const buildNumber = (game.build_number ?? game.buildNumber ?? 0) as number;
  console.log(`Duration: ${durationSec}s (${(durationSec / 60).toFixed(1)} min)`);
  console.log(`Build number: ${buildNumber}`);

  // Try to detect civ from game row
  let civ = civOverride;
  if (!civ) {
    // Check common column patterns: p0_civ/p1_civ, or player_civ
    for (const key of Object.keys(game)) {
      if (key.includes("civ")) {
        console.log(`  ${key}: ${game[key]}`);
      }
    }
    // Try matching profile_id to p0/p1
    const p0id = game.p0_profile_id ?? game.player0_profile_id;
    const p1id = game.p1_profile_id ?? game.player1_profile_id;
    if (String(p0id) === profileId) civ = String(game.p0_civ || "");
    else if (String(p1id) === profileId) civ = String(game.p1_civ || "");
    console.log(`Detected civ: "${civ}" (p0_id=${p0id}, p1_id=${p1id})`);
  }

  if (!civ) {
    console.log("⚠ Could not detect civ. Using 'unknown'. Analysis will still run with standard 20s interval.");
    civ = "unknown";
  }

  // ── Step 2: Fetch player blob ──────────────────────────
  console.log("\n═══ STEP 2: Fetch player blob ═══");

  const playerRows = await queryD1(
    "SELECT non_eco_json, eco_json FROM game_player_data WHERE game_id = ? AND profile_id = ?",
    [Number(gameId), Number(profileId)]
  );

  if (playerRows.length === 0) {
    console.error(`No game_player_data row for game ${gameId}, profile ${profileId}`);
    process.exit(1);
  }

  const nonEcoRaw = playerRows[0].non_eco_json as string | null;
  const ecoRaw = playerRows[0].eco_json as string | null;

  console.log(`non_eco_json: ${nonEcoRaw ? `${nonEcoRaw.length} chars` : "NULL"}`);
  console.log(`eco_json: ${ecoRaw ? `${(ecoRaw as string).length} chars` : "NULL"}`);

  if (!nonEcoRaw) {
    console.error("\n✗ non_eco_json is NULL. This game may be from the slim slice migration.");
    console.error("  Try a game ingested by the GitHub Actions pipeline (after session 15).");
    if (ecoRaw) {
      console.log("\n  eco_json IS present. Dumping structure in case villager data is there:");
      const ecoBlob = JSON.parse(ecoRaw);
      dumpBlobStructure("eco_json", ecoBlob);
    }
    process.exit(1);
  }

  // ── Step 3: Discovery ──────────────────────────────────
  console.log("\n═══ STEP 3: Blob discovery ═══");

  const nonEcoBlob = JSON.parse(nonEcoRaw);
  dumpBlobStructure("non_eco_json (top level)", nonEcoBlob);

  // If it has a buildOrder key, also dump that
  if (typeof nonEcoBlob === "object" && !Array.isArray(nonEcoBlob) && nonEcoBlob.buildOrder) {
    dumpBlobStructure("non_eco_json.buildOrder", nonEcoBlob.buildOrder);
  }

  // Also dump eco_json structure if present
  if (ecoRaw) {
    const ecoBlob = JSON.parse(ecoRaw);
    dumpBlobStructure("eco_json (top level)", ecoBlob);
  }

  // ── Step 4: Extraction ─────────────────────────────────
  console.log("\n═══ STEP 4: Extraction ═══");

  const extraction = extractVillagerData(nonEcoBlob);

  // If extraction failed on non_eco, try eco
  if (!extraction.villagerEntryFound && ecoRaw) {
    console.log("\n  Villager not found in non_eco_json. Trying eco_json...");
    const ecoBlob = JSON.parse(ecoRaw);
    const ecoExtraction = extractVillagerData(ecoBlob);
    if (ecoExtraction.villagerEntryFound) {
      console.log("  ✓ Found villager data in eco_json!");
      Object.assign(extraction, ecoExtraction);
    }
  }

  if (!extraction.villagerEntryFound) {
    console.error("\n✗ Could not find villager data in either blob.");
    console.error("  Check the discovery output above for the actual entry IDs and structure.");
    process.exit(1);
  }

  console.log(`\n  Extraction summary:`);
  console.log(`    Start count: ${extraction.startCount}`);
  console.log(`    Completions: ${extraction.completions.length}`);
  console.log(`    TC events: ${extraction.tcEvents.length}`);
  for (const e of extraction.tcEvents) {
    console.log(`      ${e.event_type} at ${e.timestamp_sec}s`);
  }

  // ── Step 5: Timeline Builder ───────────────────────────
  console.log("\n═══ STEP 5: Timeline Builder ═══");

  // v1 rules: standard 20s interval for all civs
  const rules: CivRule[] = [{ rule_key: "tc.base_interval", value: 20 }];

  const segments = buildTimeline(rules, extraction.tcEvents);

  console.log(`Segments: ${segments.length}`);
  for (const seg of segments) {
    const to = seg.to_sec === null ? "end" : String(seg.to_sec);
    const gap = seg.expected_gap === Infinity ? "∞" : seg.expected_gap.toFixed(2);
    console.log(
      `  [${seg.from_sec}s → ${to}]  ` +
      `sources: ${seg.sources.length}  ` +
      `expected_gap: ${gap}s`
    );
  }

  // ── Step 6: Analysis ───────────────────────────────────
  console.log("\n═══ STEP 6: Villager Analysis ═══");

  const input: AnalysisInput = {
    game_id: Number(gameId),
    profile_id: Number(profileId),
    civ,
    build_number: buildNumber,
    game_duration_sec: durationSec,
    start_count: extraction.startCount,
    completions: extraction.completions,
    segments,
  };

  const result = analyzeVillagerProduction(input);

  // ── Print Results ──────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  ANALYSIS RESULTS                                ║");
  console.log("╚══════════════════════════════════════════════════╝");

  console.log(`\nGame: ${result.game_id} | Player: ${result.profile_id} | Civ: ${result.civ}`);
  console.log(`Duration: ${result.game_duration_sec}s (${(result.game_duration_sec / 60).toFixed(1)} min)`);
  console.log(`Build: ${result.build_number} | Supported: ${result.supported}`);

  if (!result.supported) {
    console.log("Analysis not supported (game too short).");
    return;
  }

  console.log(`\n── Headlines ──`);
  console.log(`  Start count: ${result.start_count}`);
  console.log(`  Total produced: ${result.total_completions}`);
  console.log(`  Total villagers: ${result.start_count + result.total_completions}`);
  console.log(`  Last completion: ${result.last_completion_sec}s (${(result.last_completion_sec / 60).toFixed(1)} min)`);
  console.log(`  First-queue delay: ${result.first_queue_delay_sec === null ? "N/A" : `${result.first_queue_delay_sec}s`}`);
  console.log(`  Total idle: ${result.total_idle_sec.toFixed(1)}s`);
  console.log(`  Longest stall: ${result.longest_stall_sec.toFixed(1)}s`);

  console.log(`\n── Stats Triplet ──`);
  console.log(`  Mode: ${result.stats.mode_excess}`);
  console.log(`  Median: ${result.stats.median_excess.toFixed(2)}`);
  console.log(`  Mean: ${result.stats.mean_excess.toFixed(2)}`);
  console.log(`  Behavioral profile: ${result.stats.behavioral_profile}`);

  // Curve at key timestamps
  console.log(`\n── Curve Snapshots ──`);
  const snapshotTimes = [60, 120, 180, 240, 300, 420, 600, result.last_completion_sec, result.game_duration_sec];
  const uniqueTimes = [...new Set(snapshotTimes.filter(t => t > 0 && t <= result.game_duration_sec))].sort((a, b) => a - b);

  for (const targetT of uniqueTimes) {
    // Find closest curve point at or before targetT
    let closest = result.curve[0];
    for (const p of result.curve) {
      if (p.t <= targetT) closest = p;
      else break;
    }
    const label = targetT === result.last_completion_sec ? " (last vill)" :
                  targetT === result.game_duration_sec ? " (game end)" : "";
    console.log(
      `  t=${closest.t.toString().padStart(5)}s${label.padEnd(14)} ` +
      `ideal=${closest.ideal_count.toFixed(1).padStart(6)}  ` +
      `actual=${String(closest.actual_count).padStart(4)}  ` +
      `debt=${closest.debt.toFixed(2).padStart(6)}  ` +
      `eff=${(closest.efficiency * 100).toFixed(1).padStart(5)}%  ` +
      `stall_debt=${closest.cumulative_stall_debt.toFixed(2)}  ` +
      `chronic_debt=${closest.cumulative_chronic_debt.toFixed(2)}`
    );
  }

  // Top 5 gaps by excess
  console.log(`\n── Top 5 Gaps (by excess) ──`);
  const sortedGaps = [...result.gaps].sort((a, b) => b.excess_sec - a.excess_sec).slice(0, 5);
  for (const g of sortedGaps) {
    if (g.excess_sec === 0) continue;
    console.log(
      `  ${g.from_sec}s → ${g.to_sec}s  ` +
      `gap=${g.gap_sec}s  expected=${g.expected_gap.toFixed(1)}s  ` +
      `excess=${g.excess_sec.toFixed(1)}s  debt=${g.debt_vills.toFixed(3)} vills  ` +
      `TCs=${g.segment_tc_count}`
    );
  }
  if (sortedGaps.every(g => g.excess_sec === 0)) {
    console.log("  (no excess gaps — perfect production)");
  }

  // Stall callouts
  console.log(`\n── Stall Callouts (${result.stall_callouts.length}) ──`);
  for (const c of result.stall_callouts.slice(0, 10)) {
    const tag = c.is_first_queue ? "[FIRST-QUEUE]" : "[STALL]";
    console.log(
      `  ${tag} ${c.from_sec}s → ${c.to_sec}s  ` +
      `idle=${c.idle_sec.toFixed(1)}s  debt=${c.debt_vills.toFixed(3)} vills`
    );
  }
  if (result.stall_callouts.length > 10) {
    console.log(`  ... and ${result.stall_callouts.length - 10} more`);
  }
  if (result.stall_callouts.length === 0) {
    console.log("  (none — stalls only surface in single-TC phases)");
  }

  console.log("\n✓ Pipeline complete.");
}

main().catch((err) => {
  console.error("\n✗ Pipeline failed:", err);
  process.exit(1);
});
