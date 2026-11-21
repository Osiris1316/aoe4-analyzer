// Investment ratios page. Plain JS, no build step. Every value from the API is
// inserted with textContent, never as HTML (player names come from aoe4world).
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
  var BUCKET = { production: 'Production', units: 'Units', defense: 'Defense', walls: 'Walls' };
  var FLAG = {
    next_age_not_reached: 'Did not reach the next age; divided by the standard age-up cost.',
    default_divisor: 'The age-up bought could not be found; divided by the standard age-up cost.',
    age_time_from_build_order: 'Age-up time taken from the build order, not the game actions.',
    unpriced_free_unit: 'A free unit with no price was counted at zero.'
  };

  var state = { window: 'dark', group: 'all', civ: '', vs: '', q: '', reached: false, sort: 'combined', dir: 'desc', version: '', hm: 'combined' };
  // The age path: a range per window, { metric, lo, hi } with ratios as decimals and hi exclusive (null = open).
  var ranges = { dark: null, feudal: null, castle: null };
  var WINDOW_ORDER = ['dark', 'feudal', 'castle'];
  var RATIO_NAME = { combined: 'combined', units: 'units', production: 'production', defense: 'defense', walls: 'walls' };
  var lastHist = null;
  var $ = function (id) { return document.getElementById(id); };

  function civName(id) {
    if (!id) return '?';
    return CIV[id] || id.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function mmss(s) {
    s = Math.max(0, Math.round(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function pct(x) { return Math.round((x || 0) * 100) + '%'; }
  function day(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function title(id) { return String(id || '').replace(/-/g, ' '); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function parse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }

  // ── State in the address (shareable links, back button) ──────────
  function readHash() {
    var h = new URLSearchParams(location.hash.slice(1));
    Object.keys(state).forEach(function (k) {
      if (!h.has(k)) return;
      state[k] = k === 'reached' ? h.get(k) === '1' : h.get(k);
    });
    if (!NEXT[state.window]) state.window = 'dark';
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
    var lo = Math.round(r.lo * 100), hi = r.hi === null ? null : Math.round(r.hi * 100);
    return RATIO_NAME[r.metric] + ' ' + (hi === null ? lo + '% and up' : lo === 0 ? 'under ' + hi + '%' : lo + '% to under ' + hi + '%');
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
    $('lo').value = own ? Math.round(own.lo * 100) : '';
    $('hi').value = own && own.hi !== null ? Math.round(own.hi * 100) : '';
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

  // ── Rendering ────────────────────────────────────────────────────
  function card(r) {
    var li = el('li', 'card');
    var btn = el('button'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'false');

    var top = el('div', 'top');
    top.appendChild(el('span', 'pct', pct(r.ratio_combined)));
    var who = el('span', 'who', r.person || r.player_name || '?');
    top.appendChild(who);
    top.appendChild(el('span', 'pill ' + (r.player_group || ''), r.player_group || 'opponent'));
    btn.appendChild(top);

    var l2 = el('div', 'line2');
    l2.appendChild(document.createTextNode(civName(r.civ) + ' vs ' + civName(r.opponent_civ) + ' · ' + (r.map || '?') + ' · '));
    var res = el('span', r.result === 'win' ? 'res-win' : r.result === 'loss' ? 'res-loss' : '', r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : '?');
    l2.appendChild(res);
    l2.appendChild(document.createTextNode(' · ' + (r.reached_next_age ? NEXT[r.age_window] + ' at ' + mmss(r.window_end_sec) : 'never reached ' + NEXT[r.age_window]) + ' · ' + day(r.started_at)));
    btn.appendChild(l2);

    var total = (r.ratio_production || 0) + (r.ratio_units || 0) + (r.ratio_defense || 0);
    var scale = total > 1 ? 1 / total : 1;
    var bar = el('div', 'bar' + (total > 1 ? ' over' : ''));
    [['p', r.ratio_production], ['u', r.ratio_units], ['d', r.ratio_defense]].forEach(function (seg) {
      var s = el('span', seg[0]); s.style.width = Math.max(0, (seg[1] || 0) * scale * 100) + '%'; bar.appendChild(s);
    });
    btn.appendChild(bar);

    var nums = el('div', 'nums');
    nums.appendChild(el('span', null, 'Prod ' + pct(r.ratio_production)));
    nums.appendChild(el('span', null, 'Units ' + pct(r.ratio_units)));
    nums.appendChild(el('span', null, 'Def ' + pct(r.ratio_defense)));
    nums.appendChild(el('span', null, 'Walls ' + pct(r.ratio_walls)));
    btn.appendChild(nums);
    li.appendChild(btn);

    btn.addEventListener('click', function () {
      var open = li.querySelector('.detail');
      if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
      li.appendChild(detail(r));
      btn.setAttribute('aria-expanded', 'true');
    });
    return li;
  }

  function detail(r) {
    var d = el('div', 'detail');
    var src = String(r.next_age_cost_source || '');
    var bought = src.indexOf(':') > 0 ? title(src.split(':')[1])
      : r.reached_next_age ? "the standard cost, as the age-up they bought wasn't found" : 'the standard cost, as they never aged up';
    var next = NEXT[r.age_window];
    var from = r.age_window === 'dark' ? 'the start of the game' : 'reaching ' + r.age_window.charAt(0).toUpperCase() + r.age_window.slice(1) + ' at ' + mmss(r.window_start_sec);
    var until = r.reached_next_age ? 'reaching ' + next + ' at ' + mmss(r.window_end_sec) : 'the end of the game at ' + mmss(r.window_end_sec) + ', without reaching ' + next;
    d.appendChild(el('p', null, (r.player_name || '?') + ' (' + civName(r.civ) + '), ' + AGE[r.age_window] + ': from ' + from + ' until ' + until + '.'));
    var military = (r.spend_production || 0) + (r.spend_units || 0) + (r.spend_defense || 0);
    d.appendChild(el('p', null, 'Spent ' + military + ' on military in that time, ' + pct(r.ratio_combined) + ' of the ' + next + ' age-up cost of ' +
      r.next_age_cost + ' (' + bought + ').' + (r.spend_walls ? ' Walls are counted separately: ' + r.spend_walls + ', or ' + pct(r.ratio_walls) + '.' : '')));
    var items = parse(r.items_json, []);
    ['units', 'production', 'defense', 'walls'].forEach(function (b) {
      var these = items.filter(function (i) { return i.bucket === b; });
      if (!these.length) return;
      var spend = these.reduce(function (s, i) { return s + i.n * i.cost; }, 0);
      d.appendChild(el('h3', null, BUCKET[b] + ', ' + spend));
      var ul = el('ul');
      these.forEach(function (i) {
        ul.appendChild(el('li', null, i.n + ' ' + title(i.id) + ' at ' + i.cost + (i.by !== 'listed' ? ' (' + i.by + ' price)' : '')));
      });
      d.appendChild(ul);
    });
    if (!items.length) d.appendChild(el('p', null, 'Nothing military counted in this window.'));
    var flags = parse(r.flags_json, []);
    if (flags.length) {
      var f = el('p', 'flags');
      f.textContent = flags.map(function (x) { return FLAG[x] || x; }).join(' ');
      d.appendChild(f);
    }
    var a = el('a', null, 'Open the game on aoe4world');
    a.href = 'https://aoe4world.com/players/' + encodeURIComponent(r.profile_id) + '/games/' + encodeURIComponent(r.game_id);
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    d.appendChild(a);
    return d;
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
    return text + (shown ? ' Tap one for details.' : '');
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

  function renderHist() {
    var box = $('hist');
    box.textContent = '';
    if (!lastHist) return;
    var counts = [];
    for (var i = 0; i <= 20; i++) counts.push(0);
    (lastHist.buckets || []).forEach(function (b) { if (b.b >= 0 && b.b <= 20) counts[b.b] += b.n; });
    var max = Math.max.apply(null, counts.concat([1]));
    var own = ranges[state.window];
    counts.forEach(function (n, b) {
      var lo = b / 10, hi = b === 20 ? null : (b + 1) / 10;
      var on = own && lo >= own.lo - 1e-9 && (own.hi === null || lo < own.hi - 1e-9);
      var bar = el('button', on ? 'on' : '');
      bar.type = 'button';
      bar.setAttribute('aria-label', (b === 20 ? '200% and up' : (b * 10) + '% to ' + ((b + 1) * 10) + '%') + ': ' + plural(n, 'player-game'));
      var fill = el('span');
      fill.style.height = (n ? Math.max(4, (n / max) * 100) : 0) + '%';
      bar.appendChild(fill);
      bar.addEventListener('click', function () { tapBucket(lo, hi); });
      box.appendChild(bar);
    });
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
    var lo = Math.max(0, Number(loV || 0)) / 100, hi = hiV === '' ? null : Number(hiV) / 100;
    if (!isFinite(lo) || (hi !== null && (!isFinite(hi) || hi <= lo))) { $('status').textContent = 'The range needs a "to" value above its "from" value.'; return; }
    ranges[state.window] = { metric: $('hm').value, lo: lo, hi: hi };
    load();
  }

  // ── Data ─────────────────────────────────────────────────────────
  var seq = 0;
  function load() {
    writeHash(); syncControls();
    var my = ++seq;
    var p = new URLSearchParams({ window: state.window, group: state.group, sort: state.sort, dir: state.dir, limit: '300' });
    if (state.version) p.set('version', state.version);
    if (state.civ) p.set('civ', state.civ);
    if (state.vs) p.set('vs', state.vs);
    if (state.q) p.set('q', state.q);
    if (state.reached) p.set('reached', '1');
    p.set('hm', state.hm);
    WINDOW_ORDER.forEach(function (w) { if (ranges[w]) p.set('range_' + w, rangeParam(ranges[w])); });
    $('status').textContent = 'Loading…';
    fetch('/api/rows?' + p.toString()).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (my !== seq) return;
      var list = $('list');
      list.textContent = '';
      var rows = data.rows || [];
      rows.forEach(function (r) { list.appendChild(card(r)); });
      lastHist = data.histogram;
      renderHist();
      $('status').textContent = statusText(data, rows.length);
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
      load();
    }).catch(function () { load(); });

    $('tabs').addEventListener('click', function (e) {
      var w = e.target && e.target.getAttribute && e.target.getAttribute('data-window');
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
  }

  init();
})();
