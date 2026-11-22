// A sortable column head: press to sort by it, press again to flip the order.
import type { ReactNode } from 'react';
import s from './SortTh.module.css';

export type Dir = 'asc' | 'desc';

export function SortTh({ id, sort, dir, onSort, children, align = 'right', colSpan, rowSpan, className, title }: {
  id: string; sort: string; dir: Dir; onSort: (id: string) => void; children: ReactNode;
  align?: 'left' | 'right'; colSpan?: number; rowSpan?: number; className?: string; title?: string;
}) {
  const on = sort === id;
  return (
    <th scope="col" colSpan={colSpan} rowSpan={rowSpan} className={(className ?? '') + ' ' + s.th + ' ' + (align === 'left' ? s.left : s.right)}
      aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={s.btn + (on ? ' ' + s.on : '')} onClick={() => onSort(id)} title={title}>
        {align === 'right' && <span className={s.arrow} aria-hidden="true">{on ? (dir === 'asc' ? '▲' : '▼') : ''}</span>}
        <span>{children}</span>
        {align === 'left' && <span className={s.arrow} aria-hidden="true">{on ? (dir === 'asc' ? '▲' : '▼') : ''}</span>}
      </button>
    </th>
  );
}
