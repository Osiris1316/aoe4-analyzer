// Investment ratios page. Plain JS, no build step. Every value from the API is
// inserted with textContent, never as HTML (player names come from aoe4world).
//
// Each card is one player's age, with their opponent's same age beside it:
// collapsed, two aligned rows (ratio, name, bar, age-up time); expanded, a
// side-by-side table of what each of them made, by category.
//
// Three views, chosen by `view` in the address: Games (the cards; the default),
// Players (the tracked people and a search for anyone), and a player's profile
// (`view=player&p=<profile id>`: how they invest in each age, by civ, their
// record, then their games as cards). One player can be pinned in this browser,
// like following in the league manager: Games then opens on their games.
(function () {
  'use strict';

  var CIV = {
    abbasid_dynasty: 'Abbasid', ayyubids: 'Ayyubids', byzantines: 'Byzantines', chinese: 'Chinese',
    delhi_sultanate: 'Delhi', english: 'English', french: 'French', golden_horde: 'Golden Horde',
    holy_roman_empire: 'HRE', house_of_lancaster: 'Lancaster', japanese: 'Japanese', jeanne_darc: 'Jeanne',
    jin_dynasty: 'Jin', knights_templar: 'Templar', macedonian_dynasty: 'Macedonian', malians: 'Malians',
    mongols: 'Mongols', order_of_the_dragon: 'OotD', ottomans: 'Ottomans', rus: 'Rus', scots: 'Scots',
    sengoku_daimyo: 'Sengoku', tughlaq_dynasty: 'Tughlaq', vikings: 'Vikings', zhu_xis_legacy: 'Zhu Xi'
  };
  var NEXT = { dark: 'Feudal', feudal: 'Castle', castle: 'Imperial' };
  var AGE = { dark: 'Dark Age', feudal: 'Feudal Age', castle: 'Castle Age' };
  var BUCKETS = [['units', 'Units'], ['production', 'Production'], ['defense', 'Defense'], ['walls', 'Walls']];
  var FLAG = {
    next_age_not_reached: 'did not reach the next age, so the standard age-up cost is used',
    default_divisor: "the age-up bought wasn't found, so the standard age-up cost is used",
    age_time_from_build_order: 'the age-up time comes from the build order, not the game actions',
    unpriced_free_unit: 'a free unit with no price was counted at zero'
  };

  // g: the picked game and player on wide screens, "<game_id>.<profile_id>".
  // view: '' (games) | 'players' | 'player'; p: the profile shown with view=player.
  var state = { window: 'dark', group: 'all', civ: '', vs: '', q: '', reached: false, sort: 'combined', dir: 'desc', version: '', hm: 'combined', g: '', view: '', p: '' };
  var VIEWS = { '': 'games', players: 'players', player: 'player' };
  // Wide screens show the picked game on a board beside the list; phones open cards in place.
  var wide = window.matchMedia ? window.matchMedia('(min-width: 1100px)') : { matches: false };
  var rowsByKey = {};
  // The age path: a range per window, { metric, lo, hi } with ratios as decimals and hi exclusive (null = open).
  var ranges = { dark: null, feudal: null, castle: null };
  var WINDOW_ORDER = ['dark', 'feudal', 'castle'];
  var RATIO_NAME = { combined: 'combined', units: 'units', production: 'production', defense: 'defense', walls: 'walls' };
  var lastHist = null, lastScale = 1;
  var $ = function (id) { return document.getElementById(id); };

  // ── Formatting ───────────────────────────────────────────────────
  function civName(id) {
    if (!id) return '?';
    return CIV[id] || id.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function mmss(s) {
    s = Math.max(0, Math.round(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  // Ratios always with one decimal, so the decimal point lines up in every column.
  function fx(v) { return (Math.round((v || 0) * 10) / 10).toFixed(1); }
  // Range bounds: as few decimals as they need (0.25, 1.5, 2.0).
  function fxr(v) { var r = Math.round(v * 100) / 100; return r % 1 === 0 ? r.toFixed(1) : String(r); }
  function res(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  function day(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // A few data ids lost their accents or read oddly as words.
  var NAMES = { 'sk-ne-crossbowmen': 'Skåne crossbowmen', volur: 'Völur', 'kongens-d-r-cathedral': 'Kongens Dør Cathedral' };
  function title(id) {
    if (NAMES[id]) return NAMES[id];
    var s = String(id || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Landmark and technology names: every word capitalised, small words kept small.
  function properName(id) {
    if (NAMES[id]) return NAMES[id];
    return String(id || '').split('-').map(function (w, i) {
      return i > 0 && /^(of|the|and|to|de|d)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function parse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }
  // "6.1" with a quieter "x" after it.
  function xval(parent, v) {
    parent.appendChild(document.createTextNode(fx(v)));
    parent.appendChild(el('span', 'x', 'x'));
    return parent;
  }

  // ── One player's age, from a row or from its opp_* columns ───────
  function side(r, pre) {
    if (r[pre + 'ratio_combined'] === null || r[pre + 'ratio_combined'] === undefined) return null;
    var d = {
      combined: r[pre + 'ratio_combined'], units: r[pre + 'ratio_units'], production: r[pre + 'ratio_production'],
      defense: r[pre + 'ratio_defense'], walls: r[pre + 'ratio_walls'],
      start: r[pre + 'window_start_sec'], end: r[pre + 'window_end_sec'], reached: !!r[pre + 'reached_next_age'],
      cost: r[pre + 'next_age_cost'], costSource: String(r[pre + 'next_age_cost_source'] || ''),
      spend: (r[pre + 'spend_production'] || 0) + (r[pre + 'spend_units'] || 0) + (r[pre + 'spend_defense'] || 0),
      items: parse(r[pre + 'items_json'], []), flags: parse(r[pre + 'flags_json'], [])
    };
    return d;
  }
  function names(r) {
    return { a: r.person || r.player_name || '?', b: r.opp_person || r.opponent_name || '?' };
  }

  // ── State in the address (shareable links, back button) ──────────
  function readHash() {
    var h = new URLSearchParams(location.hash.slice(1));
    Object.keys(state).forEach(function (k) {
      if (!h.has(k)) return;
      state[k] = k === 'reached' ? h.get(k) === '1' : h.get(k);
    });
    if (!NEXT[state.window]) state.window = 'dark';
    // The view comes from the address alone: a link without one is the games view.
    state.view = VIEWS[h.get('view') || ''] ? (h.get('view') || '') : '';
    state.p = /^\d{1,12}$/.test(h.get('p') || '') ? h.get('p') : '';
    if (state.view === 'player' && !state.p) state.view = '';
    if (!RATIO_NAME[state.hm]) state.hm = 'combined';
    WINDOW_ORDER.forEach(function (w) {
      var raw = h.get('r_' + w);
      if (!raw) return;
      var parts = raw.split(':');
      var lo = Number(parts[1] || 0), hi = parts[2] === '' || parts[2] === undefined ? null : Number(parts[2]);
      if (RATIO_NAME[parts[0]] && isFinite(lo) && (hi === null || isFinite(hi))) ranges[w] = { metric: parts[0], lo: lo, hi: hi };
    });
  }
  function rangeParam(r) { return r.metric + ':' + r.lo + ':' + (r.hi === null ? '' : r.hi); }
  function rangeText(r) {
    var body = r.hi === null ? fxr(r.lo) + 'x and up' : r.lo === 0 ? 'under ' + fxr(r.hi) + 'x' : fxr(r.lo) + 'x to under ' + fxr(r.hi) + 'x';
    return RATIO_NAME[r.metric] + ' ' + body;
  }
  function writeHash() {
    var h = new URLSearchParams();
    Object.keys(state).forEach(function (k) {
      var v = state[k];
      if (k === 'reached') { if (v) h.set(k, '1'); }
      else if (v && !(k === 'window' && v === 'dark') && !(k === 'group' && v === 'all') && !(k === 'sort' && v === 'combined') && !(k === 'dir' && v === 'desc')) h.set(k, v);
    });
    if (h.get('hm') === 'combined') h.delete('hm');
    WINDOW_ORDER.forEach(function (w) { if (ranges[w]) h.set('r_' + w, rangeParam(ranges[w])); });
    var s = h.toString();
    try { history.replaceState(null, '', s ? '#' + s : location.pathname); } catch (e) { /* framed previews */ }
  }

  function syncControls() {
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-window') === state.window));
    });
    $('group').value = state.group; $('civ').value = state.civ; $('vs').value = state.vs;
    $('sort').value = state.sort; $('q').value = state.q; $('reached').checked = state.reached;
    var own = ranges[state.window];
    $('hm').value = own ? own.metric : state.hm;
    $('lo').value = own ? fxr(own.lo) : '';
    $('hi').value = own && own.hi !== null ? fxr(own.hi) : '';
    $('range-title').textContent = 'Narrow the ' + AGE[state.window] + ' to a range of';
    renderPath();
    $('dir').textContent = state.dir === 'desc' ? (state.sort === 'ageup' || state.sort === 'date' ? 'Latest first' : 'Highest first')
                                                : (state.sort === 'ageup' || state.sort === 'date' ? 'Earliest first' : 'Lowest first');
  }

  function fillSelect(sel, values, label) {
    var keep = sel.value;
    values.forEach(function (v) {
      var o = el('option', null, label(v)); o.value = v; sel.appendChild(o);
    });
    sel.value = keep;
  }

  // ── Collapsed card ───────────────────────────────────────────────
  function bar(d, scale) {
    var b = el('span', 'bar');
    b.style.setProperty('--scale', String(scale));
    var room = 100, label = [];
    [['u', d.units, 'units'], ['p', d.production, 'production'], ['d', d.defense, 'defense']].forEach(function (s) {
      var w = Math.min(room, Math.max(0, ((s[1] || 0) / scale) * 100));
      room -= w;
      if (w > 0) { var seg = el('span', 'seg ' + s[0]); seg.style.width = w + '%'; b.appendChild(seg); }
      if (s[1]) label.push(s[2] + ' ' + fx(s[1]) + 'x');
    });
    if ((d.combined || 0) > scale + 1e-9) { b.appendChild(el('span', 'over')); label.push('past the scale of ' + scale + 'x'); }
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', label.join(', ') || 'nothing military');
    return b;
  }

  function prow(cls, name, d, scale, win) {
    var row = el('div', 'prow ' + cls + (d ? '' : ' none'));
    var ratio = el('span', 'ratio');
    if (d) xval(ratio, d.combined); else ratio.textContent = '—';
    row.appendChild(ratio);
    row.appendChild(el('span', 'pname', name));
    if (d) row.appendChild(bar(d, scale));
    else row.appendChild(el('span', 'missing', 'did not reach the ' + AGE[win]));
    var t = el('span', 'time', d && d.reached ? mmss(d.end) : '—');
    t.title = d && d.reached ? 'Reached ' + NEXT[win] + ' at ' + mmss(d.end) : 'Did not reach ' + NEXT[win];
    row.appendChild(t);
    return row;
  }

  function card(r, scale) {
    var result = r.result === 'win' ? 'win' : r.result === 'loss' ? 'loss' : '';
    var li = el('li', 'card ' + result);
    li.setAttribute('data-g', r.game_id + '.' + r.profile_id);
    rowsByKey[r.game_id + '.' + r.profile_id] = r;
    var btn = el('button'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'false');
    var n = names(r), a = side(r, ''), b = side(r, 'opp_');

    var ctx = el('div', 'ctx');
    ctx.appendChild(el('span', 'res ' + result, result === 'win' ? 'W' : result === 'loss' ? 'L' : '·'));
    var what = el('span', 'what');
    what.appendChild(el('b', null, civName(r.civ)));
    what.appendChild(document.createTextNode(' vs '));
    what.appendChild(el('b', null, civName(r.opponent_civ)));
    what.appendChild(document.createTextNode(' · ' + (r.map || '?')));
    ctx.appendChild(what);
    if (r.player_group) ctx.appendChild(el('span', 'tag', r.player_group));
    ctx.appendChild(el('span', 'date', day(r.started_at)));
    btn.appendChild(ctx);

    var duel = el('div', 'duel');
    var rowA = prow('p1', n.a, a, scale, r.age_window), rowB = prow('p2', n.b, b, scale, r.age_window);
    markPinned(rowA.querySelector('.pname'), r.profile_id);
    markPinned(rowB.querySelector('.pname'), r.opponent_profile_id);
    duel.appendChild(rowA);
    duel.appendChild(rowB);
    btn.appendChild(duel);
    li.appendChild(btn);

    btn.addEventListener('click', function () {
      if (wide.matches) { pick(li, false); return; }
      var open = li.querySelector('.detail');
      if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
      li.appendChild(detail(r));
      btn.setAttribute('aria-expanded', 'true');
    });
    return li;
  }

  // ── Expanded card: what each player made, side by side ───────────
  function counts(d, bucket) {
    var m = {};
    (d ? d.items : []).forEach(function (i) {
      if (i.bucket !== bucket) return;
      var c = m[i.id] || (m[i.id] = { n: 0, spend: 0 });
      c.n += i.n; c.spend += i.n * i.cost;
    });
    return m;
  }
  function tr(cls, label, va, vb) {
    var row = el('tr', cls);
    row.appendChild(el('th', null, label));
    [va, vb].forEach(function (v) {
      var td = el('td');
      if (v === null || v === undefined || v === '') { td.textContent = '—'; td.className = 'zero'; }
      else if (typeof v === 'function') v(td);
      else td.textContent = String(v);
      row.appendChild(td);
    });
    return row;
  }
  function xcell(d, key) { return d ? function (td) { xval(td, d[key]); } : null; }

  function detail(r) {
    var box = el('div', 'detail');
    var n = names(r), a = side(r, ''), b = side(r, 'opp_'), win = r.age_window;
    var t = el('table', 'vs');
    var cg = el('colgroup'); cg.appendChild(el('col')); cg.appendChild(el('col', 'num')); cg.appendChild(el('col', 'num'));
    t.appendChild(cg);

    var head = el('thead');
    var who = el('tr', 'who'); who.appendChild(el('th'));
    var ha = el('th', 'p1', n.a), hb = el('th', 'p2', n.b);
    ha.title = n.a; hb.title = n.b;
    who.appendChild(ha); who.appendChild(hb); head.appendChild(who);
    var civ = el('tr', 'civ'); civ.appendChild(el('th'));
    civ.appendChild(el('td', null, civName(r.civ) + (r.player_group ? ' · ' + r.player_group : '')));
    civ.appendChild(el('td', null, civName(r.opponent_civ) + (r.opp_group ? ' · ' + r.opp_group : '')));
    head.appendChild(civ);
    t.appendChild(head);

    var facts = el('tbody', 'facts');
    function span(d) { return d ? mmss(d.start) + '–' + mmss(d.end) : null; }
    facts.appendChild(tr('facts', AGE[win], span(a), span(b)));
    facts.appendChild(tr('facts', NEXT[win] + ' cost', a ? res(a.cost) : null, b ? res(b.cost) : null));
    t.appendChild(facts);

    BUCKETS.forEach(function (bk) {
      var key = bk[0];
      var ca = counts(a, key), cb = counts(b, key);
      var ids = Object.keys(ca).concat(Object.keys(cb).filter(function (id) { return !ca[id]; }));
      if (key === 'walls' && !ids.length) return;
      var body = el('tbody');
      var head = tr('cat', bk[1], xcell(a, key), xcell(b, key));
      if (key === 'walls') head.firstChild.appendChild(el('span', 'note', 'not in the total'));
      body.appendChild(head);
      ids.sort(function (x, y) {
        var sx = (ca[x] ? ca[x].spend : 0) + (cb[x] ? cb[x].spend : 0), sy = (ca[y] ? ca[y].spend : 0) + (cb[y] ? cb[y].spend : 0);
        return sy - sx || (x < y ? -1 : 1);
      });
      ids.forEach(function (id) {
        body.appendChild(tr('item', title(id), ca[id] ? ca[id].n : null, cb[id] ? cb[id].n : null));
      });
      if (!ids.length) body.appendChild(tr('none', 'nothing', null, null));
      t.appendChild(body);
    });

    var tot = el('tbody');
    tot.appendChild(tr('total', 'Military', xcell(a, 'combined'), xcell(b, 'combined')));
    tot.appendChild(tr('spent', 'resources', a ? res(a.spend) : null, b ? res(b.spend) : null));
    t.appendChild(tot);
    box.appendChild(t);

    var notes = el('div', 'notes');
    [[n.a, a], [n.b, b]].forEach(function (p) {
      notes.appendChild(el('p', null, sentence(p[0], p[1], win)));
    });
    box.appendChild(notes);

    var link = el('a', null, 'Open the game on aoe4world');
    link.href = 'https://aoe4world.com/players/' + encodeURIComponent(r.profile_id) + '/games/' + encodeURIComponent(r.game_id);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    box.appendChild(link);
    var profiles = el('div', 'plinks');
    [[n.a, r.profile_id, 'p1'], [n.b, r.opponent_profile_id, 'p2']].forEach(function (x) {
      if (!x[1]) return;
      var a2 = el('a', x[2]); a2.href = profileHref(x[1]);
      a2.appendChild(el('span', 'nm', x[0]));
      a2.appendChild(document.createTextNode(' profile'));
      profiles.appendChild(a2);
    });
    box.appendChild(profiles);
    return box;
  }

  function sentence(name, d, win) {
    var next = NEXT[win];
    if (!d) return name + ' did not reach the ' + AGE[win] + '.';
    var src = d.costSource.indexOf(':') > 0 ? properName(d.costSource.split(':')[1]) : '';
    var s = name + (d.reached
      ? ' reached ' + next + ' at ' + mmss(d.end) + (src ? ' through ' + src : '') + ', costing ' + res(d.cost) + '.'
      : ' did not reach ' + next + '; this age runs to the end of the game at ' + mmss(d.end) + ', against the standard cost of ' + res(d.cost) + '.');
    var flags = d.flags.filter(function (f) { return f !== 'next_age_not_reached'; }).map(function (f) { return FLAG[f] || f; });
    if (flags.length) s += ' Note: ' + flags.join('; ') + '.';
    return s;
  }

  // ── Wide screens: pick a card, see the whole game on the board ───
  function pick(li, scroll) {
    var key = li.getAttribute('data-g');
    var r = rowsByKey[key];
    if (!r) return;
    state.g = key; writeHash();
    Array.prototype.forEach.call(document.querySelectorAll('.card.picked'), function (c) {
      c.classList.remove('picked'); c.firstChild.removeAttribute('aria-current');
    });
    li.classList.add('picked'); li.firstChild.setAttribute('aria-current', 'true');
    if (scroll) li.scrollIntoView({ block: 'nearest' });
    loadBoard(r.game_id, r.profile_id);
  }
  // After the list loads: keep the picked game if it's still listed, else take the first.
  function autoPick() {
    if (!wide.matches) return;
    var list = $('list');
    var li = (state.g && list.querySelector('[data-g="' + state.g.replace(/[^0-9.]/g, '') + '"]')) || list.firstElementChild;
    if (li) pick(li, false);
    else { var b = $('board'); b.textContent = ''; b.appendChild(el('p', 'board-empty', 'No games in this list.')); }
  }
  function step(dir) {
    var cur = document.querySelector('.card.picked');
    var next = cur ? (dir > 0 ? cur.nextElementSibling : cur.previousElementSibling) : $('list').firstElementChild;
    if (next) pick(next, true);
  }

  var gameCache = {}, boardSeq = 0;
  function loadBoard(gameId, profileId) {
    var my = ++boardSeq;
    var key = gameId + '|' + (state.version || '');
    var got = gameCache[key] ? Promise.resolve(gameCache[key]) :
      fetch('/api/game?id=' + encodeURIComponent(gameId) + (state.version ? '&version=' + encodeURIComponent(state.version) : ''))
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (d) { gameCache[key] = d; return d; });
    got.then(function (d) { if (my === boardSeq) renderBoard(d, profileId); })
      .catch(function (err) {
        if (my !== boardSeq) return;
        var b = $('board'); b.textContent = '';
        b.appendChild(el('p', 'board-empty', 'Could not load the game (' + err.message + ').'));
      });
  }

  // The two players of a game, each with their rows by age window.
  function playersOf(d, profileId) {
    var by = {};
    (d.rows || []).forEach(function (r) {
      var p = by[r.profile_id] || (by[r.profile_id] = {
        id: r.profile_id, name: r.person || r.player_name || '?', civ: r.civ, group: r.player_group, result: r.result,
        opp: { id: r.opponent_profile_id, name: r.opponent_name, civ: r.opponent_civ }, w: {}, any: r
      });
      p.w[r.age_window] = r;
    });
    var me = by[profileId];
    if (!me) return null;
    var them = by[me.opp.id] || { id: me.opp.id, name: me.opp.name || '?', civ: me.opp.civ, group: null, result: me.result === 'win' ? 'loss' : me.result === 'loss' ? 'win' : '', w: {} };
    return { me: me, them: them };
  }

  function boardLabel(p, role, cls) {
    var lab = el('div', 'blabel');
    lab.appendChild(el('span', 't', role));
    var n = el('a', 'n ' + cls, p.name); n.title = p.name + ': open their profile';
    if (p.id) n.href = profileHref(p.id);
    markPinned(n, p.id);
    lab.appendChild(n);
    lab.appendChild(el('span', 's', civName(p.civ) + (p.group ? ' · ' + p.group : '')));
    if (p.result === 'win' || p.result === 'loss') lab.appendChild(el('span', 's ' + p.result, p.result === 'win' ? 'Won' : 'Lost'));
    return lab;
  }

  function playerCell(p, w, cls, scale) {
    var c = el('div', 'bcell ' + cls + (state.window === w ? ' now' : ''));
    var r = p.w[w];
    if (!r) { c.appendChild(el('p', 'gone', 'Did not reach the ' + AGE[w] + '.')); return c; }
    var d = side(r, '');
    var top = el('div', 'bc-top');
    top.appendChild(xval(el('span', 'ratio'), d.combined));
    var span = el('span', 'bc-span', mmss(d.start) + '–' + mmss(d.end));
    span.title = d.reached ? 'Reached ' + NEXT[w] + ' at ' + mmss(d.end) : 'Did not reach ' + NEXT[w] + '; the age runs to the end of the game';
    if (!d.reached) span.textContent += ' end';
    top.appendChild(span);
    c.appendChild(top);
    c.appendChild(bar(d, scale));

    var t = el('table', 'made');
    var cg = el('colgroup'); cg.appendChild(el('col', 'n')); cg.appendChild(el('col')); cg.appendChild(el('col', 'v'));
    t.appendChild(cg);
    BUCKETS.forEach(function (bk) {
      var key = bk[0], m = counts(d, key);
      var ids = Object.keys(m).sort(function (x, y) { return m[y].spend - m[x].spend || (x < y ? -1 : 1); });
      if (key === 'walls' && !ids.length) return;
      var body = el('tbody');
      var head = el('tr', 'cat');
      var th = el('th', null, bk[1]); th.colSpan = 2;
      if (key === 'walls') th.appendChild(el('span', 'note', 'apart'));
      head.appendChild(th);
      head.appendChild(xval(el('td'), d[key]));
      body.appendChild(head);
      ids.forEach(function (id) {
        var row = el('tr');
        row.appendChild(el('td', 'n', m[id].n));
        var name = el('td', 'name', title(id)); name.colSpan = 2; name.title = title(id);
        row.appendChild(name);
        body.appendChild(row);
      });
      t.appendChild(body);
    });
    var tot = el('tbody'), spent = el('tr', 'spent');
    var cell = el('td', null, res(d.spend) + ' on military, against ' + res(d.cost) + ' for ' + NEXT[w]);
    cell.colSpan = 3;
    spent.appendChild(cell); tot.appendChild(spent); t.appendChild(tot);
    c.appendChild(t);
    return c;
  }

  // Where they meet: who invested more in this age, and who aged up first.
  function meetCell(P, w) {
    var c = el('div', 'bcell' + (state.window === w ? ' now' : ''));
    var a = P.me.w[w] ? side(P.me.w[w], '') : null, b = P.them.w[w] ? side(P.them.w[w], '') : null;
    function line(parts) {
      var p = el('p');
      parts.forEach(function (x) { p.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      c.appendChild(p);
    }
    var who = function (P2, cls) { return el('span', cls, P2.name); };
    if (!a && !b) { line(['Neither reached the ' + AGE[w] + '.']); return c; }
    if (!a || !b) { line([who(a ? P.them : P.me, a ? 'p2' : 'p1'), ' did not reach the ' + AGE[w] + '.']); return c; }
    var diff = a.combined - b.combined;
    if (Math.abs(diff) < 0.05) line(['Even, about ', el('span', 'mono', fx(a.combined) + 'x'), ' each.']);
    else line([who(diff > 0 ? P.me : P.them, diff > 0 ? 'p1' : 'p2'), ' invested ', el('span', 'mono', fx(Math.abs(diff)) + 'x'), ' more.']);
    if (a.reached && b.reached) {
      var dt = a.end - b.end;
      if (Math.abs(dt) < 5) line(['They reached ' + NEXT[w] + ' together.']);
      else line([who(dt < 0 ? P.me : P.them, dt < 0 ? 'p1' : 'p2'), ' reached ' + NEXT[w] + ' ', el('span', 'mono', mmss(Math.abs(dt))), ' sooner.']);
    } else if (a.reached || b.reached) {
      line([who(a.reached ? P.me : P.them, a.reached ? 'p1' : 'p2'), ' reached ' + NEXT[w] + '; the other never did.']);
    } else {
      line(['Neither reached ' + NEXT[w] + '.']);
    }
    return c;
  }

  function renderBoard(d, profileId) {
    var box = $('board');
    box.textContent = '';
    var P = playersOf(d, profileId);
    if (!P) { box.appendChild(el('p', 'board-empty', 'This game has no rows for that player.')); return; }
    var any = P.me.any, scales = d.scales || {};

    var head = el('div', 'bh');
    var left = el('div');
    var h = el('h2', 'bh-title');
    h.appendChild(el('span', 'p1', P.me.name));
    h.appendChild(el('span', 'vs', 'vs'));
    h.appendChild(el('span', 'p2', P.them.name));
    left.appendChild(h);
    var sub = el('p', 'bh-sub');
    sub.appendChild(document.createTextNode(civName(P.me.civ) + ' vs ' + civName(P.them.civ) + ' · ' + (any.map || '?') + ' · ' + day(any.started_at) + ' · '));
    sub.appendChild(el('span', 'mono', mmss(any.duration_sec)));
    sub.appendChild(document.createTextNode(' long · ' + (P.me.result === 'win' ? P.me.name + ' won' : P.me.result === 'loss' ? P.them.name + ' won' : 'result unknown')));
    left.appendChild(sub);
    head.appendChild(left);
    var link = el('a', null, 'Open on aoe4world');
    link.href = 'https://aoe4world.com/players/' + encodeURIComponent(P.me.id) + '/games/' + encodeURIComponent(d.game_id);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    head.appendChild(link);
    box.appendChild(head);

    var heads = el('div', 'brow bheads');
    heads.appendChild(el('span'));
    WINDOW_ORDER.forEach(function (w) {
      heads.appendChild(el('span', state.window === w ? 'now' : '', AGE[w].replace(' Age', '') + ' → ' + NEXT[w]));
    });
    box.appendChild(heads);

    function lane(cls, label, cells) {
      var l = el('div', 'blane ' + cls);
      var row = el('div', 'brow');
      row.appendChild(label);
      cells.forEach(function (x) { row.appendChild(x); });
      l.appendChild(row);
      return l;
    }
    box.appendChild(lane('side theirs', boardLabel(P.them, 'Opponent', 'p2'),
      WINDOW_ORDER.map(function (w) { return playerCell(P.them, w, 'p2', scales[w] || 1); })));
    var ml = el('div', 'blabel'); ml.appendChild(el('span', 't', 'Where they meet'));
    box.appendChild(lane('meet', ml, WINDOW_ORDER.map(function (w) { return meetCell(P, w); })));
    box.appendChild(lane('side mine', boardLabel(P.me, 'Player', 'p1'),
      WINDOW_ORDER.map(function (w) { return playerCell(P.me, w, 'p1', scales[w] || 1); })));
  }

  // ── The age path ─────────────────────────────────────────────────
  function earlier(w) { return WINDOW_ORDER.slice(0, WINDOW_ORDER.indexOf(w)); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function statusText(data, shown) {
    var total = data.total || 0, inPath = data.inPath || 0;
    var pathOn = earlier(state.window).some(function (w) { return ranges[w]; });
    var own = ranges[state.window];
    if (!inPath) return pathOn ? 'None of the player-games in your path reached the ' + AGE[state.window] + '.' : 'No games match these filters yet.';
    var parts = [];
    if (pathOn) parts.push(plural(inPath, 'player-game') + ' in your path reached the ' + AGE[state.window]);
    else parts.push(plural(inPath, 'player-game'));
    if (own) parts.push(total + ' in the chosen range');
    var text = parts.join(', ') + '.';
    if (shown < total) text += ' Showing the first ' + shown + '.';
    return text + (shown ? ' Tap one to see what both players made.' : '');
  }

  function renderPath() {
    var box = $('path');
    box.textContent = '';
    var steps = earlier(state.window).filter(function (w) { return ranges[w]; });
    box.hidden = steps.length === 0;
    if (!steps.length) return;
    box.appendChild(el('span', null, 'Path:'));
    steps.forEach(function (w) {
      var chip = el('span', 'chip');
      var label = el('span');
      label.appendChild(el('b', null, AGE[w] + ' '));
      label.appendChild(document.createTextNode(rangeText(ranges[w])));
      chip.appendChild(label);
      var x = el('button', 'x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove the ' + AGE[w] + ' range');
      x.addEventListener('click', function () { ranges[w] = null; load(); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  // Buckets 0..N of the width the API chose for this age; the last holds N widths and up.
  function bucketRange(b) {
    var w = lastHist.bucketWidth, N = lastHist.buckets;
    return { lo: Math.round(b * w * 100) / 100, hi: b === N ? null : Math.round((b + 1) * w * 100) / 100 };
  }

  function renderHist() {
    var box = $('hist'), axis = $('hist-axis');
    box.textContent = ''; axis.textContent = '';
    if (!lastHist) return;
    var N = lastHist.buckets, w = lastHist.bucketWidth;
    var counts = [];
    for (var i = 0; i <= N; i++) counts.push(0);
    (lastHist.counts || []).forEach(function (c) { if (c.b >= 0 && c.b <= N) counts[c.b] += c.n; });
    var max = Math.max.apply(null, counts.concat([1]));
    var own = ranges[state.window];
    counts.forEach(function (n, b) {
      var rg = bucketRange(b);
      var on = own && rg.lo >= own.lo - 1e-9 && (own.hi === null || rg.lo < own.hi - 1e-9);
      var btn = el('button', on ? 'on' : '');
      btn.type = 'button';
      btn.setAttribute('aria-label', (rg.hi === null ? fxr(rg.lo) + 'x and up' : fxr(rg.lo) + 'x to ' + fxr(rg.hi) + 'x') + ': ' + plural(n, 'player-game'));
      var fill = el('span');
      fill.style.height = (n ? Math.max(4, (n / max) * 100) : 0) + '%';
      btn.appendChild(fill);
      btn.addEventListener('click', function () { tapBucket(rg.lo, rg.hi); });
      box.appendChild(btn);
    });
    // Labels at whole age-ups, under the left edge of their bucket.
    var top = Math.round(N * w), stepX = top <= 6 ? 1 : 2;
    for (var k = 0; k <= top; k += stepX) {
      var lab = el('span', null, k === top ? k + 'x+' : k + 'x');
      lab.style.left = ((k / w) / (N + 1)) * 100 + '%';
      axis.appendChild(lab);
    }
  }

  // Tap a bar to choose it; tap another to stretch the range to it; tap a lone chosen bar to clear.
  function tapBucket(lo, hi) {
    var w = state.window, own = ranges[w], metric = $('hm').value;
    if (!own || own.metric !== metric) ranges[w] = { metric: metric, lo: lo, hi: hi };
    else if (own.lo === lo && own.hi === hi) ranges[w] = null;
    else ranges[w] = { metric: metric, lo: Math.min(own.lo, lo), hi: own.hi === null || hi === null ? null : Math.max(own.hi, hi) };
    load();
  }

  function applyInputs() {
    var loV = $('lo').value.trim(), hiV = $('hi').value.trim();
    if (loV === '' && hiV === '') { ranges[state.window] = null; load(); return; }
    var lo = Math.max(0, Number(loV || 0)), hi = hiV === '' ? null : Number(hiV);
    if (!isFinite(lo) || (hi !== null && (!isFinite(hi) || hi <= lo))) { $('status').textContent = 'The range needs a "to" value above its "from" value.'; return; }
    ranges[state.window] = { metric: $('hm').value, lo: lo, hi: hi };
    load();
  }

  // ── Pinning: one player per browser, like following in the league manager ──
  // { id, person, ids: [profile ids of their accounts] }. With a pin, Games opens on
  // their games (the choice of "Everyone" instead is remembered too).
  var PIN_KEY = 'aoe4inv.pinned', ALL_KEY = 'aoe4inv.everyone';
  function readPin() {
    try {
      var v = JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
      return v && v.id && v.ids && v.ids.length ? v : null;
    } catch (e) { return null; }
  }
  function readFlag(k) { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } }
  function writeFlag(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch (e) { /* storage off: this visit only */ } }
  var pinned = readPin(), preferAll = readFlag(ALL_KEY);

  function setPin(p) {
    pinned = p;
    try { if (p) localStorage.setItem(PIN_KEY, JSON.stringify(p)); else localStorage.removeItem(PIN_KEY); } catch (e) { /* this visit only */ }
    if (p) { preferAll = false; writeFlag(ALL_KEY, false); }
    renderChip();
  }
  function isPinnedId(id) { return !!(pinned && id && pinned.ids.indexOf(Number(id)) !== -1); }
  function pinFrom(person, id, accounts) {
    return { id: Number(id), person: person, ids: accounts.map(function (a) { return Number(a.profileId); }) };
  }

  // The accounts the game list is narrowed to: the profile's person, or the pinned player.
  var profileIds = null;
  function listPlayers() {
    if (state.view === 'player') return profileIds || [Number(state.p)];
    if (state.view === '' && pinned && !preferAll) return pinned.ids;
    return null;
  }
  // A small pin after a name, where the list isn't already only that player.
  function markPinned(node, id) {
    if (!node || !isPinnedId(id)) return;
    var only = listPlayers();
    if (only && only.indexOf(Number(id)) !== -1) return;
    node.classList.add('pinned');
    node.insertBefore(pinIcon(true), node.firstChild);
    node.setAttribute('title', (node.getAttribute('title') || node.textContent) + ' (pinned)');
  }

  function pinIcon(filled) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'pin-svg');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M10.5 1.5l4 4-2 1-2.5 2.5.5 3-1.5 1.5-3-3L2 14l-.5-.5 3.5-4-3-3L3.5 5l3 .5L9 3z');
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.3'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }
  function initials(name) {
    var w = String(name || '?').replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
    var s = w.length > 1 ? w[0].charAt(0) + w[1].charAt(0) : (w[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  // The chip in the head: the pinned player, or an invitation to pin one.
  function renderChip() {
    var c = $('pin-chip');
    c.textContent = '';
    if (!pinned) {
      c.className = 'pin-chip empty';
      c.href = '#view=players';
      c.appendChild(pinIcon(false));
      c.appendChild(el('span', 'nm', 'Pin a player'));
      c.setAttribute('aria-label', 'Pin a player: open the player list');
      return;
    }
    c.className = 'pin-chip';
    c.href = profileHref(pinned.id);
    c.appendChild(el('span', 'av', initials(pinned.person)));
    c.appendChild(el('span', 'nm', pinned.person));
    c.setAttribute('aria-label', 'Pinned: ' + pinned.person + '. Open their profile.');
  }
  // Games view with a pin: their games or everyone's.
  function syncWho() {
    var box = $('who-switch'), show = state.view === '' && !!pinned;
    box.hidden = !show;
    $('shell').classList.toggle('one-player', !!listPlayers());
    if (!show) return;
    $('who-name').textContent = pinned.person;
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String((b.getAttribute('data-who') === 'all') === preferAll));
    });
  }
  function pinButton(person, id, accounts, compact) {
    var b = el('button', 'pin-btn' + (compact ? ' compact' : ''));
    b.type = 'button';
    function paint() {
      var on = !!(pinned && pinned.id === Number(id));
      b.textContent = '';
      b.appendChild(pinIcon(on));
      if (!compact) b.appendChild(el('span', null, on ? 'Pinned' : 'Pin'));
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Unpin ' + person : 'Pin ' + person + ': Games opens on their games');
      b.title = on ? 'Pinned. Press to unpin.' : 'Pin: Games opens on their games';
    }
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      setPin(pinned && pinned.id === Number(id) ? null : pinFrom(person, id, accounts));
      if (state.view === 'players' && playersData) renderPlayers(); else paint();
    });
    paint();
    return b;
  }

  // ── Views ────────────────────────────────────────────────────────
  function profileHref(id) { return '#view=player&p=' + encodeURIComponent(id); }
  function ok(res) { if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } return res.json(); }
  function monthYear(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  function pctText(w, n) { return n ? Math.round((w / n) * 100) + '%' : '—'; }
  function record(w, l) { return w + '–' + l; }

  function render() {
    var v = VIEWS[state.view] || 'games';
    $('shell').className = 'shell view-' + v;
    Array.prototype.forEach.call($('views').querySelectorAll('a'), function (a) {
      var on = a.getAttribute('data-view') === (v === 'player' ? 'players' : v);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('players').hidden = v !== 'players';
    $('profile').hidden = v !== 'player';
    $('games-title').hidden = v !== 'player';
    if (v === 'players') { writeHash(); syncWho(); loadPlayers(); window.scrollTo(0, 0); return; }
    if (v === 'player') { loadProfile(); window.scrollTo(0, 0); return; }
    profileIds = null;
    load();
  }

  // ── Players view ─────────────────────────────────────────────────
  var playersData = null, playersSeq = 0;
  function loadPlayers() {
    var my = ++playersSeq;
    if (!playersData) $('pl-note').textContent = 'Loading…';
    fetch('/api/players' + (state.version ? '?version=' + encodeURIComponent(state.version) : '')).then(ok).then(function (d) {
      if (my !== playersSeq) return;
      playersData = d;
      renderPlayers();
    }).catch(function (err) {
      if (my !== playersSeq) return;
      $('pl-note').textContent = 'Could not load the players (' + err.message + ').';
    });
  }

  function renderPlayers() {
    var people = (playersData.people || []).slice();
    // The pinned player first, then most recently played.
    people.sort(function (a, b) { return (pinned && b.id === pinned.id ? 1 : 0) - (pinned && a.id === pinned.id ? 1 : 0); });
    var accounts = people.reduce(function (n, p) { return n + p.accounts.length; }, 0);
    $('pl-note').textContent = people.length + (people.length === 1 ? ' tracked person' : ' tracked people') +
      (accounts > people.length ? ' on ' + accounts + ' accounts' : '') +
      '. Each card shows their median military in each age and, beside it, the usual time they reached the next age.' +
      ' Open one for their profile; pin one and Games opens on their games.';
    var list = $('pl-list');
    list.textContent = '';
    people.forEach(function (p) { list.appendChild(playerCard(p)); });
  }

  // Their typical age, per window: median military and the median time they reached the next age.
  function fingerprint(t) {
    var g = el('div', 'fp');
    WINDOW_ORDER.forEach(function (w) {
      var c = t ? t[w] : null;
      var col = el('div', 'fp-col');
      col.appendChild(el('span', 'fp-l', AGE[w].replace(' Age', '')));
      var v = el('span', 'fp-v');
      if (c && c.combined !== null) xval(v, c.combined); else v.textContent = '—';
      v.title = c && c.combined !== null ? 'Median military in the ' + AGE[w] + ': ' + fx(c.combined) + 'x' : 'No games in the ' + AGE[w];
      col.appendChild(v);
      var tm = el('span', 'fp-t', c && c.ageUp !== null ? mmss(c.ageUp) : '—');
      tm.title = c && c.ageUp !== null ? 'Median time they reached ' + NEXT[w] + ': ' + mmss(c.ageUp) : 'Rarely or never reached ' + NEXT[w];
      col.appendChild(tm);
      g.appendChild(col);
    });
    return g;
  }

  function backfillLine(b, full) {
    if (!b) return null;
    var done = b.fetched, gone = b.unavailable + b.parked;
    if (!full && b.waiting === 0) return null;
    var box = el('div', 'bf' + (b.waiting ? ' going' : ''));
    var t = el('p');
    if (b.waiting) {
      t.appendChild(document.createTextNode('Backfill: '));
      t.appendChild(el('span', 'mono', String(done)));
      t.appendChild(document.createTextNode(' of '));
      t.appendChild(el('span', 'mono', String(b.queued)));
      t.appendChild(document.createTextNode(' fetched, ' + b.waiting + ' waiting' + (gone ? ', ' + gone + ' unavailable' : '') + '.'));
    } else {
      t.appendChild(document.createTextNode('Backfill of ' + b.months + ' months done: '));
      t.appendChild(el('span', 'mono', String(done)));
      t.appendChild(document.createTextNode(' games fetched' + (gone ? ', ' + gone + " that aoe4world couldn't give" : '') + '.'));
    }
    box.appendChild(t);
    if (b.waiting && b.queued) {
      var track = el('span', 'bf-track'), fill = el('span', 'bf-fill');
      fill.style.width = Math.round(((done + gone) / b.queued) * 100) + '%';
      track.appendChild(fill);
      track.setAttribute('role', 'img');
      track.setAttribute('aria-label', Math.round(((done + gone) / b.queued) * 100) + '% through the backfill');
      box.appendChild(track);
    }
    return box;
  }

  function playerCard(p) {
    var on = !!(pinned && pinned.id === p.id);
    var li = el('li', 'pcard' + (on ? ' pinned' : ''));
    var a = el('a', 'pc-main');
    a.href = profileHref(p.id);
    var top = el('div', 'pc-top');
    top.appendChild(el('span', 'pc-name', p.person));
    if (p.group) top.appendChild(el('span', 'tag', p.group));
    if (!p.following) { var pz = el('span', 'tag quiet', 'paused'); pz.title = 'The harvest no longer looks for their new games'; top.appendChild(pz); }
    top.appendChild(el('span', 'pc-last', p.lastGame ? day(p.lastGame) : ''));
    a.appendChild(top);

    var sub = el('p', 'pc-sub');
    if (p.games) {
      sub.appendChild(el('span', 'mono', record(p.wins, p.losses)));
      sub.appendChild(document.createTextNode(' · ' + plural(p.games, 'game')));
    } else {
      sub.appendChild(document.createTextNode('No analysed games yet'));
    }
    var alts = p.accounts.filter(function (x) { return x.name && x.name !== p.person; }).map(function (x) { return x.name; });
    if (p.accounts.length > 1) sub.appendChild(document.createTextNode(' · ' + p.accounts.length + ' accounts'));
    else if (alts.length) sub.appendChild(document.createTextNode(' · ' + alts[0]));
    a.appendChild(sub);

    if (p.games) a.appendChild(fingerprint(p.typical));
    if (p.civs && p.civs.length) {
      a.appendChild(el('p', 'pc-civs', p.civs.slice(0, 3).map(function (c) { return civName(c.civ) + ' ' + c.games; }).join(' · ')));
    }
    var bf = backfillLine(p.backfill, false);
    if (bf) a.appendChild(bf);
    li.appendChild(a);
    li.appendChild(pinButton(p.person, p.id, p.accounts, true));
    return li;
  }

  var findSeq = 0;
  function findPlayers(q) {
    var box = $('pl-found'), my = ++findSeq;
    if (q.length < 2) { box.hidden = true; box.textContent = ''; return; }
    fetch('/api/players?q=' + encodeURIComponent(q) + (state.version ? '&version=' + encodeURIComponent(state.version) : '')).then(ok).then(function (d) {
      if (my !== findSeq) return;
      box.textContent = '';
      box.hidden = false;
      var m = d.matches || [];
      if (!m.length) { box.appendChild(el('li', 'none', 'Nobody by that name in the analysed games.')); return; }
      m.forEach(function (x) {
        var li = el('li'), a = el('a');
        a.href = profileHref(x.profileId);
        a.appendChild(el('span', 'nm', x.name || String(x.profileId)));
        a.appendChild(el('span', x.group ? 'tag' : 'tag-none', x.group || ''));
        a.appendChild(el('span', 'mono n', plural(x.games, 'game')));
        a.appendChild(el('span', 'mono d', day(x.lastGame)));
        li.appendChild(a);
        box.appendChild(li);
      });
    }).catch(function () { if (my === findSeq) { box.hidden = false; box.textContent = ''; box.appendChild(el('li', 'none', "The search didn't work. Try again in a moment.")); } });
  }

  // ── Profile ──────────────────────────────────────────────────────
  var profileSeq = 0, profileData = null;
  function loadProfile() {
    var my = ++profileSeq, id = state.p, box = $('profile');
    if (!profileData || String(profileData.id) !== id) {
      profileIds = null;
      box.textContent = '';
      box.appendChild(el('p', 'prof-wait', 'Loading the profile…'));
    }
    fetch('/api/player?id=' + encodeURIComponent(id) + (state.version ? '&version=' + encodeURIComponent(state.version) : '')).then(ok).then(function (d) {
      if (my !== profileSeq) return;
      profileData = d;
      profileIds = (d.accounts || []).map(function (a) { return Number(a.profileId); });
      // Keep a pin's accounts current (an alt added later).
      if (pinned && profileIds.indexOf(pinned.id) !== -1 && d.person) {
        pinned = pinFrom(d.person, pinned.id, d.accounts);
        try { localStorage.setItem(PIN_KEY, JSON.stringify(pinned)); } catch (e) { /* this visit only */ }
        renderChip();
      }
      renderProfile(d);
      load();
    }).catch(function (err) {
      if (my !== profileSeq) return;
      profileData = null; profileIds = [Number(id)];
      box.textContent = '';
      box.appendChild(el('p', 'prof-wait', err.status === 404
        ? 'No analysed games for this player yet. If a backfill is running, check back after the next harvest.'
        : 'Could not load the profile (' + err.message + ').'));
      load();
    });
  }

  function strip(sp, scale) {
    var s = el('span', 'strip');
    s.style.setProperty('--scale', String(scale));
    if (!sp || sp.median === null) return s;
    var pos = function (v) { return Math.min(100, Math.max(0, (v / scale) * 100)); };
    function band(cls, lo, hi) {
      var b = el('span', cls);
      b.style.left = pos(lo) + '%';
      b.style.width = Math.max(0.6, pos(hi) - pos(lo)) + '%';
      s.appendChild(b);
    }
    band('s-out', sp.p10, sp.p90);
    band('s-mid', sp.p25, sp.p75);
    var m = el('span', 's-med'); m.style.left = pos(sp.median) + '%'; s.appendChild(m);
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', 'Middle half ' + fx(sp.p25) + 'x to ' + fx(sp.p75) + 'x; most games ' + fx(sp.p10) + 'x to ' + fx(sp.p90) + 'x; median ' + fx(sp.median) + 'x');
    return s;
  }

  function mixTable(ws) {
    var t = el('table', 'mix');
    [['units', 'Units', 'Units'], ['production', 'Production', 'Prod.'], ['defense', 'Defense', 'Def.']].forEach(function (k) {
      var row = el('tr');
      var th = el('th');
      th.appendChild(el('span', 'l-long', k[1]));
      th.appendChild(el('span', 'l-short', k[2]));
      row.appendChild(th);
      row.appendChild(xval(el('td'), ws[k[0]]));
      t.appendChild(row);
    });
    return t;
  }

  // The profile's age columns follow the age tab.
  function markNow() {
    Array.prototype.forEach.call($('profile').querySelectorAll('[data-w]'), function (n) {
      n.classList.toggle('now', n.getAttribute('data-w') === state.window);
    });
  }

  function renderProfile(d) {
    var box = $('profile');
    box.textContent = '';
    $('games-title').textContent = (d.person || d.name || 'Their') + (d.person || d.name ? "'s games" : ' games');

    // Who
    var head = el('div', 'ph');
    var main = el('div', 'ph-main');
    var crumb = el('p', 'ph-crumb'); var back = el('a', null, 'Players'); back.href = '#view=players';
    crumb.appendChild(back); crumb.appendChild(document.createTextNode(' /'));
    main.appendChild(crumb);
    var h = el('h2', 'ph-name');
    h.appendChild(el('span', 'nm', d.person || d.name || String(d.id)));
    if (d.group) h.appendChild(el('span', 'tag', d.group));
    if (d.tracked && !d.following) h.appendChild(el('span', 'tag quiet', 'paused'));
    if (!d.tracked) h.appendChild(el('span', 'tag quiet', 'not tracked'));
    main.appendChild(h);
    var named = (d.accounts || []).map(function (a) { return a.name; }).filter(Boolean);
    if (d.accounts.length > 1) main.appendChild(el('p', 'ph-acc', 'Plays as ' + named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1] + '.'));
    else if (named[0] && named[0] !== d.person) main.appendChild(el('p', 'ph-acc', 'On aoe4world as ' + named[0] + '.'));
    var rec = el('p', 'ph-rec');
    if (d.games) {
      rec.appendChild(el('span', 'mono', record(d.wins, d.losses)));
      rec.appendChild(document.createTextNode(' · ' + pctText(d.wins, d.games) + ' won · ' + plural(d.games, 'game') + ' analysed · ' +
        (monthYear(d.firstGame) === monthYear(d.lastGame) ? monthYear(d.lastGame) : monthYear(d.firstGame) + ' to ' + monthYear(d.lastGame))));
    } else rec.textContent = 'No analysed games yet.';
    main.appendChild(rec);
    head.appendChild(main);
    var act = el('div', 'ph-act');
    if (d.games || d.tracked) act.appendChild(pinButton(d.person || d.name || String(d.id), d.accounts[0] ? d.accounts[0].profileId : d.id, d.accounts, false));
    (d.accounts || []).slice(0, 3).forEach(function (a, i) {
      var l = el('a', 'ext', d.accounts.length > 1 ? (a.name || a.profileId) + ' on aoe4world' : 'aoe4world');
      l.href = 'https://aoe4world.com/players/' + encodeURIComponent(a.profileId);
      l.target = '_blank'; l.rel = 'noopener noreferrer';
      act.appendChild(l);
    });
    head.appendChild(act);
    box.appendChild(head);
    var bf = backfillLine(d.backfill, true);
    if (bf) box.appendChild(bf);
    if (!d.games) return;

    // How they invest, per age: the same three columns as the board.
    var sec = el('section', 'psec');
    sec.appendChild(el('h3', 'psec-t', 'How they invest'));
    var grid = el('div', 'pgrid');
    var heads = el('div', 'prow3 pheads');
    heads.appendChild(el('span'));
    WINDOW_ORDER.forEach(function (w) {
      var hs = el('span', state.window === w ? 'now' : '', AGE[w].replace(' Age', ''));
      hs.appendChild(el('span', 'l-long', ' → ' + NEXT[w]));
      hs.setAttribute('data-w', w);
      heads.appendChild(hs);
    });
    grid.appendChild(heads);
    function lane(title, note, cell) {
      var l = el('div', 'plane');
      var row = el('div', 'prow3');
      var lab = el('div', 'plabel');
      lab.appendChild(el('span', 't', title));
      lab.appendChild(el('span', 's', note));
      row.appendChild(lab);
      WINDOW_ORDER.forEach(function (w) { row.appendChild(cell(w, d.windows[w])); });
      l.appendChild(row);
      grid.appendChild(l);
    }
    lane('Military', 'median, in age-ups', function (w, ws) {
      var c = el('div', 'pcell' + (state.window === w ? ' now' : ''));
      c.setAttribute('data-w', w);
      if (!ws || !ws.n) { c.appendChild(el('p', 'gone', 'Never reached the ' + AGE[w] + '.')); return c; }
      var top = el('div', 'pc-top2');
      top.appendChild(xval(el('span', 'ratio big'), ws.combined.median));
      top.appendChild(el('span', 'pc-n', plural(ws.n, 'game')));
      c.appendChild(top);
      c.appendChild(strip(ws.combined, (d.scales && d.scales[w]) || 1));
      var mid = el('p', 'pc-mid');
      mid.appendChild(document.createTextNode('middle half '));
      mid.appendChild(el('span', 'mono', fx(ws.combined.p25) + '–' + fx(ws.combined.p75) + 'x'));
      c.appendChild(mid);
      c.appendChild(mixTable(ws));
      return c;
    });
    lane('Next age-up', 'median time', function (w, ws) {
      var c = el('div', 'pcell' + (state.window === w ? ' now' : ''));
      c.setAttribute('data-w', w);
      if (!ws || !ws.n) { c.appendChild(el('p', 'gone', '—')); return c; }
      var top = el('div', 'pc-top2');
      top.appendChild(el('span', 'ratio big', ws.reached ? mmss(ws.ageUp.median) : '—'));
      top.appendChild(el('span', 'pc-n', NEXT[w]));
      c.appendChild(top);
      if (ws.reached > 1) {
        var mid = el('p', 'pc-mid');
        mid.appendChild(document.createTextNode('middle half '));
        mid.appendChild(el('span', 'mono', mmss(ws.ageUp.p25) + '–' + mmss(ws.ageUp.p75)));
        c.appendChild(mid);
      }
      c.appendChild(el('p', 'pc-mid', (ws.reached === ws.n ? 'every game' : ws.reached + ' of ' + ws.n + ' games') + ' reached ' + NEXT[w]));
      return c;
    });
    sec.appendChild(grid);
    box.appendChild(sec);

    // By civ, and their record against civs and on maps.
    var lower = el('div', 'plower');
    var civSec = el('section', 'psec');
    civSec.appendChild(el('h3', 'psec-t', 'By civ'));
    var t = el('table', 'civt');
    var cg = el('colgroup');
    ['c-civ', 'c-n', 'c-n', 'c-a', 'c-a', 'c-a'].forEach(function (c) { cg.appendChild(el('col', c)); });
    t.appendChild(cg);
    var th = el('thead'), hr = el('tr');
    ['Civ', 'Games', 'Won', 'Dark', 'Feudal', 'Castle'].forEach(function (x, i) { var c = el('th', i ? 'r' : '', x); hr.appendChild(c); });
    th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    d.civs.forEach(function (c) {
      var row = el('tr');
      row.appendChild(el('th', null, civName(c.civ)));
      row.appendChild(el('td', null, String(c.games)));
      row.appendChild(el('td', null, pctText(c.wins, c.games)));
      WINDOW_ORDER.forEach(function (w) {
        var ws = c.windows[w], td = el('td', 'a');
        if (!ws || !ws.n || ws.combined === null) { td.textContent = '—'; td.classList.add('zero'); }
        else {
          td.appendChild(xval(el('span', 'v'), ws.combined));
          var tm = el('span', 't', ws.ageUp !== null && ws.reached ? mmss(ws.ageUp) : '—');
          tm.title = ws.reached ? 'Median ' + NEXT[w] + ' time, ' + ws.reached + ' of ' + ws.n + ' got there' : 'Never reached ' + NEXT[w];
          td.appendChild(tm);
        }
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    civSec.appendChild(t);
    civSec.appendChild(el('p', 'psec-n', 'Each age shows their median military in age-ups and, below it, the median time they reached the next age.'));
    lower.appendChild(civSec);

    var recSec = el('section', 'psec precs');
    function recTable(title, rows, label) {
      var wrap = el('div', 'prec');
      wrap.appendChild(el('h3', 'psec-t', title));
      var tt = el('table', 'rect');
      var cg2 = el('colgroup'); ['c-l', 'c-r', 'c-n'].forEach(function (c) { cg2.appendChild(el('col', c)); }); tt.appendChild(cg2);
      var bd = el('tbody');
      rows.forEach(function (x) {
        var row = el('tr');
        row.appendChild(el('th', null, label(x)));
        row.appendChild(el('td', null, record(x.wins, x.games - x.wins)));
        row.appendChild(el('td', null, pctText(x.wins, x.games)));
        bd.appendChild(row);
      });
      tt.appendChild(bd);
      wrap.appendChild(tt);
      return wrap;
    }
    recSec.appendChild(recTable('Against', d.versus.slice(0, 8), function (x) { return civName(x.civ); }));
    recSec.appendChild(recTable('Maps', d.maps.slice(0, 6), function (x) { return x.map; }));
    lower.appendChild(recSec);
    box.appendChild(lower);
  }

  // ── Data ─────────────────────────────────────────────────────────
  var seq = 0;
  function load() {
    writeHash(); syncControls();
    var my = ++seq;
    var only = listPlayers();
    var p = new URLSearchParams({ window: state.window, group: only ? 'all' : state.group, sort: state.sort, dir: state.dir, limit: '300' });
    if (state.version) p.set('version', state.version);
    if (only) p.set('player', only.join(','));
    if (state.civ) p.set('civ', state.civ);
    if (state.vs) p.set('vs', state.vs);
    if (state.q && !only) p.set('q', state.q);
    if (state.reached) p.set('reached', '1');
    p.set('hm', state.hm);
    WINDOW_ORDER.forEach(function (w) { if (ranges[w]) p.set('range_' + w, rangeParam(ranges[w])); });
    $('status').textContent = 'Loading…';
    syncWho();
    if (state.view === 'player') markNow();
    fetch('/api/rows?' + p.toString()).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (my !== seq) return;
      lastScale = data.scale || 1;
      var list = $('list');
      list.textContent = '';
      rowsByKey = {};
      var rows = data.rows || [];
      rows.forEach(function (r) { list.appendChild(card(r, lastScale)); });
      lastHist = data.histogram;
      renderHist();
      $('status').textContent = statusText(data, rows.length);
      autoPick();
    }).catch(function (err) {
      if (my !== seq) return;
      $('status').textContent = 'Could not load results (' + err.message + ').';
    });
  }

  function init() {
    readHash();
    fetch('/api/meta').then(function (r) { return r.json(); }).then(function (m) {
      fillSelect($('civ'), m.civs || [], civName);
      fillSelect($('vs'), m.civs || [], civName);
      fillSelect($('group'), m.groups || [], function (g) { return g.charAt(0).toUpperCase() + g.slice(1); });
      var upd = m.updated ? new Date(m.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
      $('meta').textContent = (m.analysedGames || 0) + ' games analysed, metric ' + (m.version || 'none') + ', updated ' + upd + '.';
      render();
    }).catch(function () { render(); });

    // Links between views change the address; the back button walks them.
    window.addEventListener('hashchange', function () { readHash(); render(); });
    window.addEventListener('storage', function (e) {
      if (e.key !== PIN_KEY && e.key !== ALL_KEY) return;
      pinned = readPin(); preferAll = readFlag(ALL_KEY);
      renderChip();
      if (state.view === '') load(); else if (state.view === 'players' && playersData) renderPlayers();
    });
    Array.prototype.forEach.call($('who-switch').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        preferAll = b.getAttribute('data-who') === 'all';
        writeFlag(ALL_KEY, preferAll);
        load();
      });
    });
    $('who-switch').querySelector('.pin-ico').appendChild(pinIcon(true));
    var ft;
    $('find').addEventListener('input', function () {
      clearTimeout(ft);
      ft = setTimeout(function () { findPlayers($('find').value.trim()); }, 300);
    });
    renderChip();

    $('tabs').addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button') : null;
      var w = t && t.getAttribute('data-window');
      if (w && NEXT[w]) { state.window = w; load(); }
    });
    ['group', 'civ', 'vs', 'sort'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state[id] = $(id).value;
        if (id === 'sort') state.dir = 'desc';
        load();
      });
    });
    $('dir').addEventListener('click', function () { state.dir = state.dir === 'desc' ? 'asc' : 'desc'; load(); });
    $('hm').addEventListener('change', function () {
      state.hm = $('hm').value;
      if (ranges[state.window]) ranges[state.window] = null; // a range on one ratio doesn't carry to another
      load();
    });
    $('apply').addEventListener('click', applyInputs);
    $('clear').addEventListener('click', function () { ranges[state.window] = null; load(); });
    ['lo', 'hi'].forEach(function (id) { $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') applyInputs(); }); });
    $('reached').addEventListener('change', function () { state.reached = $('reached').checked; load(); });
    var t;
    $('q').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.q = $('q').value.trim(); load(); }, 300);
    });

    // Wide screens: the arrow keys move through the list; widening the window picks a game.
    document.addEventListener('keydown', function (e) {
      if (!wide.matches || e.altKey || e.ctrlKey || e.metaKey || state.view === 'players') return;
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
    });
    if (wide.addEventListener) wide.addEventListener('change', function (e) { if (e.matches) autoPick(); });
  }

  init();
})();
