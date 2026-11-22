// Choosing civs, with flags. A native select can't show pictures, so this is
// a small listbox: a button that opens the list of civs, each with its flag.
// With `multiple`, presses tick civs on and off and the list stays open;
// "Any civ" clears them. Compact shows only flags on the button, for filter
// rows where width is tight; the list always shows flag and name.
// Keyboard: arrows, Home and End, a letter to jump, Enter or Space to choose,
// Escape to close.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { civName } from '../lib/game';
import { Flag } from './marks';
import s from './CivPicker.module.css';

export function CivPicker({ label, value, civs, onChange, compact = false, multiple = false, anyLabel = 'Any civ' }: {
  label: string; value: string[]; civs: string[]; onChange: (civs: string[]) => void;
  compact?: boolean; multiple?: boolean; anyLabel?: string;
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
  for (const v of value) if (!options.includes(v)) options.push(v);
  const chosen = new Set(value);
  const name = value.length ? value.map(civName).join(', ') : anyLabel;

  const close = (focusButton: boolean) => { setOpen(false); if (focusButton) button.current?.focus(); };
  const choose = (civ: string) => {
    if (!multiple) { onChange(civ ? [civ] : []); close(true); return; }
    if (!civ) { onChange([]); return; }
    onChange(chosen.has(civ) ? value.filter((c) => c !== civ) : [...value, civ]);
  };
  const openList = () => {
    const r = button.current?.getBoundingClientRect();
    // Open towards the side with room, so the list stays on screen.
    setAlignRight(!!r && r.left + 240 > window.innerWidth - 8);
    setActive(Math.max(0, value.length ? options.indexOf(value[0]!) : 0));
    setOpen(true);
  };

  // Close on a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Keep the active option in view and the list focused.
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

  // On the button: up to three flags, overlapping when there are several, then +n.
  const shown = value.slice(0, value.length > 3 ? 2 : 3);
  const mark = value.length === 0
    ? <span className={s.anyMark} aria-hidden="true">{compact ? 'Any' : ''}</span>
    : (
      <span className={s.flags + (value.length > 1 ? ' ' + s.stack : '')} aria-hidden="true">
        {shown.map((c) => <span key={c} className={s.flagIn}><Flag civ={c} size="md" /></span>)}
        {value.length > shown.length && <span className={s.more}>+{value.length - shown.length}</span>}
      </span>
    );

  return (
    <div className={s.wrap + (compact ? ' ' + s.compact : '')} ref={wrap}>
      <button ref={button} type="button" className={s.button} aria-haspopup="listbox" aria-expanded={open}
        aria-label={label + ': ' + name} title={compact ? label + ': ' + name : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); } }}>
        {mark}
        {!compact && <span className={s.name}>{name}</span>}
        <svg className={s.chev} viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul ref={list} className={s.list + (alignRight ? ' ' + s.right : '')} role="listbox" tabIndex={-1} aria-label={label}
          aria-multiselectable={multiple || undefined} aria-activedescendant={id + '-' + active} onKeyDown={onListKey}>
          {options.map((c, i) => {
            const on = c ? chosen.has(c) : value.length === 0;
            return (
              <li key={c || 'any'} id={id + '-' + i} role="option" aria-selected={on}
                className={(i === active ? s.active : '') + (on ? ' ' + s.chosen : '')}
                onPointerEnter={() => setActive(i)} onClick={() => choose(c)}>
                {multiple && <span className={s.box + (on ? ' ' + s.boxOn : '')} aria-hidden="true" />}
                {c ? <Flag civ={c} size="md" /> : <span className={s.anyMark} aria-hidden="true" />}
                <span className={s.optName}>{c ? civName(c) : anyLabel}</span>
              </li>
            );
          })}
          {multiple && (
            <li className={s.done} role="presentation">
              <button type="button" onClick={() => close(true)}>Done</button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
