/**
 * scripts/fetch-static.ts
 *
 * Fetches unit data from data.aoe4world.com and populates the static
 * reference tables: units, pbgid_aliases, unit_lines, line_upgrades.
 *
 * Usage:
 *   npx tsx scripts/fetch-static.ts              ← fetch all civs, populate tables
 *   npx tsx scripts/fetch-static.ts --skip-fetch  ← skip HTTP fetch, just reload from saved JSON
 *   npx tsx scripts/fetch-static.ts --civ english  ← fetch one civ only
 *
 * The script saves raw JSON to static/unit-data/ so you don't have to
 * re-fetch every time. Use --skip-fetch to reload from saved files.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Configuration ──────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '..', 'data', 'local.db');
const STATIC_DIR = path.resolve(__dirname, '..', 'static', 'unit-data');
const FETCH_DELAY_MS = 200;

// ── Civ Discovery ──────────────────────────────────────────────────────

/**
 * Discover available civs by listing .json files in the aoe4world/data
 * GitHub repo's units/ directory. No hardcoded civ list — if a new civ
 * is added to the game and the data repo is updated, this picks it up.
 */
async function discoverCivSlugs(): Promise<string[]> {
  const url = 'https://api.github.com/repos/aoe4world/data/contents/units';
  console.log('  Discovering civs from GitHub...');

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
    }

    const entries = await res.json() as { name: string; type: string }[];

    // Keep only .json files, strip extension, then filter to base civ files.
    // The repo has three variants per civ (e.g. english.json, english-optimized.json,
    // english-unified.json) plus meta files (all.json, all-baseids.json, etc.).
    // We want only the base files — they have the richest data.
    const allSlugs = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.json'))
      .map(e => e.name.replace(/\.json$/, ''));

    const civs = allSlugs.filter(s =>
      !s.endsWith('-optimized') &&
      !s.endsWith('-unified') &&
      !s.startsWith('all')
    );

    console.log(`  Found ${civs.length} civs: ${civs.join(', ')}`);
    return civs;
  } catch (err: any) {
    console.log(`  [WARN] GitHub API failed: ${err.message}`);
    console.log('  Falling back to cached files on disk...');
    return discoverCivsFromCache();
  }
}

/**
 * Fallback: discover civs from previously cached JSON files in static/unit-data/.
 */
function discoverCivsFromCache(): string[] {
  if (!fs.existsSync(STATIC_DIR)) return [];
  const files = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.json'));
  const civs = files.map(f => f.replace(/\.json$/, ''));
  if (civs.length > 0) {
    console.log(`  Found ${civs.length} cached civs: ${civs.join(', ')}`);
  } else {
    console.log('  No cached files found either. Run without --skip-fetch first.');
  }
  return civs;
}

// ── Pbgid Aliases (hardcoded from Dim_PbgidAlias_v5) ──────────────────

const PBGID_ALIASES: {
  observedPbgid: number;
  canonicalPbgid: number | null;
  canonicalCatalog: string;
  customToken: string | null;
}[] = [
  { observedPbgid: 5000071,  canonicalPbgid: 5000070,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2150983,  canonicalPbgid: 2124341,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2145966,  canonicalPbgid: 2127064,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143513,  canonicalPbgid: 2143512,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143515,  canonicalPbgid: 2127061,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2145967,  canonicalPbgid: 2127064,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143516,  canonicalPbgid: 2127061,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2141247,  canonicalPbgid: 2528652,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 5000114,  canonicalPbgid: 5000115,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 5271010,  canonicalPbgid: 129969,   canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 7804932,  canonicalPbgid: 129969,   canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 5000110,  canonicalPbgid: 5000111,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 5000102,  canonicalPbgid: 5000111,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2138205,  canonicalPbgid: 2127064,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2138188,  canonicalPbgid: 2143512,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2138204,  canonicalPbgid: 2127061,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143839,  canonicalPbgid: 2124339,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143863,  canonicalPbgid: 4137773,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 2143533,  canonicalPbgid: 2143534,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 9001370,  canonicalPbgid: 9001369,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 9001371,  canonicalPbgid: 9001369,  canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 165135,   canonicalPbgid: 132274,   canonicalCatalog: 'units', customToken: null },
  { observedPbgid: 9000101,  canonicalPbgid: null,      canonicalCatalog: 'custom', customToken: 'turkic_archer' },
  { observedPbgid: 9000103,  canonicalPbgid: null,      canonicalCatalog: 'custom', customToken: 'turkic_archer' },
  { observedPbgid: 2161903,  canonicalPbgid: null,      canonicalCatalog: 'custom', customToken: 'crown_king' },
  { observedPbgid: 2127468,  canonicalPbgid: null,      canonicalCatalog: 'custom', customToken: 'treasure_caravan' },
];

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Unit data from the aoe4world/data repo.
 * 
 * This interface is intentionally permissive — we store whatever the API
 * sends rather than filtering to a fixed set of fields. New resources
 * (olive oil, silver, future ones) flow through automatically. New fields
 * the API adds get stored in the raw JSON without code changes.
 */
interface Aoe4WorldUnit {
  id: string;          // 'man-at-arms-2'
  baseId: string;      // 'man-at-arms'
  type: string;        // 'unit'
  name: string;        // 'Early Man-at-Arms'
  pbgid: number;
  age: number;         // 1-4
  civs: string[];
  classes: string[];
  displayClasses?: string[];
  costs: Record<string, number>;   // flexible: {food, wood, gold, stone, olive_oil, silver, total, popcap, time, ...}
  producedBy?: string[];
  icon: string;        // URL
  hitpoints: number;
  weapons?: unknown[];
  armor?: unknown[];
  description?: string;
  [key: string]: unknown;          // catch-all for any fields we haven't named
}

// ── Fetching ───────────────────────────────────────────────────────────

async function fetchCivUnits(civ: string): Promise<Aoe4WorldUnit[] | null> {
  // Try the per-civ URL first, then the unified path
  const urls = [
    `https://data.aoe4world.com/units/${civ}.json`,
    `https://data.aoe4world.com/units/unified/${civ}.json`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();

      // Extract unit entries from the response.
      // The aoe4world data files may contain buildings, technologies, and
      // other game objects alongside units. We filter to type === 'unit'
      // here because our DB only has a units table right now. If we add
      // a technologies table later (e.g. for Macedonian silver upgrades),
      // this is the place to capture them.
      const extractUnits = (obj: any): Aoe4WorldUnit[] => {
        // Handle {data: [...]} wrapper (the actual aoe4world format)
        if (obj && obj.data && Array.isArray(obj.data)) {
          return obj.data.filter((u: any) => u && u.type === 'unit');
        }
        // Direct array
        if (Array.isArray(obj)) {
          return obj.filter((u: any) => u && u.type === 'unit');
        }
        // Object with unit entries as values
        if (obj && typeof obj === 'object') {
          return Object.values(obj).filter(
            (v: any) => v && typeof v === 'object' && v.type === 'unit'
          ) as Aoe4WorldUnit[];
        }
        return [];
      };

      const units = extractUnits(data);
      if (units.length > 0) return units;

      console.log(`  [WARN] ${civ}: unexpected data shape from ${url}`);
    } catch (e: any) {
      // Network error or parse error — try next URL
    }
  }

  return null;
}

async function fetchAllCivs(civs: string[]): Promise<Map<string, Aoe4WorldUnit[]>> {
  const results = new Map<string, Aoe4WorldUnit[]>();

  for (const civ of civs) {
    process.stdout.write(`  Fetching ${civ}...`);

    const cached = path.join(STATIC_DIR, `${civ}.json`);
    const units = await fetchCivUnits(civ);

    if (units && units.length > 0) {
      // Save raw data for future --skip-fetch runs
      fs.writeFileSync(cached, JSON.stringify(units, null, 2));
      results.set(civ, units);
      console.log(` ${units.length} units`);
    } else {
      console.log(` FAILED (no data returned)`);
    }

    await sleep(FETCH_DELAY_MS);
  }

  return results;
}

function loadCachedCivs(civs: string[]): Map<string, Aoe4WorldUnit[]> {
  const results = new Map<string, Aoe4WorldUnit[]>();

  for (const civ of civs) {
    const cached = path.join(STATIC_DIR, `${civ}.json`);
    if (fs.existsSync(cached)) {
      const data = JSON.parse(fs.readFileSync(cached, 'utf-8'));
      results.set(civ, data);
      console.log(`  Loaded ${civ}: ${data.length} units (cached)`);
    } else {
      console.log(`  [SKIP] ${civ}: no cached file`);
    }
  }

  return results;
}

// ── Database Population ────────────────────────────────────────────────

function populateUnitsTable(db: Database.Database, allUnits: Map<string, Aoe4WorldUnit[]>) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO units
      (unit_id, base_id, name, pbgid, age, classes, display_classes,
       costs, hitpoints, weapons, armor, civs, produced_by, icon, description)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const seenIds = new Set<string>();

  const insertAll = db.transaction(() => {
    for (const [, units] of allUnits) {
      for (const u of units) {
        // Skip duplicates (same unit may appear in multiple civ files)
        if (seenIds.has(u.id)) continue;
        seenIds.add(u.id);

        insert.run(
          u.id,                                          // unit_id
          u.baseId,                                      // base_id
          u.name,                                        // name
          u.pbgid ?? null,                               // pbgid
          u.age ?? null,                                 // age
          JSON.stringify(u.classes ?? []),                // classes
          u.displayClasses ? JSON.stringify(u.displayClasses) : null,  // display_classes
          JSON.stringify(u.costs ?? {}),                  // costs
          u.hitpoints ?? null,                           // hitpoints
          u.weapons ? JSON.stringify(u.weapons) : null,  // weapons
          u.armor ? JSON.stringify(u.armor) : null,      // armor
          JSON.stringify(u.civs ?? []),                   // civs
          u.producedBy ? JSON.stringify(u.producedBy) : null,  // produced_by
          u.icon ?? null,                                // icon
          u.description ?? null,                         // description
        );
        count++;
      }
    }
  });

  insertAll();
  return count;
}

function populateAliases(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO pbgid_aliases
      (observed_pbgid, canonical_catalog, canonical_pbgid, custom_token)
    VALUES (?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const a of PBGID_ALIASES) {
      insert.run(a.observedPbgid, a.canonicalCatalog, a.canonicalPbgid, a.customToken);
    }
  });

  insertAll();
  return PBGID_ALIASES.length;
}

function populateUnitLines(db: Database.Database, allUnits: Map<string, Aoe4WorldUnit[]>) {
  // Build unit_lines from the aoe4world data.
  // Each unit has id like 'archer-2' and baseId like 'archer'.
  // The buildOrder uses icon paths like 'icons/races/common/units/archer_2'.
  // The icon_key is the last path segment: 'archer_2' (underscores).
  // 
  // Strategy: for each unit, derive the icon_key that the buildOrder would
  // use by converting the unit id (hyphens) to underscores.
  // Map that icon_key → baseId (with hyphens converted to underscores too).

  const insert = db.prepare(`
    INSERT OR REPLACE INTO unit_lines (icon_key, line_key, label)
    VALUES (?, ?, ?)
  `);

  let count = 0;
  const seenKeys = new Set<string>();

  const insertAll = db.transaction(() => {
    for (const [, units] of allUnits) {
      for (const u of units) {
        // Convert 'archer-2' → 'archer_2' for icon_key
        const iconKey = u.id.replace(/-/g, '_');
        if (seenKeys.has(iconKey)) continue;
        seenKeys.add(iconKey);

        // Convert 'man-at-arms' → 'man_at_arms' for line_key
        const lineKey = u.baseId.replace(/-/g, '_');

        // Use the unit name as-is for the label. We previously stripped
        // age prefixes like "Early"/"Veteran"/"Elite" here, but that's a
        // hardcoded list that would break with new naming patterns. The
        // label is for display only — the line_key handles grouping.
        const label = u.name;

        insert.run(iconKey, lineKey, label);
        count++;
      }
    }
  });

  insertAll();
  return count;
}

function populateLineUpgrades(db: Database.Database, allUnits: Map<string, Aoe4WorldUnit[]>) {
  // line_upgrades maps (upgrade_icon_key, line_key) → tier.
  // In AoE4, the tier is the age number. Units like 'archer-2' (age 2) and
  // 'archer-3' (age 3) represent tier upgrades of the 'archer' line.
  // 
  // The "upgrade_icon_key" is the icon_key of the upgraded version.
  // This table answers: "when I see icon_key 'archer_3', that means the
  // 'archer' line is now at tier 3."

  const insert = db.prepare(`
    INSERT OR REPLACE INTO line_upgrades (upgrade_icon_key, line_key, tier)
    VALUES (?, ?, ?)
  `);

  let count = 0;
  const seenKeys = new Set<string>();

  const insertAll = db.transaction(() => {
    for (const [, units] of allUnits) {
      for (const u of units) {
        const iconKey = u.id.replace(/-/g, '_');
        const lineKey = u.baseId.replace(/-/g, '_');
        const compositeKey = `${iconKey}|${lineKey}`;
        if (seenKeys.has(compositeKey)) continue;
        seenKeys.add(compositeKey);

        const tier = u.age ?? 1;
        insert.run(iconKey, lineKey, tier);
        count++;
      }
    }
  });

  insertAll();
  return count;
}

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ───────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);
  const skipFetch = args.includes('--skip-fetch');
  const civFlag = args.indexOf('--civ');
  const singleCiv = civFlag !== -1 ? args[civFlag + 1] : null;

  // Ensure static directory exists
  fs.mkdirSync(STATIC_DIR, { recursive: true });

  // Determine civ list
  let civs: string[];
  if (singleCiv) {
    civs = [singleCiv];
  } else if (skipFetch) {
    civs = discoverCivsFromCache();
  } else {
    civs = await discoverCivSlugs();
  }

  if (civs.length === 0) {
    console.log('No civs found. Exiting.');
    return;
  }

  // Step 1: Fetch or load unit data
  console.log('=== Step 1: Unit data ===');
  let allUnits: Map<string, Aoe4WorldUnit[]>;

  if (skipFetch) {
    console.log('Loading from cached files...');
    allUnits = loadCachedCivs(civs);
  } else {
    console.log('Fetching from data.aoe4world.com...');
    allUnits = await fetchAllCivs(civs);
  }

  const totalUnits = [...allUnits.values()].reduce((s, u) => s + u.length, 0);
  console.log(`\nTotal: ${totalUnits} units across ${allUnits.size} civs\n`);

  if (totalUnits === 0) {
    console.log('No unit data fetched. Check URLs and network connectivity.');
    console.log('You can try fetching a single civ to debug:');
    console.log('  npx tsx scripts/fetch-static.ts --civ english');
    console.log('\nOr visit https://data.aoe4world.com/ to check available endpoints.');
    return;
  }

  // Step 2: Populate database
  console.log('=== Step 2: Database ===');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const unitCount = populateUnitsTable(db, allUnits);
  console.log(`  units table: ${unitCount} rows`);

  const aliasCount = populateAliases(db);
  console.log(`  pbgid_aliases table: ${aliasCount} rows`);

  const lineCount = populateUnitLines(db, allUnits);
  console.log(`  unit_lines table: ${lineCount} rows`);

  const upgradeCount = populateLineUpgrades(db, allUnits);
  console.log(`  line_upgrades table: ${upgradeCount} rows`);

  // Step 3: Verification
  console.log('\n=== Step 3: Verification ===');

  const pbgidCoverage = db.prepare(`
    SELECT COUNT(*) as total FROM units WHERE pbgid IS NOT NULL
  `).get() as { total: number };
  console.log(`  Units with pbgid: ${pbgidCoverage.total}`);

  // Check how many of the extracted unresolved pbgids would now resolve
  const sampleRow = db.prepare(`
    SELECT unit_events_json FROM game_player_data
    WHERE unit_events_json IS NOT NULL LIMIT 1
  `).get() as { unit_events_json: string } | undefined;

  if (sampleRow) {
    const events = JSON.parse(sampleRow.unit_events_json);
    const unresolvedBefore = events.unresolvedPbgids?.length ?? 0;

    // Check each unresolved pbgid against the now-populated tables
    let wouldResolve = 0;
    for (const pbgid of events.unresolvedPbgids ?? []) {
      const inUnits = db.prepare(`SELECT 1 FROM units WHERE pbgid = ?`).get(pbgid);
      const inAlias = db.prepare(`SELECT 1 FROM pbgid_aliases WHERE observed_pbgid = ?`).get(pbgid);
      if (inUnits || inAlias) wouldResolve++;
    }

    console.log(`  Sample game: ${unresolvedBefore} unresolved pbgids, ${wouldResolve} would now resolve`);
  }

  console.log('\n=== Done ===');
  console.log('To re-extract with proper resolution, run:');
  console.log('  1. Clear old extractions:');
  console.log('     npx tsx -e "const db=require(\'better-sqlite3\')(\'./data/local.db\');db.prepare(\'UPDATE game_player_data SET unit_events_json=NULL,computed_at=NULL\').run();console.log(\'Cleared.\')"');
  console.log('  2. Re-extract:');
  console.log('     npx tsx scripts/extract.ts');

  db.close();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
