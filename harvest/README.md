# Harvest

Collects whole aoe4world game summaries for a tracked set of players into v2 (D1) and R2. Analysis reads from what this stores and can be rerun at any time.

## How it fits together

1. **Player source** (`packages/core/src/harvest/player-source.ts`) answers one question: who is tracked. Two sources exist today: `file` (this folder's `players.json`, the default) and `v2` (the v2 `watchlist`, rows with `active = 1`). A new source is one function in that module. Nothing else changes.
2. **Discovery** (`scripts/discover-games.ts`) asks aoe4world for the tracked players' finished ranked 1v1 games and adds new ones to `pending_jobs`.
3. **Retrieval** (`scripts/retrieve-pending.ts`) works through `pending_jobs`. For each game it stores the summary exactly as received at `summaries/{gameId}.json.gz`, the split eco and non-eco blobs at `gpd/{gameId}/{profileId}/…`, and then the D1 rows. Retrieval never reads the player list.
4. **Workflow** (`.github/workflows/harvest.yml`) runs discovery and then retrieval, every two hours once the schedule is switched on, or by hand from the Actions tab.

All three scripts refuse the v1 database id.

## Editing the player list

Edit `players.json` (the GitHub app works). Each entry needs `profileId` (the number in the aoe4world profile link, without quotes), `person` (alt accounts share one person) and `group` (one of the `groups` listed at the top of the file). Optional fields are `note`, and `"active": false` to pause a player without deleting the line.

To check the file after editing, run the command below. It validates the file and looks up every name on aoe4world. It writes nothing and needs no Cloudflare credentials.

```
npx tsx scripts/discover-games.ts --check
```

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

## Failures

A 429 or a network error leaves the game `pending`, and the next run tries it again. Anything else marks it `failed`, with the reason stored in `error`. The row stays in place so discovery never queues that game again. To re-queue a failed game:

```sql
UPDATE pending_jobs SET status = 'pending', error = NULL WHERE game_id = 123;
```

If five games in a row hit trouble, the run stops early and leaves the rest pending.

## aoe4world etiquette

Summaries are expensive for aoe4world to compute, and their API page asks people not to bulk crawl. Keep the tracked list hand-picked. Leave the 5-second gap between summary fetches as it is. Talk to the aoe4world developers before growing the list toward a top-N ladder feed.
