// The game's vocabulary: civs, ages, and the things the metric counts, with
// their names and icons (icons.generated.ts, from the aoe4world data repo).
import { ITEMS } from '../icons.generated';

export const CIVS: Record<string, string> = {
  abbasid_dynasty: 'Abbasid', ayyubids: 'Ayyubids', byzantines: 'Byzantines', chinese: 'Chinese',
  delhi_sultanate: 'Delhi', english: 'English', french: 'French', golden_horde: 'Golden Horde',
  holy_roman_empire: 'HRE', house_of_lancaster: 'Lancaster', japanese: 'Japanese', jeanne_darc: 'Jeanne',
  jin_dynasty: 'Jin', knights_templar: 'Templar', macedonian_dynasty: 'Macedonian', malians: 'Malians',
  mongols: 'Mongols', order_of_the_dragon: 'OotD', ottomans: 'Ottomans', rus: 'Rus', scots: 'Scots',
  sengoku_daimyo: 'Sengoku', tughlaq_dynasty: 'Tughlaq', vikings: 'Vikings', zhu_xis_legacy: 'Zhu Xi',
};
// Flag files (public/flags, from the league manager), by civ id.
const FLAGS: Record<string, string> = { zhu_xis_legacy: 'zhu-xi-legacy' };
const FLAG_FILES = new Set(['abbasid-dynasty', 'ayyubids', 'byzantines', 'chinese', 'delhi-sultanate', 'english', 'french', 'golden-horde',
  'holy-roman-empire', 'house-of-lancaster', 'japanese', 'jeanne-darc', 'jin-dynasty', 'knights-templar', 'macedonian-dynasty', 'malians',
  'mongols', 'order-of-the-dragon', 'ottomans', 'rus', 'scots', 'sengoku-daimyo', 'tughlaq-dynasty', 'vikings', 'zhu-xi-legacy']);

export function civName(id: string | null | undefined): string {
  if (!id) return '?';
  return CIVS[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function flagUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  const f = FLAGS[id] ?? id.replace(/_/g, '-');
  return FLAG_FILES.has(f) ? '/flags/' + f + '.png' : null;
}

export const WINDOWS = ['dark', 'feudal', 'castle'] as const;
export type Win = (typeof WINDOWS)[number];
export const isWin = (w: string | null | undefined): w is Win => w === 'dark' || w === 'feudal' || w === 'castle';
export const NEXT: Record<Win, string> = { dark: 'Feudal', feudal: 'Castle', castle: 'Imperial' };
export const AGE: Record<Win, string> = { dark: 'Dark Age', feudal: 'Feudal Age', castle: 'Castle Age' };
export const AGE_SHORT: Record<Win, string> = { dark: 'Dark', feudal: 'Feudal', castle: 'Castle' };

export type Bucket = 'units' | 'production' | 'defense' | 'walls';
export const BUCKETS: [Bucket, string][] = [['units', 'Units'], ['production', 'Production'], ['defense', 'Defense'], ['walls', 'Walls']];

export const FLAG_TEXT: Record<string, string> = {
  next_age_not_reached: 'did not reach the next age, so the standard age-up cost is used',
  default_divisor: "the age-up bought wasn't found, so the standard age-up cost is used",
  age_time_from_build_order: 'the age-up time comes from the build order, not the game actions',
  unpriced_free_unit: 'a free unit with no price was counted at zero',
};

export interface Item { name: string; icon: string | null }

// Where an id would be found, by bucket: units are units, defenses are buildings or their upgrades.
const KINDS: Record<Bucket, string[]> = { units: ['unit'], production: ['building'], defense: ['building', 'technology'], walls: ['building'] };

function tidy(name: string): string { return name.replace(/\s*\n\s*/g, ' '); }
function fallbackName(id: string): string {
  const s = String(id || '').replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A counted thing by its data id and bucket: the game's name and its icon. */
export function item(bucket: Bucket, id: string): Item {
  for (const k of KINDS[bucket] ?? []) {
    const hit = ITEMS[k + ':' + id];
    if (hit) return { name: tidy(hit.name), icon: hit.icon ? '/icons/' + hit.icon : null };
  }
  return { name: fallbackName(id), icon: null };
}

/** An age-up from next_age_cost_source ("landmark:<id>" or "technology:<id>"), or null for the standard cost. */
export function ageUp(source: string | null | undefined): Item | null {
  const s = String(source || '');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const kind = s.slice(0, i) === 'landmark' ? 'building' : s.slice(0, i);
  const id = s.slice(i + 1);
  const hit = ITEMS[kind + ':' + id];
  if (hit) return { name: tidy(hit.name), icon: hit.icon ? '/icons/' + hit.icon : null };
  return { name: id.split('-').map((w, j) => (j > 0 && /^(of|the|and|to|de|d)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' '), icon: null };
}
