// The small marks every page uses: a ratio with its x, a civ's flag, a counted
// thing's icon, and a civ or item with its name.
import type { ReactNode } from 'react';
import { civName, flagUrl, type Item } from '../lib/game';
import { fx } from '../lib/format';
import s from './marks.module.css';

/** "1.6" with a quieter "x" after it; a dash when there's no value. */
export function Ratio({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v === null || v === undefined) return <span className={className}>—</span>;
  return <span className={className}>{fx(v)}<span className="x">x</span></span>;
}

/** A civ's flag. With `alone`, the flag stands in for the name and carries it as alt text. */
export function Flag({ civ, alone = false, size = 'sm' }: { civ: string | null | undefined; alone?: boolean; size?: 'sm' | 'md' }) {
  const src = flagUrl(civ);
  if (!src) return alone ? <span className={s.flagMissing}>{civName(civ)}</span> : null;
  return (
    <img className={s.flag + ' ' + (size === 'md' ? s.flagMd : '')} src={src} alt={alone ? civName(civ) : ''}
      title={alone ? civName(civ) : undefined} width={size === 'md' ? 26 : 21} height={size === 'md' ? 15 : 12} loading="lazy" decoding="async" />
  );
}

/** The flag, then the civ's name. */
export function Civ({ civ, children }: { civ: string | null | undefined; children?: ReactNode }) {
  return <span className={s.civ}><Flag civ={civ} /><span className={s.civName}>{children ?? civName(civ)}</span></span>;
}

/** A unit, building, technology or landmark icon on a dark tile; a blank tile when there's none. */
export function ItemIcon({ item, size = 20, title }: { item: Item; size?: number; title?: string }) {
  return (
    <span className={s.tile} style={{ width: size, height: size }} title={title ?? item.name}>
      {item.icon ? <img src={item.icon} alt="" width={size} height={size} loading="lazy" decoding="async" /> : null}
    </span>
  );
}

/** Icon then name, for tables of what was made. */
export function ItemName({ item }: { item: Item }) {
  return <span className={s.item}><ItemIcon item={item} /><span className={s.itemName}>{item.name}</span></span>;
}
