# aoe4-investment

This is the phone page for the investment ratios, plus its read-only API. It's a Worker of its own, bound only to v2, and the live API Worker on v1 is never touched. It's public and ungated, and it only reads data. Every player name it shows is already public on aoe4world.

The page (`public/`) is plain HTML, CSS and JS, served as static assets. Results load from `/api/meta` and `/api/rows` (`src/worker.ts`). The filters are age window, group, civ, opponent civ, player name and "aged up only". You can sort by combined, units, production, defense or walls ratio, by age-up time, or by date. Tap a row to see what was counted, the divisor, and a link to the game on aoe4world. The current filters stay in the address bar, so a link to the page opens with them already set.

The age path works like an opening tree. In any age you can narrow the list to a range of one ratio, either by tapping bars in the histogram or by typing the bounds. The later ages then show only the player-games whose earlier rows fall inside every range on the path. A range set on a later age never narrows an earlier one. The histogram always shows the whole spread for the current path, and the chosen range is highlighted on it.

Deploy from the repo root:

```
npx wrangler deploy --config packages/investment-web/wrangler.jsonc
```

It's then live at `https://aoe4-investment.<your subdomain>.workers.dev`.
