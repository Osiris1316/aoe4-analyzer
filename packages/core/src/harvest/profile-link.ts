/**
 * Read an aoe4world profile id out of whatever gets pasted into the
 * Backfill Player action: a profile link, a link to one of their games,
 * or just the number.
 *
 *   https://aoe4world.com/players/5411717-Osiris1316           → 5411717
 *   https://aoe4world.com/players/5411717-Osiris1316/games     → 5411717
 *   https://aoe4world.com/players/5411717/games/199769840      → 5411717
 *   aoe4world.com/players/5411717?tab=matchups                 → 5411717
 *   5411717                                                    → 5411717
 */

export type ProfileLinkResult =
  | { ok: true; profileId: number }
  | { ok: false; error: string };

const MAX_PROFILE_ID = 2 ** 31 - 1;

export function parseProfileLink(input: string): ProfileLinkResult {
  const raw = (input ?? '').trim().replace(/^<|>$/g, '');
  if (raw === '') return { ok: false, error: 'Paste an aoe4world profile link, for example https://aoe4world.com/players/5411717-Osiris1316.' };

  if (/^\d+$/.test(raw)) return checkId(Number(raw), raw);

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: `"${raw}" is neither a link nor a profile number.` };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'aoe4world.com') {
    return { ok: false, error: `That link is to ${url.hostname}, not aoe4world.com. Open the player on aoe4world and copy the address from there.` };
  }

  const m = url.pathname.match(/^\/players\/(\d+)(?:[-/]|$)/);
  if (!m || !m[1]) {
    return { ok: false, error: `That aoe4world link isn't a player profile (expected /players/<number>-<name>, got ${url.pathname}).` };
  }
  return checkId(Number(m[1]), raw);
}

function checkId(id: number, raw: string): ProfileLinkResult {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_PROFILE_ID) {
    return { ok: false, error: `"${raw}" doesn't hold a valid profile number.` };
  }
  return { ok: true, profileId: id };
}
