/**
 * Watchlist orchestrator.
 *
 * Loops through active watched players, fetches their recent games,
 * and stores everything in the database.
 *
 * Key decisions (from plan):
 *   - Opponents are auto-inserted into watchlist as inactive entries
 *   - game_id check and (game_id, profile_id) check are independent
 *   - INSERT OR IGNORE on games handles two watched players facing each other
 *   - The loop is fully idempotent
 *
 * v2 changes:
 *   - Opponent-fallback fetch: if summary 404s via player A, retry via player B
 *   - Failed-games table: skip games that recently failed, avoid burning API calls
 *   - Consecutive-failure early abort: if 10+ games in a row fail for a player, skip them
 */

import type Database from 'better-sqlite3';
import type { ApiGameListEntry, ApiSummaryPlayer } from '../types/api-responses';
import type { AnalyzerConfig } from '../types/game';
import { fetchRecentGames, fetchGameSummary, sleep } from './aoe4world-api';
import { splitSummaryToCoreAndPlayers, splitPlayerEcoNonEco, scrubUrlsDeep } from './parsers';

/** Result returned after an ingestion run */
export interface IngestionResult {
  gamesInserted: number;
  playerDataInserted: number;
  gamesSkipped: number;
  errors: string[];
}

/** How many consecutive failures before we skip the rest of a player's games */
const CONSECUTIVE_FAIL_LIMIT = 10;

/** Don't retry a failed game for this many days */
const FAILED_RETRY_DAYS = 7;

/**
 * Ensure the failed_fetches table exists.
 * Called once at the start of ingestion.
 */
function ensureFailedFetchesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS failed_fetches (
      game_id        INTEGER PRIMARY KEY,
      last_attempted TEXT NOT NULL,
      error          TEXT
    )
  `);
}

/**
 * Check if a game recently failed and should be skipped.
 */
function isRecentlyFailed(db: Database.Database, gameId: number): boolean {
  const row = db.prepare(
    'SELECT last_attempted FROM failed_fetches WHERE game_id = ?'
  ).get(gameId) as { last_attempted: string } | undefined;

  if (!row) return false;

  const failedAt = new Date(row.last_attempted).getTime();
  const cutoff = Date.now() - FAILED_RETRY_DAYS * 24 * 60 * 60 * 1000;
  return failedAt > cutoff;
}

/**
 * Record a failed fetch so we don't retry it next run.
 */
function recordFailedFetch(db: Database.Database, gameId: number, error: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO failed_fetches (game_id, last_attempted, error)
    VALUES (?, ?, ?)
  `).run(gameId, new Date().toISOString(), error);
}

/**
 * Extract the opponent's profile_id from a game list entry.
 * Returns null if we can't determine the opponent.
 */
function getOpponentProfileId(gameEntry: ApiGameListEntry, myProfileId: number): number | null {
  for (const team of gameEntry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id !== myProfileId) {
        return slot.player.profile_id;
      }
    }
  }
  return null;
}

/**
 * Try to fetch a game summary, falling back to the opponent's profile if the
 * primary player's endpoint 404s.
 *
 * Returns the summary, or throws if both perspectives fail.
 */
async function fetchSummaryWithFallback(
  primaryProfileId: number,
  opponentProfileId: number | null,
  gameId: number,
  sleepMs: number,
): Promise<any> {
  try {
    return await fetchGameSummary(primaryProfileId, gameId);
  } catch (err) {
    const msg = (err as Error).message;

    // Only try fallback on 404 — other errors (rate limit, network) should propagate
    if (!msg.includes('404') || !opponentProfileId) {
      throw err;
    }

    // Try the opponent's perspective
    console.log(`    404 via ${primaryProfileId}, trying opponent ${opponentProfileId}...`);
    await sleep(sleepMs);
    return await fetchGameSummary(opponentProfileId, gameId);
  }
}

/**
 * Run ingestion for all active players in the watchlist.
 */
export async function ingestAllActivePlayers(
  db: Database.Database,
  config: AnalyzerConfig['ingestion']
): Promise<IngestionResult> {
  ensureFailedFetchesTable(db);

  const players = db
    .prepare('SELECT profile_id, name FROM watchlist WHERE active = 1')
    .all() as { profile_id: number; name: string }[];

  const result: IngestionResult = {
    gamesInserted: 0,
    playerDataInserted: 0,
    gamesSkipped: 0,
    errors: [],
  };

  let totalFetched = 0;

  for (const player of players) {
    console.log(`\nIngesting games for ${player.name} (${player.profile_id})...`);

    try {
      const playerResult = await ingestOnePlayer(db, player.profile_id, config);
      result.gamesInserted += playerResult.gamesInserted;
      result.playerDataInserted += playerResult.playerDataInserted;
      result.gamesSkipped += playerResult.gamesSkipped;
      result.errors.push(...playerResult.errors);
      totalFetched += playerResult.gamesInserted;

      // Update last_fetched
      db.prepare('UPDATE watchlist SET last_fetched = ? WHERE profile_id = ?').run(
        new Date().toISOString(),
        player.profile_id
      );
    } catch (err) {
      const msg = `Failed to ingest ${player.name}: ${(err as Error).message}`;
      console.error(msg);
      result.errors.push(msg);
    }

    // Stop if we've hit the per-run limit
    if (totalFetched >= config.maxGamesPerRun) {
      console.log(`Reached maxGamesPerRun (${config.maxGamesPerRun}), stopping.`);
      break;
    }
  }

  return result;
}

/**
 * Run ingestion for a single player.
 */
export async function ingestOnePlayer(
  db: Database.Database,
  profileId: number,
  config: AnalyzerConfig['ingestion']
): Promise<IngestionResult> {
  ensureFailedFetchesTable(db);

  const result: IngestionResult = {
    gamesInserted: 0,
    playerDataInserted: 0,
    gamesSkipped: 0,
    errors: [],
  };

  // Step 1: Fetch recent game list
  const gameList = await fetchRecentGames(
    profileId,
    config.leaderboard,
    config.maxGamesPerPlayer
  );

  console.log(`  Found ${gameList.games.length} games in list.`);

  let consecutiveFailures = 0;

  // Step 2: Process each game
  for (const gameEntry of gameList.games) {
    const gameId = gameEntry.game_id;

    // ── Early abort: too many failures in a row for this player ────
    if (consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) {
      console.log(`  Skipping remaining games — ${CONSECUTIVE_FAIL_LIMIT} consecutive failures.`);
      break;
    }

    // ── Skip recently failed games ────────────────────────────────
    if (isRecentlyFailed(db, gameId)) {
      result.gamesSkipped++;
      continue;
    }

    // Check if we already have player data for this (game_id, profile_id)
    const hasPlayerData = db
      .prepare('SELECT 1 FROM game_player_data WHERE game_id = ? AND profile_id = ?')
      .get(gameId, profileId);

    if (hasPlayerData) {
      result.gamesSkipped++;
      consecutiveFailures = 0;  // successful skip = game exists, reset counter
      continue;
    }

    // Check if we already have the game row
    const hasGame = db
      .prepare('SELECT 1 FROM games WHERE game_id = ?')
      .get(gameId);

    // Get opponent profile_id from the game list for fallback fetching
    const opponentId = getOpponentProfileId(gameEntry, profileId);

    if (!hasGame) {
      // Need to fetch the full summary
      try {
        await sleep(config.sleepMsBetweenFetches);

        console.log(`  Fetching summary for game ${gameId}...`);
        const summary = await fetchSummaryWithFallback(
          profileId, opponentId, gameId, config.sleepMsBetweenFetches
        );

        const { gameCore, players } = splitSummaryToCoreAndPlayers(summary);

        if (players.length < 2) {
          result.errors.push(`Game ${gameId}: expected 2 players, got ${players.length}`);
          recordFailedFetch(db, gameId, `expected 2 players, got ${players.length}`);
          consecutiveFailures++;
          continue;
        }

        const p0 = players[0];
        const p1 = players[1];

        // Auto-insert any unseen players into watchlist (inactive)
        ensureWatchlistEntry(db, p0.profileId, p0.name);
        ensureWatchlistEntry(db, p1.profileId, p1.name);

        // Scrub URLs from the core blob
        const coreScrubbed = scrubUrlsDeep(gameCore);

        // Determine started_at — summary has unix timestamp, convert to ISO
        const startedAtIso = new Date(summary.startedAt * 1000).toISOString();

        // INSERT OR IGNORE into games
        db.prepare(`
          INSERT OR IGNORE INTO games (
            game_id, started_at, duration_sec, map, leaderboard, fetched_at,
            p0_profile_id, p1_profile_id,
            p0_civ, p1_civ,
            p0_result, p1_result,
            p0_rating, p1_rating,
            core_json,
            p0_twitch_vod_url, p1_twitch_vod_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          gameId,
          startedAtIso,
          summary.duration,
          summary.mapName,
          summary.leaderboard,
          new Date().toISOString(),
          p0.profileId,
          p1.profileId,
          p0.civilization,
          p1.civilization,
          p0.result,
          p1.result,
          getRatingFromGameList(gameEntry, p0.profileId),
          getRatingFromGameList(gameEntry, p1.profileId),
          JSON.stringify(coreScrubbed),
          getVodUrlFromGameList(gameEntry, p0.profileId),
          getVodUrlFromGameList(gameEntry, p1.profileId)
        );

        // Insert player data for BOTH players
        insertPlayerData(db, gameId, p0, 0);
        insertPlayerData(db, gameId, p1, 1);

        result.gamesInserted++;
        result.playerDataInserted += 2;
        consecutiveFailures = 0;  // Reset on success
      } catch (err) {
        const msg = `Game ${gameId}: ${(err as Error).message}`;
        console.error(`  ERROR: ${msg}`);
        result.errors.push(msg);
        recordFailedFetch(db, gameId, (err as Error).message);
        consecutiveFailures++;
        continue;
      }
    } else {
      // Game row exists but we're missing player data for this profile_id.
      try {
        await sleep(config.sleepMsBetweenFetches);

        console.log(`  Fetching summary for game ${gameId} (need player data)...`);
        const summary = await fetchSummaryWithFallback(
          profileId, opponentId, gameId, config.sleepMsBetweenFetches
        );

        const { players } = splitSummaryToCoreAndPlayers(summary);

        // Find this player in the summary
        const player = players.find(p => p.profileId === profileId);
        if (!player) {
          result.errors.push(`Game ${gameId}: profile ${profileId} not found in summary`);
          consecutiveFailures++;
          continue;
        }

        const playerIndex = players.indexOf(player);
        insertPlayerData(db, gameId, player, playerIndex);
        result.playerDataInserted++;
        consecutiveFailures = 0;  // Reset on success
      } catch (err) {
        const msg = `Game ${gameId} (player data): ${(err as Error).message}`;
        console.error(`  ERROR: ${msg}`);
        result.errors.push(msg);
        consecutiveFailures++;
        continue;
      }
    }
  }

  return result;
}

/**
 * Insert a player's eco and non-eco data into game_player_data.
 */
function insertPlayerData(
  db: Database.Database,
  gameId: number,
  player: ApiSummaryPlayer,
  playerIndex: number
): void {
  const { eco, nonEco } = splitPlayerEcoNonEco(player);
  const ecoScrubbed = scrubUrlsDeep(eco);
  const nonEcoScrubbed = scrubUrlsDeep(nonEco);

  db.prepare(`
    INSERT OR IGNORE INTO game_player_data (
      game_id, profile_id, player_index, eco_json, non_eco_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    gameId,
    player.profileId,
    playerIndex,
    JSON.stringify(ecoScrubbed),
    JSON.stringify(nonEcoScrubbed)
  );
}

/**
 * Ensure a profile_id exists in the watchlist.
 * If it doesn't, insert it as inactive (active=0, is_pro=0).
 */
function ensureWatchlistEntry(
  db: Database.Database,
  profileId: number,
  name: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO watchlist (profile_id, name, is_pro, active)
    VALUES (?, ?, 0, 0)
  `).run(profileId, name);
}

/**
 * Extract a player's MMR from the game list entry.
 */
function getRatingFromGameList(
  gameEntry: ApiGameListEntry,
  profileId: number
): number | null {
  for (const team of gameEntry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id === profileId) {
        return slot.player.mmr ?? slot.player.rating ?? null;
      }
    }
  }
  return null;
}

/**
 * Extract a player's Twitch VOD URL from the game list entry.
 */
function getVodUrlFromGameList(
  gameEntry: ApiGameListEntry,
  profileId: number
): string | null {
  for (const team of gameEntry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id === profileId) {
        return (slot.player as any).twitch_video_url ?? null;
      }
    }
  }
  return null;
}