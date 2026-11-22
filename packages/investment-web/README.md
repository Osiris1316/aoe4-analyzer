# aoe4-investment

This is the phone page for the investment ratios, plus its read-only API. It's a Worker of its own, bound only to v2, and the live API Worker on v1 is never touched. It's public and ungated, and it only reads data. Every player name it shows is already public on aoe4world.

The page (`public/`) is plain HTML, CSS and JS, served as static assets. Results load from `/api/meta`, `/api/rows` and `/api/game` (`src/worker.ts`), and the player views from `/api/players` and `/api/player` (`src/players.ts`).

## Pages

**Games** is the list of player-games, one card per player per age, with the opponent's same age beside it. On wide screens the picked game fills a board on the right. Names on the board, and the profile buttons under an opened card, lead to that player's profile.

**Players** lists the tracked people: everyone in `harvest/players.json` plus anyone added with the Backfill Player action. Each card shows their record, their median military in each age with the usual time they reached the next one, their main civs, and how far a running backfill has got. A search finds anyone else in the analysed games, opponents included.

**A profile** (`#view=player&p=<profile id>`) combines a person's accounts. It shows how they invest in each age (the median, the middle half and the spread on the same scale as the cards, split into units, production and defense), when they usually reach the next age, the same by civ, and their record against each civ and on each map. Their games follow, with the same cards, filters, age path and board as Games.

**Pinning** works like following in the league manager. Pin one player, from their profile or the player list, and this browser remembers them: the chip in the head leads to their profile, and Games opens on their games with a switch to everyone. Elsewhere a small pin marks them. The pin lives in the browser only (localStorage); nothing is stored on the server. The filters are age window, group, civ, opponent civ, player name and "aged up only". You can sort by combined, units, production, defense or walls ratio, by age-up time, or by date. Tap a row to see what was counted, the divisor, and a link to the game on aoe4world. The current filters stay in the address bar, so a link to the page opens with them already set.

The age path works like an opening tree. In any age you can narrow the list to a range of one ratio, either by tapping bars in the histogram or by typing the bounds. The later ages then show only the player-games whose earlier rows fall inside every range on the path. A range set on a later age never narrows an earlier one. The histogram always shows the whole spread for the current path, and the chosen range is highlighted on it.

Deploy from the repo root:

```
npx wrangler deploy --config packages/investment-web/wrangler.jsonc
```

It's then live at `https://aoe4-investment.<your subdomain>.workers.dev`.
