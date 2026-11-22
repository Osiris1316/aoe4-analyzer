# Harvest

Collects whole aoe4world game summaries for a tracked set of players into v2 (D1) and R2. Analysis reads from what this stores and can be rerun at any time.

## How it fits together

1. **Player source** (`packages/core/src/harvest/player-source.ts`) answers one question: who is tracked. Three sources exist today: `file` (this folder's `players.json`), `file+links` (`players.json` plus the players added by link through the Backfill Player action; the workflows' default), and `v2` (the v2 `watchlist`, rows with `active = 1`). A new source is one function in that module. Nothing else changes.
2. **Discovery** (`scripts/discover-games.ts`) asks aoe4world for the tracked players' finished ranked 1v1 games and adds new ones to `pending_jobs`. It also mirrors `players.json` into the v2 table `tracked_players`, so the investment page knows everyone's group. It writes only the rows that changed.
3. **Retrieval** (`scripts/retrieve-pending.ts`) works through `pending_jobs`, new games first, then a capped number of backfill games. For each game it stores the summary exactly as received at `summaries/{gameId}.json.gz`, the split eco and non-eco blobs at `gpd/{gameId}/{profileId}/…`, and then the D1 rows. Retrieval never reads the player list.
4. **Workflows**: `.github/workflows/harvest.yml` runs discovery, retrieval and analysis every two hours, or by hand from the Actions tab. `.github/workflows/backfill-player.yml` is the Backfill Player action below.

All three scripts refuse the v1 database id.

## Editing the player list

Edit `players.json` (the GitHub app works). Each entry needs `profileId` (the number in the aoe4world profile link, without quotes), `person` (alt accounts share one person) and `group` (one of the `groups` listed at the top of the file). Optional fields are `note`, and `"active": false` to pause a player without deleting the line.

To check the file after editing, run the command below. It validates the file and looks up every name on aoe4world. It writes nothing and needs no Cloudflare credentials.

```
npx tsx scripts/discover-games.ts --check
```

## Backfilling a player from a link

In the Actions tab, open **Backfill Player (v2)**, press **Run workflow**, and paste the player's aoe4world profile link (a link to one of their games works too, and so does the bare number). Leave the rest as it is, or set:

- **months**: how far back, 24 by default, 36 at most.
- **group**: for someone new, `pro`, `league`, `me` or `other` (the default). Blank keeps the group of someone added before.
- **person**: for an alt account, the name of the person it belongs to, so the page shows both accounts on one profile.
- **follow**: on by default, so the harvest also picks up their new games from now on.
- **first batch**: how many summaries to fetch straight away, 40 by default.

The run reads the player's game list from aoe4world, one page of 50 games at a time, and queues every finished ranked 1v1 game v2 doesn't have yet. It then fetches the first batch and analyses it, so the player's profile on the page fills in within minutes. The run's summary page says how many games were found and roughly how long the rest will take.

The rest trickle in with the scheduled harvest, after its new games, newest first: `BACKFILL_PER_RUN` games a run (repo variable, 20 by default, so up to 240 a day). If one player's backfill hits 25 unavailable summaries in a row, retrieval parks their older backfill games instead of trying each one; this is usually where aoe4world stops keeping summaries. To try parked games again:

```sql
UPDATE pending_jobs SET status = 'pending', error = NULL WHERE status = 'parked';
```

A player who is already in `players.json` keeps the file's group, person and following; the backfill only queues their games. A player added by link stays out of `players.json`; to make them permanent and hand-edited, add them to the file, and the file takes over.

Before the first backfill, v2 needs migration 003: `npx tsx scripts/migrate-v2.ts` lists what's applied, and `--apply` adds the missing ones.

Please keep backfills to players you actually want to study. A two-year backfill can be a few thousand summaries, and aoe4world computes each one on request (see etiquette below).

## Switching the player source to v2

In the repo, go to Settings → Secrets and variables → Actions → Variables, and set `HARVEST_PLAYER_SOURCE` to `v2`. Locally, pass `--source v2` or set `PLAYER_SOURCE=v2`. The v2 source reads `watchlist` rows with `active = 1`. It maps `is_pro = 1` to the group `pro` and everything else to `tracked`. Keeping groups like `me` and `league` in v2 would need a small migration plus a third source.

## Common runs

| What | Command |
|---|---|
| Preview, write nothing | `npx tsx scripts/discover-games.ts --dry-run` |
| Normal incremental (last 4 h) | `npx tsx scripts/discover-games.ts` |
| Catch up after an outage | `npx tsx scripts/discover-games.ts --since-hours 24` |
| Seed: last N games per player | `npx tsx scripts/discover-games.ts --recent-per-player 10` |
| Only some groups | add `--groups me,league` |
| Retrieve a tiny batch | `npx tsx scripts/retrieve-pending.ts --limit 3` |
| Check what landed (read-only) | `npx tsx scripts/verify-harvest.ts` |
| Backfill a player, preview only | `npx tsx scripts/backfill-player.ts --profile <link> --dry-run` |
| Retrieve without backfill games | `npx tsx scripts/retrieve-pending.ts --backfill-limit 0` |
| v2 migrations: list, then apply | `npx tsx scripts/migrate-v2.ts`, then `--apply` |

## Failures

A 429 or a network error leaves the game `pending`, and the next run tries it again. Anything else marks it `failed`, with the reason stored in `error`. The row stays in place so discovery never queues that game again. To re-queue a failed game:

```sql
UPDATE pending_jobs SET status = 'pending', error = NULL WHERE game_id = 123;
```

If five games in a row hit trouble, the run stops early and leaves the rest pending.

## aoe4world etiquette

Summaries are expensive for aoe4world to compute, and their API page asks people not to bulk crawl. Keep the tracked list hand-picked. Leave the 5-second gap between summary fetches as it is. Talk to the aoe4world developers before growing the list toward a top-N ladder feed, and before raising `BACKFILL_PER_RUN` or backfilling many players at once.
