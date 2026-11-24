# Investment ratios (metric v1)

For each player and age window (dark, feudal, castle), the analysis adds up what was spent at listed cost in four buckets: military production buildings, military units that reached the field, defensive structures with their tower upgrades, and walls. Each total is divided by the cost of the age-up the player bought next. The combined ratio adds up the first three. Walls are kept separate. The logic is in `packages/core/src/investment/metric.ts`, and the script is `scripts/analyze-investment.ts`.

## The four files here

| File | What it decides | How to change it |
|---|---|---|
| `categories.json` | What counts, and in which bucket. Generated from the Sheet "AoE4 military investment lists". | Change the Sheet and ask Claude to sync, or edit the file. |
| `game-data.json` | What everything costs, and which civ each variation belongs to. Comes from the aoe4world data repo at one pinned commit. | After a patch, run `npx tsx scripts/refresh-game-data.ts --commit <sha>` and commit the result. |
| `overrides.json` | Prices for free units that have no paid counterpart, and the default age-up costs. | Edit by hand. |
| `maps.json` | Map types. Only land maps are analysed, and a map that isn't listed counts as land and gets flagged. | Edit by hand. |

## Economy: extra Town Centers

Each row also counts the extra Town Centers the player completed in that age (`tc_built`) and when the first one completed (`tc_first_sec`). The starting Town Center never counts. They are counted at completion, not at the payment estimate the military spend uses, because many villagers usually build a TC and the estimate lands a minute or more early. They never enter the spend or the ratios. Which buildings count is the hand-kept `economy.townCenters` list at the end of `categories.json`; carry it over when the file is next synced from the Sheet. Rows written before migration 005 have NULL there, meaning not measured; `--rerun` fills them. The report's section 8 lists anything worth checking.

Every result row records the metric version, the fingerprints of these files and the data commit. After a change, `--rerun` replaces the current version's rows, or `--version v1b` writes a new set beside the old one.

## Commands

```
npx tsx scripts/analyze-investment.ts --migrate                # once: create the tables in v2
npx tsx scripts/analyze-investment.ts --dry-run --report       # compute, print, check; writes nothing
npx tsx scripts/analyze-investment.ts                          # analyse new games and write rows
npx tsx scripts/analyze-investment.ts --game 261321914 --items # one game, listing every counted item
npx tsx scripts/analyze-investment.ts --rerun                  # recompute everything after a config change
npx tsx scripts/analyze-investment.ts --retry-skipped          # after editing maps.json
npx tsx scripts/analyze-investment.ts --local <folder>         # summaries from a folder, no database
```

The harvest workflow runs the analysis after retrieval once the repo variable `INVESTMENT_ANALYSIS` is set to `on`.
