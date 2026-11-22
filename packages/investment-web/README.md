# aoe4-investment

The investment pages and their read-only API. It's a Worker of its own, bound only to v2, and the live API Worker on v1 is never touched. It's public and ungated, and it only reads data. Every player name it shows is already public on aoe4world.

The pages are a React app (React 19, React Router 7, Vite), built the same way as the matchup library and the analyzer's web package. The Worker (`src/`) answers `/api/*`; everything else is the built app, served as static assets in single-page mode, so any page address opens the app and the router draws the page.

## Pages

| Address | Page |
|---|---|
| `/` | **Games**: every analysed player-game, one card per player per age with the opponent's same age beside it. On wide screens the picked game fills a board on the right, with a link to its own page; on phones a card opens the game's page. With a pinned player it opens on their games, with a switch to everyone. |
| `/games/:id` | **A game**: both players across every age, where they meet, what each made, how they aged up, and their Twitch VODs. `?p=` picks whose side is "Player" (Swap sides flips it); `?window=` is the age in view. Below desktop width the three ages sit in a sideways scroller with age buttons to jump between them. |
| `/players` | **Players**: the tracked people as one row each, after aoe4world's rankings. Civs as flags, games, win-loss, share won, and per age the median military and the usual time they reached the next age, then last game and backfill progress. Every comparable column sorts; the order stays in the address. The search narrows the table and also finds anyone else in the analysed games. |
| `/players/:id` | **A player's overview**: how they invest in each age (the spread on the cards' scale, split into units, production and defense), when and how they reach the next age (with the landmarks or wings they use), the same by civ, and their record against each civ and on each map. Any of a person's accounts opens it; alts are combined. |
| `/players/:id/games` | **A player's games**: the same cards, filters, age path and board as Games, only theirs. |

The game list's filters live in the address (`?window=feudal&civ=french&r_dark=combined:0:0.5`), so a link opens with them set and the back button walks real pages. Old `#view=...` links and bookmarks turn into these addresses on load.

**Civ pickers** show flags: the filters' pickers show only the flag, and the list shows flag and name.

**Twitch VODs** come from the v2 `games` table (`p0_twitch_vod_url`, `p1_twitch_vod_url`), which retrieval fills from aoe4world's game list (`twitch_video_url`, the streamer's video with `?t=` at the game's start). Cards with a VOD show a small video mark, a filter keeps only those games, and the game page links each player's VOD at the start of the game and at the start of each age (the `t` offset plus the age's start in game seconds). Only https Twitch addresses become links.

**Pinning** works like following in the league manager: pin one player and this browser remembers them (localStorage only; nothing is stored on the server).

**The age path** works like an opening tree. In any age you can narrow the list to a range of one ratio, by tapping histogram bars or typing the bounds. Later ages then show only the player-games whose earlier rows fall inside every range on the path.

**Icons**: civ flags come from the league manager. Unit, building, technology and landmark icons, and the names shown beside them, come from the [AoE4 World data repo](https://github.com/aoe4world/data) at the commit the metric is pinned to. `scripts/icons.ts` copies the icon of everything the metric can count and of every age-up into `web/public/icons` and writes `web/src/icons.generated.ts`. Run it again from the repo root after `refresh-game-data` moves the commit or `categories.json` gains ids:

```
npx tsx packages/investment-web/scripts/icons.ts
```

Age of Empires IV © Microsoft Corporation. These pages were made under Microsoft's Game Content Usage Rules using assets from Age of Empires IV, and they are not endorsed by or affiliated with Microsoft.

## Layout

```
src/                    the Worker: worker.ts (meta, rows, game) and players.ts (players, player)
web/                    the app (Vite root)
  index.html
  public/               _headers (CSP and caching), fonts, flags, icons
  src/
    main.tsx            start: old hash links, then the router
    app/                router, layout (bar and foot), paths (every address), meta
    api/                fetch with a short cache; response types
    lib/                formatting, civs and items, pinning, media queries
    kit/                shared pieces: Ratio, Flag, ItemIcon, Bar, Strip, Pin, SortTh
    features/games/     the game list: state in the address, filters, age path, cards, board
    pages/              games, players, player (layout, overview, games)
    styles/             tokens and base; components keep their own CSS modules
scripts/icons.ts        copies icons and names from the aoe4world data repo
dist/                   the build (not committed)
```

## Deploy

From the repo root:

```
npx wrangler deploy --config packages/investment-web/wrangler.jsonc
```

Wrangler builds the app first (`pnpm --filter @aoe4analyzer/investment-web build`: a type check, then Vite), so this one command is still the whole deploy. After pulling changes to this package, run `pnpm install` once.

## Local development

Two terminals from the repo root: `npx wrangler dev --config packages/investment-web/wrangler.jsonc --remote` (the API on 8787, reading the real v2; without `--remote` it reads an empty local copy), then `pnpm --filter @aoe4analyzer/investment-web dev` (the app on 5173, sending `/api` to 8787). The API only ever reads.
