// Choosing a civ, with flags. A native select can't show pictures, so this is
// a small listbox: a button that opens the list of civs, each with its flag.
// Compact shows only the flag on the button, for filter rows where width is
// tight; the list always shows flag and name. Keyboard: arrows, Home and End,
// a letter to jump, Enter to choose, Escape to close.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { civName } from '../lib/game';
import { Flag } from './marks';
import s from './CivPicker.module.css';

export function CivPicker({ label, value, civs, onChange, compact = false, anyLabel = 'Any civ' }: {
  label: string; value: string; civs: string[]; onChange: (civ: string) => void; compact?: boolean; anyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [alignRight, setAlignRight] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();

  const options = ['', ...civs.slice().sort((a, b) => civName(a).localeCompare(civName(b)))];
  if (value && !options.includes(value)) options.push(value);
  const name = value ? civName(value) : anyLabel;

  const close = (focusButton: boolean) => { setOpen(false); if (focusButton) button.current?.focus(); };
  const choose = (civ: string) => { onChange(civ); close(true); };
  const openList = () => {
    const r = button.current?.getBoundingClientRect();
    // Open towards the side with room, so the list stays on screen.
    setAlignRight(!!r && r.left + 240 > window.innerWidth - 8);
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };

  // Close on a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Keep the active option in view and focused.
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
    list.current?.focus();
  }, [open, active]);

  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(last, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active] ?? ''); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type a few letters to jump to a civ.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = options.findIndex((c) => c && civName(c).toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className={s.wrap + (compact ? ' ' + s.compact : '')} ref={wrap}>
      <button ref={button} type="button" className={s.button} aria-haspopup="listbox" aria-expanded={open}
        aria-label={label + ': ' + name} title={compact ? label + ': ' + name : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); } }}>
        {value ? <Flag civ={value} size="md" /> : <span className={s.anyMark} aria-hidden="true">{compact ? 'Any' : ''}</span>}
        {!compact && <span className={s.name}>{name}</span>}
        <svg className={s.chev} viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul ref={list} className={s.list + (alignRight ? ' ' + s.right : '')} role="listbox" tabIndex={-1} aria-label={label}
          aria-activedescendant={id + '-' + active} onKeyDown={onListKey}>
          {options.map((c, i) => (
            <li key={c || 'any'} id={id + '-' + i} role="option" aria-selected={c === value}
              className={(i === active ? s.active : '') + (c === value ? ' ' + s.chosen : '')}
              onPointerEnter={() => setActive(i)} onClick={() => choose(c)}>
              {c ? <Flag civ={c} size="md" /> : <span className={s.anyMark} aria-hidden="true" />}
              <span className={s.optName}>{c ? civName(c) : anyLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
