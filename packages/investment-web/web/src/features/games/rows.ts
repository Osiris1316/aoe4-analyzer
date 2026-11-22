// One player's age, read from a result row or from its opponent's opp_* columns.
import type { Row } from '../../api/types';
import { parseJson } from '../../lib/format';
import type { Bucket } from '../../lib/game';

export interface CountedItem { bucket: Bucket; id: string; n: number; cost: number }

export interface Side {
  combined: number; units: number; production: number; defense: number; walls: number;
  start: number; end: number; reached: boolean; cost: number; costSource: string;
  /** Production, units and defense, in resources. */
  spend: number;
  items: CountedItem[]; flags: string[];
}

export function side(r: Row, pre: '' | 'opp_'): Side | null {
  const get = (k: string) => (r as unknown as Record<string, unknown>)[pre + k];
  const num = (k: string) => Number(get(k) ?? 0);
  if (get('ratio_combined') === null || get('ratio_combined') === undefined) return null;
  return {
    combined: num('ratio_combined'), units: num('ratio_units'), production: num('ratio_production'),
    defense: num('ratio_defense'), walls: num('ratio_walls'),
    start: num('window_start_sec'), end: num('window_end_sec'), reached: !!get('reached_next_age'),
    cost: num('next_age_cost'), costSource: String(get('next_age_cost_source') || ''),
    spend: num('spend_production') + num('spend_units') + num('spend_defense'),
    items: parseJson<CountedItem[]>(get('items_json') as string | null, []),
    flags: parseJson<string[]>(get('flags_json') as string | null, []),
  };
}

export const names = (r: Row) => ({ a: r.person || r.player_name || '?', b: r.opp_person || r.opponent_name || '?' });

/** What one side made in one bucket: id -> count and spend. */
export function counts(d: Side | null, bucket: Bucket): Map<string, { n: number; spend: number }> {
  const m = new Map<string, { n: number; spend: number }>();
  for (const i of d ? d.items : []) {
    if (i.bucket !== bucket) continue;
    const c = m.get(i.id) ?? { n: 0, spend: 0 };
    c.n += i.n; c.spend += i.n * i.cost;
    m.set(i.id, c);
  }
  return m;
}

export const rowKey = (r: { game_id: number; profile_id: number }) => r.game_id + '.' + r.profile_id;
