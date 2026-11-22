// The pin mark and the pin button, after the league manager's Follow.
import type { MouseEvent } from 'react';
import { pinFrom, setPin, usePin } from '../lib/pin';
import s from './Pin.module.css';

export function PinIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={s.svg + (className ? ' ' + className : '')} aria-hidden="true" focusable="false">
      <path d="M10.5 1.5l4 4-2 1-2.5 2.5.5 3-1.5 1.5-3-3L2 14l-.5-.5 3.5-4-3-3L3.5 5l3 .5L9 3z"
        fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** Pin or unpin a person. Compact: the icon alone, for table rows. */
export function PinButton({ person, id, accounts, compact = false }: {
  person: string; id: number; accounts: { profileId: number }[]; compact?: boolean;
}) {
  const { pin } = usePin();
  const on = !!(pin && (pin.id === Number(id) || accounts.some((a) => pin.id === Number(a.profileId))));
  const click = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setPin(on ? null : pinFrom(person, id, accounts));
  };
  return (
    <button type="button" className={s.btn + (compact ? ' ' + s.compact : '')} aria-pressed={on} onClick={click}
      aria-label={on ? 'Unpin ' + person : 'Pin ' + person + ': Games opens on their games'}
      title={on ? 'Pinned. Press to unpin.' : 'Pin: Games opens on their games'}>
      <PinIcon filled={on} />
      {!compact && <span>{on ? 'Pinned' : 'Pin'}</span>}
    </button>
  );
}
