/* Прототип v6 · интерфейс. Все числа и фразы с числами — из результата Engine.run() (engine.js) на снимке data.js.
   Литералов предметных данных здесь нет: только пороги отображения и тексты интерфейса. */
'use strict';

/* ===== прогон ===== */
const U = Engine.util;
let COMPACT = VELSA_DATA;           // входы: встроенный снимок или загруженные CSV
let SOURCE = {kind: 'snapshot', files: null};
let R = null, PREV = null, LAST_DIFF = null;
let SK = {}, SP = {}, CAT = {};
const RUNLOG = {at: null, ms: null, selftest: null, params: {}};

function runEngine(params) {
  const t0 = performance.now();
  const res = Engine.run(COMPACT, params);
  RUNLOG.ms = Math.round(performance.now() - t0);
  RUNLOG.engineMs = res.timing.total;
  RUNLOG.at = new Date();
  const st = Engine.selftest(res, COMPACT);
  RUNLOG.selftest = {ok: st.filter(t => t.ok).length, all: st.length, list: st};
  return res;
}
function setResult(res) {
  R = res;
  SK = {}; R.skus.forEach(s => { SK[s.id] = s; });
  SP = {}; R.suppliers.forEach(s => { SP[s.id] = s; });
  CAT = R.categories;
  traceCache.clear();
  seasonGapCache = null;
}

/* ===== форматы ===== */
const fmt = n => U.fmtN(n);
const fmtF = (x, k = 2) => x == null || !isFinite(x) ? '—' : (+x).toFixed(k).replace('.', ',');
const pctS = x => x == null ? '—' : Math.round(x * 100) + ' %';
const dmy = s => s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '—';
const dmShort = s => s ? s.slice(8, 10) + '.' + s.slice(5, 7) : '—';
const range = (a, b) => !a || !b ? '—' : a.slice(0, 4) === b.slice(0, 4) ? dmShort(a) + '–' + dmy(b) : dmy(a) + '–' + dmy(b);
const mmyyyy = m => m ? m.slice(5, 7) + '.' + m.slice(0, 4) : '—';
const dnum = s => U.dnum(s);
const isoOf = d => U.iso(d);
const today = () => R.today;
const todayD = () => dnum(R.today);
const daysBetween = (a, b) => dnum(b) - dnum(a);
const tonsS = (t, approx) => (approx ? '≈' : '') + fmtF(t, t >= 100 ? 0 : 1);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monLabel = m => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(2, 4);
const addMonth = (m, k) => { let y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '-' + String(mo + 1).padStart(2, '0'); };
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s\-–—_.,«»"]/g, '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const nameOf = id => (R.names.sku[id]) || id;
const supNameOf = id => id ? (R.names.sup[id] || id) : 'Без поставщика';
const catName = c => (CAT[c] || {}).name || c;

/* ===== статусы ===== */
const STATUS = {
  late: {label: 'Просрочено', icon: 'clock-alert', color: '--late', sort: 0},
  order: {label: 'Заказать', icon: 'shopping-cart', color: '--order', sort: 1},
  blocked: {label: 'Сменить поставщика', icon: 'ban', color: '--blocked', sort: 2},
  next: {label: 'Следующий цикл', icon: 'calendar-clock', color: '--next', sort: 3},
  ok: {label: 'В норме', icon: 'circle-check', color: '--ok', sort: 4},
  margin: {label: 'Низкая наценка', icon: 'percent', color: '--margin', sort: 5},
  over: {label: 'Избыток', icon: 'layers', color: '--over', sort: 6},
  dead: {label: 'Мёртвый', icon: 'archive', color: '--dead', sort: 7}
};
const statusHtml = code => { const S = STATUS[code]; return S ? `<span class="status"><span class="ic" style="color:var(${S.color})">${icon(S.icon, 16)}</span>${S.label}</span>` : '—'; };
const inPlan = s => s.status === 'late' || s.status === 'order';

/* ===== состояние интерфейса ===== */
const state = {
  section: 'home', route: {sec: 'home', sub: null, query: {}},
  params: {},                          // параметры прогона, отличные от Engine.defaults
  overrides: {},                       // «Перенести на альтернативу»: {SKU: SUP}
  edits: {},                           // правка количества в плане: {SKU: {qty, reason}}
  plan: {view: 'now', bySupplier: true, openGroups: new Set(), shown: {}, open: new Set(), q: '', f: {cat: '', cls: '', status: '', sup: '', lowFill: false}, page: 50},
  seasons: {tab: 'ready', defView: 'list', open: new Set(), laterOpen: false, nearShown: 50, laterShown: 50, tl: {sup: '', cat: '', st: 'plan'}, flatOpen: false, lostOpen: false},
  table: {},
  runs: {},
  agent: {open: false, tab: 'chat', feed: [], audit: [], filter: '', touched: false, thinking: [], ctx: null, used: {}}
};
const qtyOf = s => (state.edits[s.id] ? state.edits[s.id].qty : s.qty);
function planTotals(list) {
  let qty = 0, kg = 0, exp = 0, approx = false;
  list.forEach(s => { const q = qtyOf(s); qty += q; kg += q * s.weightKg; exp += state.edits[s.id] ? Math.round(q * (s.sup ? s.fill : 1)) : s.qty === q && inPlan(s) ? s.expectedArrivalQty : Math.round(q * (s.sup ? s.fill : 1)); if (q && s.flags.weightImputed) approx = true; });
  return {count: list.length, qty, kg, tons: kg / 1000, approx, expected: Math.round(exp), containers: kg / R.params.containerKg};
}
const planList = () => R.skus.filter(inPlan);

/* ===== объявления, уведомления ===== */
function say(text) { const el = $('#say'); el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); }
let toastTimer = null, toastUndo = null;
function hideToast() { clearTimeout(toastTimer); const t = $('#toast'); if (t) t.hidden = true; toastUndo = null; }
function toast(text, undo) {
  const t = $('#toast');
  toastUndo = undo || null;
  t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button" id="toast-undo">Отменить</button>' : ''}`;
  t.hidden = false;
  say(text);
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; toastUndo = null; }, 7000); };
  t.onmouseenter = () => clearTimeout(toastTimer);
  t.onmouseleave = arm;
  arm();
}
document.addEventListener('click', e => { if (e.target.id === 'toast-undo' && toastUndo) { const u = toastUndo; hideToast(); u(); } });

/* ===== подсказки [data-tip]: наведение и фокус с клавиатуры; на подсказку можно навести; Esc закрывает (WCAG 1.4.13).
   Доступное имя или описание у элемента своё (aria-label / aria-describedby), подсказка его только показывает. ===== */
const TIP = {for: null, show: null, hide: null};
function tipShow(target) {
  const text = target.getAttribute('data-tip'); if (!text || !document.contains(target)) return;
  let el = $('#tip');
  if (!el) { el = document.createElement('div'); el.id = 'tip'; el.className = 'tip'; el.setAttribute('role', 'tooltip'); el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); el.addEventListener('mouseenter', () => clearTimeout(TIP.hide)); el.addEventListener('mouseleave', () => tipHide(120)); }
  el.textContent = text; el.hidden = false; TIP.for = target;
  const r = target.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  let y = r.bottom + 4; if (y + h > innerHeight - 8) y = r.top - h - 4;
  el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px'; el.style.top = Math.max(8, y) + 'px';
}
function tipHide(delay) {
  clearTimeout(TIP.show); clearTimeout(TIP.hide);
  const go = () => { const el = $('#tip'); if (el) el.hidden = true; TIP.for = null; };
  if (delay) TIP.hide = setTimeout(go, delay); else go();
}
const tipOpen = () => !!TIP.for;
document.addEventListener('mouseover', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!t || t === TIP.for) return; clearTimeout(TIP.show); clearTimeout(TIP.hide); TIP.show = setTimeout(() => tipShow(t), 300); });
document.addEventListener('mouseout', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return; clearTimeout(TIP.show); if (TIP.for === t) tipHide(150); });
document.addEventListener('focusin', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && t.matches(':focus-visible')) tipShow(t); else if (TIP.for) tipHide(); });
document.addEventListener('focusout', e => { if (TIP.for && TIP.for.contains(e.target)) tipHide(); });
document.addEventListener('mousedown', () => { if (TIP.for) tipHide(); }, true);
document.addEventListener('scroll', () => { if (TIP.for) tipHide(); }, true);

function focusables(root) {
  return $$('button,[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])', root).filter(el => !el.disabled && el.offsetParent !== null && !el.closest('[hidden]'));
}
/* Перерисовка с сохранением фокуса: ищем элемент с тем же селектором после render() (B-55) */
function keepFocus(root, fn) {
  const a = document.activeElement, keys = a && root.contains(a) ? ['id', 'data-id', 'data-act', 'data-role', 'data-tab', 'data-st', 'data-aid', 'data-grp', 'data-view'].filter(k => a.hasAttribute(k)).map(k => `[${k}="${CSS.escape(a.getAttribute(k))}"]`).join('') : '';
  fn();
  if (keys) { const b = $(a.tagName.toLowerCase() + keys, root) || $(keys, root); if (b) b.focus(); }
}

/* ===== CSV под Excel ru: UTF-8 с BOM, «;», \r\n ===== */
function exportCsv(filename, head, rows) {
  const q = v => { const t = v == null ? '' : String(v); return /[;"\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const text = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
  download(filename, text, 'text/csv;charset=utf-8');
}
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const csvNum = n => n == null ? '' : String(Math.round(n));
const csvF = x => x == null ? '' : fmtF(x);
const lastsText = s => s.lastsUntil == null ? '> 18 мес' : s.lastsUntil <= today() ? 'уже дефицит' : dmy(s.lastsUntil);

/* ===== адреса (B-53): #раздел/объект?параметры ===== */
function parseHash(h) {
  h = (h || '').replace(/^#/, '');
  const [path, q = ''] = h.split('?');
  const [sec, ...rest] = path.split('/');
  const query = {}; new URLSearchParams(q).forEach((v, k) => { query[k] = v; });
  return {sec: sec || 'home', sub: rest.length ? decodeURIComponent(rest.join('/')) : null, query};
}
function hashOf(sec, sub, query) {
  const qs = query ? Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
  return '#' + sec + (sub ? '/' + encodeURIComponent(sub) : '') + (qs ? '?' + qs : '');
}
function go(sec, {sub = null, query = null, replace = false} = {}) {
  const h = hashOf(sec, sub, query);
  if (location.hash === h) { render(); return; }
  if (replace) { history.replaceState(null, '', h); render(); } else location.hash = h;
}

/* ===== графики: цвета из токенов CSS ===== */
const charts = [];
const killCharts = () => charts.splice(0).forEach(c => c.destroy());
if (window.Chart) { Chart.defaults.font.family = '"IBM Plex Sans", system-ui, sans-serif'; Chart.defaults.font.size = 12; }
const chartOff = () => '<div class="chart-off">График недоступен без интернета (Chart.js загружается с CDN). Числа — в «Данных графика» ниже.</div>';

/* ===== строка позиции: модель B-35 (tr — строка, кнопка в ячейке названия, клик по строке = L2) ===== */
function supSub(s) { return s.sup ? supNameOf(s.sup) : 'без поставщика'; }
function windowOf(s) {
  const q = s.qtyBreakdown;
  if (q.rule === 'season' && q.season) return {demand: q.season.demand, from: q.season.from, to: q.season.to, season: true};
  return {demand: q.demand, from: q.window.from, to: q.window.to, season: false};
}
function lastsCell(s) {
  const main = s.lastsUntil == null ? '> 18 мес' : s.lastsUntil <= today() ? '<span class="warn">уже дефицит</span>' : dmy(s.lastsUntil);
  const a = s.lastsUntil, b = s.lastsUntil100;
  if (a && a <= today() && s.transitExpected > 0) {
    /* остатка нет, но приход в пути: когда вернётся и до какого дня хватит после (тот же дневной ряд) */
    const r = afterArrival(s);
    if (r) return main + `<span class="sub">с ${dmShort(r.from)} — до ${r.to ? dmy(r.to) : '> 18 мес'}</span>`;
  }
  const differ = (a == null) !== (b == null) || (a && b && Math.abs(daysBetween(a, b)) > 7);
  return main + (differ ? `<span class="sub">при 100 % — ${b == null ? '> 18 мес' : dmy(b)}</span>` : '');
}
function afterArrival(s) {
  const tr = traceOf(s.id); if (!tr) return null;
  const e = tr.exp.end; let t = 0;
  while (t < e.length && e[t] <= 0) t++;
  if (t >= e.length) return null;
  const from = t; while (t < e.length && !(e[t] <= 0 && tr.demand[t] > 0)) t++;
  return {from: isoOf(todayD() + from), to: t < e.length ? isoOf(todayD() + t) : null};
}
function decideCell(s) {
  if (s.status === 'margin' || s.status === 'dead' || s.status === 'over') return '<span class="zero">—</span>';
  const d = s.decisionBy;
  if (!d) return '—';
  const late = d < today();
  let sub = late ? '<span class="sr"> — срок прошёл</span>' : '';
  if (s.season && s.season.orderBy) {
    if (d !== s.season.orderBy && s.season.orderBy >= today()) sub = `<span class="sub">к сезону ${dmy(s.season.orderBy)}</span>`;
  }
  return `${late ? `<span class="warn">${dmy(d)}</span>` : dmy(d)}${sub}`;
}
function qtyCell(s, editable) {
  if (inPlan(s)) {
    const e = state.edits[s.id], q = qtyOf(s);
    const val = `<span class="qty${e ? ' edited' : ''}">${fmt(q)}</span>`;
    return (editable ? `<button type="button" class="qty-btn" data-act="qty" data-id="${s.id}" aria-label="Изменить количество: ${esc(s.name)}, сейчас ${fmt(q)} шт">${val}</button>` : val) + (e ? '<span class="sub">изменено вручную</span>' : s.flags.tailC ? '<span class="sub">хвост C</span>' : '');
  }
  if ((s.status === 'blocked' || s.status === 'margin' || s.status === 'next') && s.qtyCalc) return `<span class="zero">${fmt(s.qtyCalc)}</span><span class="sub">${s.status === 'next' ? 'оценка' : 'по спросу'}</span>`;
  return '<span class="zero">—</span>';
}
const COLS = {
  pos: {head: 'Позиция', w: null, cls: 'pos', cell: (s, o) => `<button type="button" class="row-btn" data-act="l2" data-id="${s.id}" aria-expanded="${!!o.open}" aria-controls="l2-${o.ctx}-${s.id}">${esc(s.name)}</button><span class="code">${s.id}</span><span class="sub ground" title="${esc(s.ground)}">${esc(s.ground)}</span>`,
    csv: [['Позиция', s => s.name], ['Код', s => s.id], ['Основание', s => s.ground]]},
  posN: {head: 'Позиция', w: null, cls: 'pos', cell: (s, o) => `<button type="button" class="row-btn" data-act="l2" data-id="${s.id}" aria-expanded="${!!o.open}" aria-controls="l2-${o.ctx}-${s.id}">${esc(s.name)}</button><span class="code">${s.id}</span><span class="sub" title="${esc(s.ground)}">${esc(s.ground)}</span>`, csv: []},
  status: {head: 'Статус', w: 128, cell: s => statusHtml(s.status), csv: [['Статус', s => STATUS[s.status].label]]},
  stock: {head: 'Остаток', w: 68, num: true, cell: s => fmt(s.stock), csv: [['Остаток', s => csvNum(s.stock)]]},
  transit: {head: 'В пути', w: 84, num: true, title: 'Открытые заказы поставщику. «Ожидаем» = в пути × доля поставки; просроченные PO без подтверждения — 0',
    cell: s => s.transit ? `${fmt(s.transit)}${s.transitExpected !== s.transit ? `<span class="sub${s.transitExpected ? '' : ' warn'}">ожидаем ${fmt(s.transitExpected)}</span>` : ''}` : '<span class="zero">0</span>',
    csv: [['В пути', s => csvNum(s.transit)], ['Ожидаем', s => csvNum(s.transitExpected)]]},
  window: {head: 'Спрос на окно, шт', w: 124, num: true, title: 'Прогноз спроса на окно [приход; приход + цикл + покрытие] — из этого числа считается заказ. У сезонного правила — до конца сезона',
    cell: s => { const w = windowOf(s); return `<span title="окно ${range(w.from, w.to)}">${fmt(w.demand)}</span>`; },
    csv: [['Спрос на окно, шт', s => csvNum(windowOf(s).demand)], ['Окно', s => { const w = windowOf(s); return dmy(w.from) + '–' + dmy(w.to); }]]},
  lasts: {head: 'Хватит до', w: 100, num: true, title: 'Ожидаемый сценарий: в пути × доля поставки. Вторая дата — при приходе 100 %, если расходится больше чем на 7 дней',
    cell: s => lastsCell(s), csv: [['Хватит до', s => lastsText(s)], ['Хватит до при 100 %', s => s.lastsUntil100 == null ? '> 18 мес' : dmy(s.lastsUntil100)]]},
  decide: {head: 'Заказать до', w: 132, num: true, cell: s => decideCell(s),
    csv: [['Заказать до', s => (s.status === 'margin' || s.status === 'dead' || s.status === 'over') ? '' : dmy(s.decisionBy)], ['К сезону', s => s.season ? dmy(s.season.orderBy) : '']]},
  qty: {head: 'Заказать, шт', w: 96, num: true, cell: (s, o) => qtyCell(s, o.editable), csv: [['Заказать, шт', s => csvNum(qtyOf(s))]]},
  sup: {head: 'Поставщик', w: 176, cell: s => s.sup ? `<span title="${esc(supNameOf(s.sup))}">${esc(supNameOf(s.sup))}</span>` : '<span class="zero">—</span>', csv: [['Поставщик', s => s.sup ? supNameOf(s.sup) : ''], ['Код поставщика', s => s.sup || '']]},
  chev: {head: '<span class="sr">Раскрыть</span>', w: 28, cls: 'chev', cell: () => icon('chevron-down', 16), csv: []}
};
function colgroup(cols) { return '<colgroup>' + cols.map(k => `<col${COLS[k].w ? ` style="width:${COLS[k].w}px"` : ''}>`).join('') + '</colgroup>'; }
function thead(cols) { return '<thead><tr>' + cols.map(k => { const c = COLS[k]; return `<th scope="col" class="${c.num ? 'num' : ''} ${c.cls === 'chev' ? 'chev' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.head}${c.title ? `<span class="sr">. ${esc(c.title)}</span>` : ''}</th>`; }).join('') + '</tr></thead>'; }
function rowL1(s, cols, o) {
  return `<tr class="row${o.open ? ' open' : ''}" data-row="${s.id}" data-ctx="${o.ctx}">` + cols.map(k => { const c = COLS[k]; return `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.cell(s, o)}</td>`; }).join('') + '</tr>';
}
function l2Facts(s) {
  const w = windowOf(s), kv = (l, v) => `<div><dt>${l}</dt><dd>${v}</dd></div>`;
  return kv('Спрос на окно', `${fmt(w.demand)} шт<span class="sub">${range(w.from, w.to)}</span>`) +
    kv('Приход при заказе', `${dmy(s.arrival)}<span class="sub">плечо ${s.lead.med} дн</span>`) +
    kv('Доля поставки', s.sup ? `${fmtF(s.fill)}<span class="sub">ERP ${fmtF(s.fillErp)}</span>` : '—') +
    kv('Ожидаемо придёт', s.qtyCalc ? `${fmt(s.expectedArrivalQty)} шт<span class="sub">из ${fmt(s.qtyCalc)}</span>` : '—');
}
const leadSrc = k => ({fact: 'факт', plan: 'план по PO', dim: 'справочник', default: 'по умолчанию', noSupplier: 'нет поставщика'}[k] || k);
function rowL2(s, span, o) {
  const alt = s.status === 'blocked' && s.alt;
  return `<tr class="l2" id="l2-${o.ctx}-${s.id}" data-l2="${s.id}"><td colspan="${span}"><div class="l2-body">
    <p>${esc(explainShort(s))}</p>
    <dl class="l2-facts">${l2Facts(s)}</dl>
    <div class="l2-actions">
      <button class="btn" type="button" data-act="card" data-id="${s.id}">${icon('chevron-right')}Карточка</button>
      ${alt ? `<button class="btn" type="button" data-act="move" data-id="${s.id}">${icon('arrow-right')}Перенести на ${esc(s.alt.name)}</button>` : ''}
      ${o.editable && inPlan(s) ? `<button class="btn" type="button" data-act="qty" data-id="${s.id}">Изменить количество</button>` : ''}
      <button class="btn" type="button" data-act="audit" data-id="${s.id}">${icon('list-plus')}В замечания</button>
      <button class="btn" type="button" data-act="ask" data-id="${s.id}">${icon('bot')}Спросить агента</button>
    </div></div></td></tr>`;
}
function rowsHtml(list, cols, o, openSet) {
  return list.map(s => { const open = openSet.has(s.id); const oo = {...o, open}; return rowL1(s, cols, oo) + (open ? rowL2(s, cols.length, oo) : ''); }).join('');
}
function toggleRow(tr, openSet, cols, o) {
  const id = tr.dataset.row, next = tr.nextElementSibling, btn = $('.row-btn', tr);
  if (tr.classList.contains('open')) {
    if (next && next.dataset.l2 === id) next.remove();
    tr.classList.remove('open'); openSet.delete(id); if (btn) btn.setAttribute('aria-expanded', 'false');
  } else {
    tr.insertAdjacentHTML('afterend', rowL2(SK[id], cols.length, {...o, open: true}));
    tr.classList.add('open'); openSet.add(id); if (btn) btn.setAttribute('aria-expanded', 'true');
  }
}
/* Делегирование для таблицы позиций: клик по строке — L2; кнопки [data-act] — действия */
function bindRows(root, opts) {
  if (!root) return;
  const cols = () => (typeof opts.cols === 'function' ? opts.cols() : opts.cols);
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a && root.contains(a)) {
      const act = a.dataset.act, id = a.dataset.id;
      if (act === 'l2') { const tr = a.closest('tr.row'); if (tr) toggleRow(tr, opts.openSet, cols(), opts.o); return; }
      if (opts.onAct && opts.onAct(act, id, a) === true) return;
      skuAction(act, id, a);
      return;
    }
    if (e.target.closest('a,button,input,select,label,summary,form')) return;
    const tr = e.target.closest('tr.row');
    if (tr && root.contains(tr) && tr.dataset.row) toggleRow(tr, opts.openSet, cols(), opts.o);
  });
}
function skuAction(act, id, el) {
  const s = SK[id];
  if (!s) return;
  if (act === 'card') openSku(id, el);
  else if (act === 'audit') auditAdd({kind: 'proposal', title: s.name, text: `${decisionText(s)}. Основание: ${s.ground}.`, ref: {type: 'sku', id}});
  else if (act === 'ask') agentOpen({context: {type: 'sku', id}});
  else if (act === 'move') moveToAlt([id]);
  else if (act === 'qty') startQtyEdit(id);
}
function decisionText(s) {
  if (inPlan(s)) return `Заказать ${fmt(qtyOf(s))} шт до ${dmy(s.decisionBy)}${s.decisionBy < today() ? ' (срок прошёл)' : ''}${s.sup ? ' у ' + supNameOf(s.sup) : ''}`;
  if (s.status === 'blocked') return `Сменить поставщика: по спросу ${fmt(s.qtyCalc)} шт${s.alt ? ', альтернатива ' + s.alt.name : ', альтернативы в данных нет'}`;
  return STATUS[s.status].label;
}
/* подогнать высоту контейнера таблицы под окно: липкая шапка работает внутри него */
function fitWrap(el, pad = 16) { if (!el) return; const top = el.getBoundingClientRect().top; el.style.maxHeight = Math.max(320, window.innerHeight - Math.max(top, 120) - pad) + 'px'; }

/* ===== дневной ряд позиции (Engine result.trace) ===== */
const traceCache = new Map();
function traceOf(id) { if (!traceCache.has(id)) traceCache.set(id, R.trace ? R.trace(id) : null); return traceCache.get(id); }
const sumDays = (a, n) => { let x = 0; for (let t = 0; t < Math.min(n, a.length); t++) x += a[t]; return x; };

/* ===== графики карточки ===== */
function monthStarts(H) { const out = []; let m = addMonth(R.calendar.month, 1); for (;;) { const x = daysBetween(today(), m + '-01'); if (x > H) break; out.push({x, m}); m = addMonth(m, 1); } return out; }
function seasonBands(cat, H) {
  const c = CAT[cat];
  if (!c || !c.seasonal || !c.season) return [];
  const out = [], y0 = +today().slice(0, 4);
  for (let y = y0 - 1; y <= y0 + 2; y++) {
    const a = `${y}-${String(c.season.fromMonth).padStart(2, '0')}-01`;
    const endY = c.season.toMonth >= c.season.fromMonth ? y : y + 1;
    const b = addMonth(`${endY}-${String(c.season.toMonth).padStart(2, '0')}`, 1) + '-01';
    const x0 = Math.max(0, daysBetween(today(), a)), x1 = Math.min(H, daysBetween(today(), b));
    if (x1 > x0) out.push([x0, x1]);
  }
  return out;
}
const bandsPlugin = {id: 'bands', beforeDatasetsDraw(c, a, o) {
  if (!o || !o.list) return;
  const {top, bottom} = c.chartArea, x = c.scales.x, g = c.ctx;
  g.save();
  o.list.forEach(b => { const x0 = x.getPixelForValue(b[0]), x1 = x.getPixelForValue(b[1]); g.fillStyle = b[2]; const h = b[3] || (bottom - top); g.fillRect(x0, b[3] ? bottom - h : top, Math.max(1, x1 - x0), h); });
  g.restore();
}};
const marksPlugin = {id: 'marks', afterDatasetsDraw(c, a, o) {
  if (!o || !o.list) return;
  const {top, bottom, left, right} = c.chartArea, x = c.scales.x, g = c.ctx;
  g.save(); g.font = '12px "IBM Plex Sans", system-ui, sans-serif';
  let lastLabelEnd = -1e9, row = 0;
  o.list.slice().sort((p, q) => p.x - q.x).forEach(m => {
    const px = x.getPixelForValue(m.x);
    if (px < left - 1 || px > right + 1) return;
    g.strokeStyle = m.color; g.lineWidth = m.width || 1.5; g.setLineDash(m.dash || []);
    g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke(); g.setLineDash([]);
    const w = g.measureText(m.label).width;
    row = px < lastLabelEnd + 8 ? row + 1 : 0;
    const lx = Math.min(px + 4, right - w);
    g.fillStyle = m.textColor || m.color; g.fillText(m.label, lx, top + 12 + row * 14);
    lastLabelEnd = lx + w;
  });
  g.restore();
}};
const endLabelsPlugin = {id: 'endLabels', afterDatasetsDraw(c, a, o) {
  if (!o || !o.on) return;
  const g = c.ctx, {right, top, bottom} = c.chartArea, placed = [];
  g.save(); g.font = '12px "IBM Plex Sans", system-ui, sans-serif'; g.textAlign = 'right';
  c.data.datasets.forEach((d, i) => {
    if (!d.endLabel || !c.isDatasetVisible(i)) return;
    const meta = c.getDatasetMeta(i), p = meta.data[meta.data.length - 1];
    if (!p) return;
    let y = Math.min(bottom - 4, Math.max(top + 12, p.y - 6));
    while (placed.some(v => Math.abs(v - y) < 14)) y -= 14;
    placed.push(y);
    g.fillStyle = d.borderColor; g.fillText(d.endLabel, right - 2, y);
  });
  g.restore();
}};
function chartProjection(canvas, s, tr) {
  const H = Math.min(tr.days, R.params.horizonDays);
  const line = end => { const a = [{x: 0, y: s.stock}]; for (let t = 0; t < H; t++) a.push({x: t + 1, y: Math.round(end[t])}); return a; };
  const C1 = css('--c-hist'), C2 = css('--c-arrive'), CS = css('--c-safety'), CO = css('--c-orderby');
  const ds = [{label: 'Без нового заказа (в пути × доля поставки)', endLabel: 'без заказа', data: line(tr.exp.end), borderColor: C1, borderWidth: 2}];
  const differs = (p, q) => p.some((v, t) => Math.abs(v - q[t]) > 0.5);
  if (differs(tr.full.end, tr.exp.end)) ds.push({label: 'Без нового заказа, в пути 100 %', endLabel: 'в пути 100 %', data: line(tr.full.end), borderColor: C1, borderWidth: 1, borderDash: [4, 3]});
  if (tr.order) ds.push({label: `С рекомендованным заказом ${fmt(s.qtyCalc)} шт × доля поставки`, endLabel: 'с заказом', data: line(tr.order.end), borderColor: C2, borderWidth: 2});
  if (tr.order100 && differs(tr.order100.end, tr.order.end)) ds.push({label: 'С заказом, приход 100 %', endLabel: 'с заказом 100 %', data: line(tr.order100.end), borderColor: C2, borderWidth: 1, borderDash: [4, 3]});
  ds.push({label: 'Страховой запас', endLabel: 'страховой', data: line(tr.ss), borderColor: CS, borderWidth: 1, borderDash: [2, 3], stepped: true});
  ds.forEach(d => Object.assign(d, {pointRadius: 0, pointHitRadius: 4, tension: 0, fill: false}));
  const bands = seasonBands(s.cat, H).map(b => [b[0], b[1], css('--c-season')]);
  let z0 = null; for (let t = 0; t <= H; t++) { const zero = t < H && tr.exp.end[t] <= 0 && tr.demand[t] > 0; if (zero && z0 == null) z0 = t; if (!zero && z0 != null) { bands.push([z0 + 1, t + 1, lateFill(), 6]); z0 = null; } }
  const marks = [{x: 0, label: 'сегодня', color: css('--accent')}];
  if (s.decisionBy && s.status !== 'margin' && s.status !== 'dead' && s.status !== 'over') { const x = Math.max(0, daysBetween(today(), s.decisionBy)); if (x <= H) marks.push({x, label: 'заказать до ' + dmy(s.decisionBy) + (s.decisionBy < today() ? ' (прошло)' : ''), color: CO}); }
  if (tr.qty > 0 && tr.arrT <= H) marks.push({x: tr.arrT, label: 'приход ' + dmy(s.arrival), color: C2, dash: [4, 3]});
  if (s.lastsUntil && daysBetween(today(), s.lastsUntil) + 1 <= H) marks.push({x: daysBetween(today(), s.lastsUntil) + 1, label: 'хватит до ' + dmy(s.lastsUntil), color: css('--ink-3'), width: 1, dash: [2, 2], textColor: css('--ink-2')});
  const ms = monthStarts(H);
  return new Chart(canvas, {type: 'line', data: {datasets: ds}, plugins: [bandsPlugin, marksPlugin, endLabelsPlugin],
    options: {responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
      layout: {padding: {top: 4, right: 4}},
      interaction: {mode: 'nearest', axis: 'x', intersect: false},
      plugins: {legend: {display: false}, bands: {list: bands}, marks: {list: marks}, endLabels: {on: true},
        tooltip: {callbacks: {title: it => it.length ? (it[0].parsed.x === 0 ? 'сегодня, остаток' : 'на конец ' + dmy(isoOf(todayD() + it[0].parsed.x - 1))) : '', label: it => `${it.dataset.label}: ${fmt(it.parsed.y)} шт`}}},
      scales: {x: {type: 'linear', min: 0, max: H, grid: {display: false}, afterBuildTicks: ax => { ax.ticks = ms.map(m => ({value: m.x})); },
        ticks: {color: css('--ink-3'), autoSkip: true, maxRotation: 0, callback: v => { const m = ms.find(q => q.x === v); return m ? monLabel(m.m) : ''; }}},
        y: {beginAtZero: true, grid: {color: css('--surface-3')}, border: {display: false}, ticks: {color: css('--ink-3'), precision: 0, callback: v => fmt(v)}}}}});
}
/* полупрозрачная заливка «нет остатка» из токена --late */
function alpha(color, a) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim()); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : color; }
function lateFill() { return alpha(css('--late'), 0.3); }
function salesSeries(s, tr) {
  const h = tr.hist, labels = [], net = [], rest = [], fc = [], inS = [];
  const c = CAT[s.cat], sm = c && c.seasonal && c.season ? c.season : null;
  const inSeason = m => { if (!sm) return false; const k = +m.slice(5, 7); return sm.toMonth >= sm.fromMonth ? k >= sm.fromMonth && k <= sm.toMonth : k >= sm.fromMonth || k <= sm.toMonth; };
  for (let k = 0; k < 12; k++) { const m = addMonth(h.from, k); labels.push(monLabel(m)); net.push(h.net[k]); rest.push(h.flag[k] === 1 || h.flag[k] === 2 ? Math.max(0, h.restored[k] - h.net[k]) : 0); fc.push(null); inS.push(inSeason(m)); }
  let t = 0;
  for (let k = 0; k < 12; k++) {
    const m = addMonth(R.calendar.month, k), end = daysBetween(today(), addMonth(m, 1) + '-01');
    let v = 0; for (; t < Math.min(end, tr.demand.length); t++) v += tr.demand[t];
    labels.push(monLabel(m) + (k === 0 ? ' (с ' + dmShort(today()) + ')' : '')); net.push(null); rest.push(null); fc.push(Math.round(v)); inS.push(inSeason(m));
  }
  return {labels, net, rest, fc, inS};
}
function chartSales(canvas, s, tr) {
  const d = salesSeries(s, tr), C1 = css('--c-hist');
  const bands = d.inS.map((v, i) => v ? [i - 0.5, i + 0.5, css('--c-season')] : null).filter(Boolean);
  return new Chart(canvas, {type: 'bar', data: {labels: d.labels, datasets: [
    {label: 'Продажи за вычетом возвратов', data: d.net, backgroundColor: C1, stack: 'h', borderRadius: 2, barPercentage: .7},
    {label: 'Восстановленный спрос (не было остатка)', data: d.rest, backgroundColor: css('--c-restored'), stack: 'h', borderRadius: 2, barPercentage: .7},
    {label: 'Прогноз', data: d.fc, backgroundColor: 'transparent', borderColor: C1, borderWidth: 1.5, borderDash: [4, 3], stack: 'h', borderRadius: 2, barPercentage: .7}]},
    plugins: [bandsPlugin],
    options: {responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {legend: {display: true, position: 'bottom', labels: {boxWidth: 12, boxHeight: 12, color: css('--ink-2'), filter: it => !(it.datasetIndex === 1 && !d.rest.some(v => v > 0))}}, bands: {list: bands},
        tooltip: {callbacks: {label: it => it.raw == null ? null : `${it.dataset.label}: ${fmt(it.raw)} шт`}}},
      scales: {x: {type: 'category', stacked: true, grid: {display: false}, ticks: {color: css('--ink-3'), maxRotation: 0, autoSkip: true, callback(v) { const l = this.getLabelForValue(v); return l.replace(/ \(.*\)$/, ''); }}},
        y: {stacked: true, beginAtZero: true, grid: {color: css('--surface-3')}, border: {display: false}, ticks: {color: css('--ink-3'), precision: 0, callback: v => fmt(v)}}}}});
}
/* данные графиков текстом (B-59) */
function projTableHtml(s, tr) {
  const H = Math.min(tr.days, R.params.horizonDays), ms = monthStarts(H).filter(m => m.x > 0 && m.x <= H);
  const at = (arr, x) => arr ? fmt(arr[x - 1]) : '—';
  return `<details class="chart-data"><summary>Данные графика: остаток на начало месяца, шт</summary><table><thead><tr><th scope="col">Дата</th><th scope="col">Без заказа</th><th scope="col">В пути 100 %</th><th scope="col">С заказом</th><th scope="col">Страховой</th></tr></thead><tbody>
    <tr><td>${dmy(today())}</td><td>${fmt(s.stock)}</td><td>${fmt(s.stock)}</td><td>${tr.order ? fmt(s.stock) : '—'}</td><td>${fmt(tr.ss[0])}</td></tr>
    ${ms.map(m => `<tr><td>${dmy(m.m + '-01')}</td><td>${at(tr.exp.end, m.x)}</td><td>${at(tr.full.end, m.x)}</td><td>${tr.order ? at(tr.order.end, m.x) : '—'}</td><td>${fmt(tr.ss[m.x - 1])}</td></tr>`).join('')}</tbody></table></details>`;
}
function salesTableHtml(s, tr) {
  const d = salesSeries(s, tr);
  return `<details class="chart-data"><summary>Данные графика: продажи и прогноз по месяцам, шт</summary><table><thead><tr><th scope="col">Месяц</th><th scope="col">Продажи</th><th scope="col">Восстановлено</th><th scope="col">Прогноз</th></tr></thead><tbody>
    ${d.labels.map((l, i) => `<tr><td>${l}${d.inS[i] ? ' · сезон' : ''}</td><td>${d.net[i] == null ? '—' : fmt(d.net[i])}</td><td>${d.rest[i] ? fmt(d.rest[i]) : '—'}</td><td>${d.fc[i] == null ? '—' : fmt(d.fc[i])}</td></tr>`).join('')}</tbody></table></details>`;
}

/* ===== карточка позиции (L3) ===== */
const drawerCharts = [];
let drawerReturn = null, drawerSku = null;
const clearDrawerCharts = () => drawerCharts.splice(0).forEach(c => c.destroy());
function demandType(s) {
  if (s.status === 'dead') return 'нет продаж';
  const c = CAT[s.cat];
  return s.flags.new ? 'новинка' : s.flags.intermittent ? 'прерывистый спрос' : c.type === 'seasonal' ? `сезонная, ${c.season.label}` : c.type === 'moderate' ? 'умеренно сезонная' : 'ровный спрос';
}
function cardDecision(s) {
  const sup = s.sup ? ' · ' + esc(supNameOf(s.sup)) : '';
  if (inPlan(s)) return `<b>${fmt(qtyOf(s))} шт</b> до <b class="${s.decisionBy < today() ? 'warn' : ''}">${dmy(s.decisionBy)}</b>${s.decisionBy < today() ? ' (срок прошёл — разместить сейчас)' : ''}${sup} · приход ${range(s.arrival, s.arrivalP90)}`;
  if (s.status === 'blocked') return `${s.sup ? 'Поставщик не отгружает' : 'Поставщика нет в данных'}: по спросу <b>${fmt(s.qtyCalc)} шт</b> до <b class="${s.decisionBy < today() ? 'warn' : ''}">${dmy(s.decisionBy)}</b> · ${s.alt ? 'альтернатива ' + esc(s.alt.name) : 'альтернативы в данных нет'}`;
  if (s.status === 'next') return `Заказ в следующем цикле: до ${dmy(s.decisionBy)}`;
  if (s.status === 'ok') return s.orderBy ? `Заказ не нужен, следующий — до ${dmy(s.orderBy)}` : 'Заказ не нужен';
  if (s.status === 'margin') return `В заказ не идёт: наценка ${s.markup} % ниже ${R.params.minMarkup} %${s.flags.urgentPrice ? ' · по спросу нужен заказ, решить по цене' : ''}`;
  if (s.status === 'over') return `В заказ не идёт: через ${R.params.overMonths} мес останется ${fmt(s.overFrozen)} шт`;
  return `Нет продаж с ${mmyyyy(s.lastSale)}`;
}
function formulaHtml(s) {
  const q = s.qtyBreakdown, b = x => `<b>${fmt(x)}</b>`;
  if (s.status === 'dead' || s.status === 'over') return '<p class="formula">Заказ не считается: позиция вне плана.</p>';
  const lines = [];
  lines.push(`Окно ${range(q.window.from, q.window.to)} (${q.window.days} дн): спрос ${b(q.demand)} + страховой ${b(q.safetyStock)} − ожидаемый остаток на приход ${b(q.projectedAtArrival)} = ${b(q.net)}`);
  if (q.season) lines.push(`Сезонное правило, ${range(q.season.from, q.season.to)}: спрос ${b(q.season.demand)} + страховой сезона ${b(q.season.ss)} − ожидаемый остаток ${b(q.season.projectedAtArrival)} = ${b(q.season.net)}${q.rule === 'season' ? ' — больше, берём его' : ''}`);
  let tail = `Потребность ${b(q.base)}`;
  if (q.compensation) tail += ` ÷ max(доля поставки ${fmtF(q.compensation.fill)}; 0,5) = ${b(q.afterCompensation)}`;
  if (q.cut === 'noNeed') tail += ' ≤ 0 → заказ не нужен';
  else if (q.cut === 'belowHalfBatch') tail += ` < половины партии ${fmt(q.batch)} → 0, следующий цикл`;
  else tail += ` → кратно партии ${fmt(q.batch)} → <b>${fmt(q.qty)} шт</b>${s.sup ? ` → ожидаемо придёт × ${fmtF(s.fill)} = ${b(s.expectedArrivalQty)}` : ''}`;
  lines.push(tail);
  if (!inPlan(s) && q.qty) lines.push(`В план не идёт: ${STATUS[s.status].label.toLowerCase()}.`);
  if (state.edits[s.id]) lines.push(`Изменено вручную: ${fmt(state.edits[s.id].qty)} шт (${esc(state.edits[s.id].reason)}).`);
  return `<p class="formula">${lines.join('<br>')}</p>`;
}
function batchSrc(q) { return q.batchSource === 'sku' ? 'медиана приходов позиции' : q.batchSource === 'category' ? 'медиана категории' : `ограничена полугодовым прогнозом (по приходам ${fmt(q.batchHist)})`; }
/* «Почему так» без предложения про количество — оно ниже формулой */
const explainShort = s => s.explain.replace(/\s?Количество: .*?→ [\d   ]+ шт\.( С компенсацией[^.]*\.)?/, '').trim();
function openSku(id, from) {
  const s = SK[id];
  if (!s) return;
  const drawer = $('#drawer');
  $$('.pop-flt').forEach(p => { p.hidden = true; }); $$('#plan-flt').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (drawer.hidden) drawerReturn = from || document.activeElement; else clearDrawerCharts();
  drawerSku = id;
  const tr = traceOf(id);
  const f30 = tr ? Math.round(sumDays(tr.demand, 30)) : s.f30, f90 = tr ? Math.round(sumDays(tr.demand, 90)) : s.f90, f180 = tr ? Math.round(sumDays(tr.demand, 180)) : s.f180;
  const w = windowOf(s), ssF = s.ss.formula;
  $('#d-title').textContent = s.name;
  $('#d-sub').textContent = [s.id, s.catName, s.cls ? `класс ${s.cls}, сервис ${pctS(s.service)}` : null, demandType(s)].filter(Boolean).join(' · ');
  const P = (l, v) => `<dt>${l}</dt><dd>${v}</dd>`;
  $('#d-body').innerHTML = `
    <div class="decision">${statusHtml(s.status)}<span>${cardDecision(s)}</span></div>
    <dl class="facts">
      <div><dt>Остаток сегодня</dt><dd>${fmt(s.stock)}<span class="sub">на 01.${today().slice(5, 7)}: ${fmt(s.stock01)}</span></dd></div>
      <div><dt>В пути</dt><dd>${fmt(s.transit)}<span class="sub${s.transitOverdue ? ' warn' : ''}">ожидаем ${fmt(s.transitExpected)}${s.transitOverdue ? ', есть просроченный' : ''}</span></dd></div>
      <div><dt>Спрос на окно</dt><dd>${fmt(w.demand)}<span class="sub">${range(w.from, w.to)}</span></dd></div>
      <div><dt>Хватит до</dt><dd>${lastsCell(s)}</dd></div>
    </dl>
    <h3>Почему так</h3>
    <p class="explain">${esc(explainShort(s))}</p>
    <h3 class="section-h">Откуда количество</h3>
    ${formulaHtml(s)}
    <h3 class="section-h">Параметры расчёта</h3>
    <dl class="params">
      ${P('Плечо', `${s.lead.med} дн (${leadSrc(s.lead.source)}), p90 ${s.lead.p90}`)}
      ${P('Приход при заказе сегодня', range(s.arrival, s.arrivalP90))}
      ${P('Доля поставки', s.sup ? `<span class="${s.fill < 0.5 ? 'warn' : ''}">${fmtF(s.fill)}</span> · ERP ${fmtF(s.fillErp)}` : '—')}
      ${P('Прогноз 30 / 90 / 180', `${fmt(f30)} / ${fmt(f90)} / ${fmt(f180)}`)}
      ${P('Тренд год к году', s.forecast.trend ? `×${fmtF(s.forecast.trend)} (${s.forecast.trendSource === 'sku' ? 'по позиции' : s.forecast.trendSource === 'category' ? 'по категории' : 'не считается'})` : '—')}
      ${P('Страховой запас', ssF.kind === 'normal' ? esc(ssF.text) : `SS ${fmt(ssF.value)} — квантиль ${pctS(ssF.service)} месячного спроса × √(${ssF.L}/30)`)}
      ${s.restoredMonths ? P('Восстановлено', `${s.restoredMonths} мес, +${fmt(s.restoredQty)} шт`) : ''}
      ${P('Партия', `${fmt(s.batch)} (${batchSrc(s.qtyBreakdown)})`)}
      ${P('Наценка', s.markup == null ? 'нет в данных' : `<span class="${s.markup < R.params.minMarkup ? 'warn' : ''}">${s.markup} %</span>`)}
    </dl>
    <h3 class="section-h">Проекция остатка, шт</h3>
    <div class="chart" id="p-wrap">${window.Chart && tr ? '<canvas id="p-c" role="img" aria-label="Проекция остатка по дням: без заказа, с рекомендованным заказом и страховой запас. Таблица — в «Данных графика»"></canvas>' : chartOff()}</div>
    <div class="legend"><span><i class="lg season"></i>сезон категории</span><span><i class="lg deficit"></i>нет остатка (упущенный спрос)</span><span>пунктир — приход 100 %</span></div>
    ${tr ? projTableHtml(s, tr) : ''}
    <h3 class="section-h">Продажи 12 мес и прогноз 12 мес, шт</h3>
    <div class="chart" id="h-wrap">${window.Chart && tr ? '<canvas id="h-c" role="img" aria-label="Продажи по месяцам за 12 месяцев и прогноз на 12 месяцев. Таблица — в «Данных графика»"></canvas>' : chartOff()}</div>
    ${tr ? salesTableHtml(s, tr) : ''}`;
  $('#d-foot').innerHTML = `
    <button class="btn" type="button" data-act="ask" data-id="${s.id}">${icon('bot')}Спросить агента</button>
    <button class="btn" type="button" data-act="audit" data-id="${s.id}">${icon('list-plus')}В замечания</button>
    ${s.status === 'blocked' && s.alt ? `<button class="btn" type="button" data-act="move" data-id="${s.id}">${icon('arrow-right')}Перенести на ${esc(s.alt.name)}</button>` : ''}
    <span class="spacer"></span>
    ${inPlan(s) ? `<button class="btn btn-primary" type="button" data-act="qty-card" data-id="${s.id}">Изменить количество</button>` : `<span class="note">Количество меняется только у позиций в плане</span>`}`;
  $('#d-foot').onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'qty-card') { closeDrawer(true); if (state.section === 'plan') startQtyEdit(b.dataset.id); else go('plan', {query: {sku: b.dataset.id, edit: '1'}}); return; }
    if (b.dataset.act === 'ask') { closeDrawer(true); agentOpen({context: {type: 'sku', id: b.dataset.id}}); return; }
    if (b.dataset.act === 'move') { closeDrawer(); moveToAlt([b.dataset.id]); return; }
    skuAction(b.dataset.act, b.dataset.id, b);
  };
  drawer.hidden = false; $('#scrim').hidden = false;
  $('#d-body').scrollTop = 0;
  $('#d-close').focus();
  if (window.Chart && tr) {
    try { drawerCharts.push(chartProjection($('#p-c'), s, tr), chartSales($('#h-c'), s, tr)); } catch (err) { console.error(err); $('#p-wrap').innerHTML = chartOff(); }
  }
  say('Открыта карточка: ' + s.name);
}
function closeDrawer(noFocus) {
  const drawer = $('#drawer');
  if (drawer.hidden) return;
  drawer.hidden = true; $('#scrim').hidden = true;
  clearDrawerCharts();
  drawerSku = null;
  if (!noFocus && drawerReturn && document.contains(drawerReturn)) drawerReturn.focus();
  drawerReturn = null;
}

/* ===== модальное окно ===== */
let modalReturn = null, modalBusy = false;
function openModal({title, body = '', actions = [], auto = false}) {
  const wrap = $('#modal-wrap');
  if (wrap.hidden) modalReturn = document.activeElement;
  $('#modal').classList.toggle('auto', !!auto);
  $('#m-title').textContent = title;
  const b = $('#m-body');
  b.innerHTML = body;
  setModalActions(actions);
  wrap.hidden = false;
  b.scrollTop = 0;
  const first = focusables($('#m-body'))[0] || focusables($('#m-foot'))[0] || $('#m-close');
  first.focus();
}
function setModalActions(actions = []) {
  const f = $('#m-foot'); f.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn' + (a.primary ? ' btn-primary' : '');
    if (a.id) btn.id = a.id;
    btn.innerHTML = (a.icon ? icon(a.icon) : '') + esc(a.label);
    if (a.disabled) btn.disabled = true;
    btn.onclick = () => a.onClick ? a.onClick(btn) : closeModal();
    f.appendChild(btn);
  });
}
function closeModal() {
  const wrap = $('#modal-wrap');
  if (wrap.hidden || modalBusy) return;
  wrap.hidden = true; $('#m-body').innerHTML = ''; $('#m-foot').innerHTML = '';
  if (modalReturn && document.contains(modalReturn)) modalReturn.focus();
  modalReturn = null;
}

/* ===== пересчёт с параметрами и переопределениями ===== */
function currentParams() { const p = {...state.params}; if (Object.keys(state.overrides).length) p.supplierOverride = {...state.overrides}; return p; }
function recompute() {
  const prev = R;
  const res = runEngine(currentParams());
  PREV = prev;
  setResult(res);
  // правки количества переживают пересчёт, только если позиция осталась в плане
  Object.keys(state.edits).forEach(id => { if (!SK[id] || !inPlan(SK[id])) delete state.edits[id]; });
  LAST_DIFF = PREV ? Engine.diff(PREV, R) : null;
  if (LAST_DIFF) LAST_DIFF.at = RUNLOG.at;
  updateChrome();
  return res;
}
/* «Перенести на альтернативу» (B-50): run(…, {supplierOverride}) — меняются плечо, приход, количество, статус */
function moveToAlt(ids) {
  const list = ids.map(id => SK[id]).filter(s => s && s.status === 'blocked' && s.alt);
  if (!list.length) { toast('Альтернативы в данных нет — искать поставщика'); return; }
  const before = {...state.overrides};
  list.forEach(s => { state.overrides[s.id] = s.alt.id; });
  const alts = [...new Set(list.map(s => s.alt.name))];
  recompute();
  const moved = list.map(s => SK[s.id]);
  refreshSection();
  const st = moved.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
  setTimeout(() => { const u = $('#toast-undo'); if (u) u.focus(); }, 0);
  toast(`Перенос применён: ${list.length} поз. → ${alts.join(", ")}; теперь: ${Object.entries(st).map(([k, n]) => STATUS[k].label.toLowerCase() + ' ' + n).join(', ')}. Пересчитано за ${RUNLOG.ms} мс`, () => {
    state.overrides = before; recompute(); refreshSection(); toast('Перенос отменён, план пересчитан');
  });
  agentScenarioDone('move', {ids: list.map(s => s.id)});
}

/* ===== правка количества в строке плана (B-52) ===== */
const QTY_REASONS = ['Подтверждение поставщика', 'Ограничение склада', 'Бюджет', 'Добить контейнер', 'Другое'];
function startQtyEdit(id) {
  const s = SK[id];
  if (!s || !inPlan(s)) return;
  if (state.section !== 'plan') { go('plan', {query: {sku: id, edit: '1'}}); return; }
  state.plan.open.add(id);
  ensureRowVisible(id);
  renderPlanBody();
  const l2 = $(`#l2-plan-${CSS.escape(id)}`);
  if (!l2) return;
  const e = state.edits[id];
  const box = document.createElement('div');
  box.className = 'qty-form';
  box.innerHTML = `<form class="toolbar" id="qf-form" style="margin:0" novalidate>
      <span class="m-field row"><label for="qf-q">Заказать, шт</label><input type="number" id="qf-q" min="0" step="${s.batch}" value="${qtyOf(s)}" style="width:112px" aria-describedby="qf-h"></span>
      <span class="sub" id="qf-h">кратно партии ${fmt(s.batch)} · расчёт ${fmt(s.qty)}</span>
      <span class="m-field row"><label for="qf-r">Причина</label><select id="qf-r" required><option value="">выберите</option>${QTY_REASONS.map(r => `<option${e && e.reason === r ? ' selected' : ''}>${r}</option>`).join('')}</select></span>
      <button class="btn btn-primary btn-sm" type="submit">Сохранить</button>
      <button class="btn btn-sm" type="button" data-qf="cancel">Отмена</button>
      ${e ? '<button class="btn btn-quiet btn-sm" type="button" data-qf="reset">Вернуть расчёт</button>' : ''}
      <span class="sub warn" id="qf-err" role="alert"></span></form>`;
  $('.l2-body', l2).prepend(box);
  const q = $('#qf-q'); q.focus(); q.select();
  box.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); box.remove(); const btn = $(`tr.row[data-row="${CSS.escape(id)}"] .qty-btn`); if (btn) btn.focus(); } });
  $('#qf-form').onsubmit = ev => {
    ev.preventDefault();
    const v = +q.value, r = $('#qf-r').value, err = $('#qf-err');
    if (!isFinite(v) || v < 0 || q.value === '') { err.textContent = 'Введите число не меньше 0'; q.setAttribute('aria-invalid', 'true'); q.focus(); return; }
    if (v % s.batch) { err.textContent = `Нужно кратно партии ${fmt(s.batch)}: ${fmt(Math.floor(v / s.batch) * s.batch)} или ${fmt(Math.ceil(v / s.batch) * s.batch)}`; q.setAttribute('aria-invalid', 'true'); q.focus(); return; }
    if (!r) { err.textContent = 'Выберите причину правки'; $('#qf-r').focus(); return; }
    const was = qtyOf(s), before = state.edits[id];
    if (v === s.qty) delete state.edits[id]; else state.edits[id] = {qty: v, reason: r};
    afterEdit(id);
    toast(`Количество изменено: ${fmt(was)} → ${fmt(v)} шт. Итоги группы и KPI пересчитаны`, () => { if (before) state.edits[id] = before; else delete state.edits[id]; afterEdit(id); });
  };
  box.onclick = ev => {
    const b = ev.target.closest('[data-qf]'); if (!b) return;
    if (b.dataset.qf === 'reset') { delete state.edits[id]; afterEdit(id); toast('Количество возвращено к расчёту'); }
    else { box.remove(); const btn = $(`tr.row[data-row="${CSS.escape(id)}"] .qty-btn`); if (btn) btn.focus(); }
  };
}
function afterEdit(id) {
  updateChrome();
  if (state.section === 'plan') { renderPlanBody(); const btn = $(`tr.row[data-row="${CSS.escape(id)}"] .qty-btn`); if (btn) btn.focus(); }
  else refreshSection();
}

/* ===== главная ===== */
const SIGNAL_KIND = {risk: {icon: 'octagon-alert', color: '--late'}, deadline: {icon: 'calendar-clock', color: '--order'}, check: {icon: 'triangle-alert', color: '--next'}, question: {icon: 'circle-help', color: '--ink-2'}};
/* Вывод цикла — правила над результатом прогона (v6-engine §12), без литералов */
function blockedByCat() {
  const m = {};
  R.skus.filter(s => s.status === 'blocked' && s.sup).forEach(s => {
    const c = m[s.cat] || (m[s.cat] = {cat: s.cat, n: 0, qty: 0, sups: {}, alts: {}});
    c.n++; c.qty += s.qtyCalc; c.sups[s.sup] = (c.sups[s.sup] || 0) + 1; if (s.alt) c.alts[s.alt.id] = (c.alts[s.alt.id] || 0) + 1;
  });
  return Object.values(m).sort((a, b) => b.qty - a.qty);
}
/* «что даст перенос» до клика: тот же Engine.run с supplierOverride, в фоне после отрисовки главной, кэш на прогон */
const effectCache = new WeakMap();
function transferEffectLater(cat) {
  const paint = e => { const el = $('#eff-' + cat); if (el && e) el.textContent = `перенос: ${pctS(e.before)} → ${pctS(e.after)}, план +${fmt(e.dCount)} поз.`; };
  const cached = effectCache.get(R);
  if (cached && cached[cat]) { setTimeout(() => paint(cached[cat]), 0); return; }
  const base = R;
  const job = () => {
    if (R !== base) return;
    const ov = {...state.overrides}; let n = 0;
    R.skus.forEach(s => { if (s.status === 'blocked' && s.cat === cat && s.alt) { ov[s.id] = s.alt.id; n++; } });
    if (!n) return;
    const res = Engine.run(COMPACT, {...currentParams(), supplierOverride: ov});
    const rb = R.seasonReadiness.find(x => x.cat === cat), ra = res.seasonReadiness.find(x => x.cat === cat);
    if (!rb || !ra) return;
    const e = {before: rb.readiness.planFill, after: ra.readiness.planFill, dCount: res.plan.now.count - R.plan.now.count, dQty: res.plan.now.qty - R.plan.now.qty};
    const c = effectCache.get(base) || {}; c[cat] = e; effectCache.set(base, c);
    paint(e);
  };
  (window.requestIdleCallback || (f => setTimeout(f, 400)))(job, {timeout: 1500});
}

function gapSplit(cat) {
  const out = {now: 0, next: 0, blocked: 0};
  (seasonGaps()[cat] || []).forEach(g => {
    const st = g.s.status;
    if (st === 'blocked') out.blocked += g.gap;
    else if (st === 'margin' || st === 'over') out.now += g.gap;
    else { out.next += g.later; out.now += g.gap - g.later; }
  });
  return out;
}
const kQty = n => n >= 10000 ? '≈' + fmt(Math.round(n / 1000)) + ' тыс.' : fmt(n);
function gapSplitText(r) {
  const g = gapSplit(r.cat), parts = [];
  if (g.now) parts.push(`${kQty(g.now)} уже не закрыть`);
  if (g.blocked) parts.push(`${kQty(g.blocked)} ждут смены поставщика`);
  if (g.next) parts.push(`${kQty(g.next)} успеют позже`);
  return parts.length ? `разрыв ${fmt(r.gap.planFill)}: ${parts.join(' · ')}` : 'разрыва нет';
}
function readinessRowHtml(r, withBtn) {
  const need = r.need || 1, a = r.covered.transitOnly / need, b = Math.max(0, r.covered.planFill - r.covered.transitOnly) / need;
  return `<div class="rd-row">
    <div class="rd-name"><b>${esc(r.title)}</b> <span class="muted">${r.season} · нужно ${fmt(r.need)}</span></div>
    ${withBtn ? `<button class="btn btn-quiet btn-sm" type="button" data-go-season="${r.cat}" aria-label="Открыть готовность: ${esc(r.title)}">Открыть${icon('chevron-right', 14)}</button>` : '<span></span>'}
    <div class="segbar" role="img" aria-label="Есть и в пути ${pctS(a)}, заказ цикла ${pctS(b)}, разрыв ${pctS(Math.max(0, 1 - a - b))}"><i class="s-stock" style="width:${a * 100}%"></i><i class="s-plan" style="width:${b * 100}%"></i></div>
    <div class="rd-nums"><span>до заказа <b>${pctS(r.readiness.transitOnly)}</b></span><span>план 100 % <b>${pctS(r.readiness.plan100)}</b></span><span>план × доля поставки <b>${pctS(r.readiness.planFill)}</b></span></div>
    <div class="rd-gap">${gapSplitText(r)}</div>
  </div>`;
}
let homeChangesOpen = false;
function changesHtml() {
  if (!LAST_DIFF) return '<p class="disc-body">Пересчётов в этой сессии не было. После «Пересчитать» или переноса поставщика здесь появится разница двух прогонов.</p>';
  const d = LAST_DIFF, s = d.summary;
  return `<div class="disc-body"><p>Прогон ${LAST_DIFF.at ? LAST_DIFF.at.toTimeString().slice(0, 5) : ''}: изменений ${fmt(d.count)} — статус ${s.status}, срок ${s.orderBy}, количество ${s.qty}. План: ${fmt(s.planCount[0])} → ${fmt(s.planCount[1])} поз., ${fmt(s.planQty[0])} → ${fmt(s.planQty[1])} шт.</p>
    <ul>${d.items.slice(0, 12).map(x => `<li><button class="link" type="button" data-sku="${x.id}">${esc(x.text)}</button></li>`).join('')}${d.count > 12 ? `<li class="muted">и ещё ${d.count - 12} — полный список в окне «Пересчитать»</li>` : ''}</ul></div>`;
}
/* Главная: блоками, без абзацев — плитки KPI, карточки сезонов, заказы, список решений */
function signalParts(x) {
  const blockedOf = sup => R.skus.filter(s => s.status === 'blocked' && (sup ? s.sup === sup : !s.sup));
  if (x.code === 'blocked_supplier' && x.ref) { const l = blockedOf(x.ref.id); return {subj: `${supNameOf(x.ref.id)} не отгружает`, num: `${l.length} поз. · ${fmt(l.reduce((a, s) => a + s.qtyCalc, 0))} шт`}; }
  if (x.code === 'blocked_nosupplier') { const l = blockedOf(null); return {subj: 'Нет поставщика в данных', num: `${l.length} поз. · ${fmt(l.reduce((a, s) => a + s.qtyCalc, 0))} шт`}; }
  if (x.code === 'late_top' && x.ref && SK[x.ref.id]) { const s = SK[x.ref.id]; return {subj: `Больше всего теряем: ${s.name}`, num: `≈${fmt(s.lostBeforeArrival)} шт до прихода`}; }
  const t = String(x.text), k = t.indexOf(':');
  return k > 0 ? {subj: t.slice(0, k), num: t.slice(k + 1).split(/[;—]/)[0].trim()} : {subj: t, num: ''};
}
function seasonCardMini(r) {
  const blocked = R.skus.filter(s => s.status === 'blocked' && s.cat === r.cat), movable = blocked.filter(s => s.alt);
  const need = r.need || 1, a = r.covered.transitOnly / need, b = Math.max(0, r.covered.planFill - r.covered.transitOnly) / need;
  let line, act, extra = '';
  if (blocked.length && blocked.reduce((x, s) => x + s.qtyCalc, 0) > 0.1 * r.need) {
    const alt = movable.length ? SP[movable[0].alt.id] : null;
    line = `<span class="ic" style="color:var(--blocked)">${icon('ban', 16)}</span><span><b>${blocked.length} поз.</b> — поставщики не отгружают</span>`;
    act = movable.length ? `<button class="btn btn-sm" type="button" data-move-cat="${r.cat}">${icon('arrow-right', 14)}Перенести ${movable.length}</button>` : '';
    if (alt && (alt.overduePO || alt.fillSource !== 'data')) extra = `<p class="cc-note warn">${esc(alt.name)}: ${alt.overduePO ? `просрочено ${alt.overduePO} из ${alt.openPO} PO` : 'закрытых PO нет'}</p>`;
    extra += `<p class="cc-note" id="eff-${r.cat}"></p>`;
    transferEffectLater(r.cat);
  } else if (r.skus && r.skusStartBeforeArrival === r.skus && !r.started) {
    line = `<span class="ic" style="color:var(--next)">${icon('calendar-clock', 16)}</span><span>новый заказ придёт <b>${dmy(r.firstArrival)}</b>, после старта</span>`;
    act = '';
  } else if (r.orderByPassed) {
    line = `<span class="ic" style="color:var(--late)">${icon('clock-alert', 16)}</span><span>срок к сезону прошёл <b>${dmy(r.orderBy)}</b> — заказать сейчас</span>`;
    act = `<button class="btn btn-sm" type="button" data-plan-cat="${r.cat}">В план</button>`;
  } else {
    line = `<span class="ic" style="color:var(--order)">${icon('calendar-clock', 16)}</span><span>заказать к сезону до <b>${dmy(r.orderBy)}</b></span>`;
    act = `<button class="btn btn-sm" type="button" data-plan-cat="${r.cat}">В план</button>`;
  }
  return `<article class="ccard" aria-labelledby="cc-${r.cat}">
    <div class="cc-head"><h3 id="cc-${r.cat}">${esc(r.title)}</h3><span class="muted">${r.season}</span><button class="btn btn-quiet btn-sm" type="button" data-go-season="${r.cat}" aria-label="Открыть готовность: ${esc(r.title)}">${icon('chevron-right', 14)}</button></div>
    <div class="cc-big"><b>${pctS(r.readiness.planFill)}</b><span>готовность с планом</span></div>
    <div class="segbar" role="img" aria-label="Есть и в пути ${pctS(a)}, заказ цикла ${pctS(b)}"><i class="s-stock" style="width:${a * 100}%"></i><i class="s-plan" style="width:${b * 100}%"></i></div>
    <p class="cc-nums">до заказа ${pctS(r.readiness.transitOnly)} · план 100 % ${pctS(r.readiness.plan100)}</p>
    <div class="cc-line">${line}${act}</div>${extra}
  </article>`;
}
function renderHome(el) {
  const plan = planTotals(planList()), K = R.kpi, nip = K.notInPlan;
  const lost = R.skus.filter(s => s.status === 'late').reduce((a, s) => a + s.lostBeforeArrival, 0);
  const pg = planGroups(planList());
  const groups = pg.filter(g => g.key[0] !== '#').map(g => ({sup: g.key, name: supNameOf(g.key), rows: g.rows, count: g.rows.length, orderByMin: g.rows.map(s => s.decisionBy).sort()[0], arrival: isoOf(todayD() + SP[g.key].leadMed)})), top = groups.slice(0, 5);
  const supRow = g => {
    const rs = g.rows, q = rs.reduce((a, s) => a + qtyOf(s), 0);
    const passed = rs.filter(s => s.decisionBy < today()).length;
    const when = passed ? `<span class="warn">прошёл · ${passed}</span>` : dmy(g.orderByMin);
    return `<tr class="row" data-grp-go="${g.sup}"><td class="pos1"><button type="button" class="row-btn" data-grp-go="${g.sup}" title="${esc(g.name)}">${esc(g.name)}</button></td>
      <td class="num">${g.count}</td><td class="num"><b>${fmt(q)}</b></td><td class="num">${when}</td><td class="num">${dmy(g.arrival)}</td><td class="chev">${icon('chevron-right', 16)}</td></tr>`;
  };
  const sigs = R.signals.map((x, i) => {
    const k = SIGNAL_KIND[x.kind] || SIGNAL_KIND.check, p = signalParts(x);
    return `<li><button class="sig" type="button" data-sig="${i}" title="${esc(x.text)}"><span class="sig-i" style="color:var(${k.color})">${icon(k.icon, 16)}</span><span class="sig-t">${esc(p.subj)}</span><span class="sig-n">${esc(p.num)}</span>${icon('chevron-right', 14)}</button></li>`;
  }).join('');
  el.innerHTML = `<div class="home">
    <div class="tiles">
      <button class="tile tile-main" type="button" data-kpi="plan"><span class="kl">Заказать сейчас</span><span class="tv"><b>${fmt(plan.count)}</b> поз.</span><span class="k2">${fmt(plan.qty)} шт · ${tonsS(plan.tons, plan.approx)} т · придёт ≈ ${fmt(plan.expected)}</span><span class="k3">денег нет: закупочных цен в выгрузке нет (фаза 2)</span></button>
      <button class="tile" type="button" data-kpi="late"><span class="kl">Просрочено</span><span class="tv"><b class="${K.late ? 'warn' : ''}">${fmt(K.late)}</b> поз.</span><span class="k2">потери до прихода ≈ ${fmt(lost)} шт</span></button>
      <button class="tile" type="button" data-kpi="def"><span class="kl">Дефицит ≤ 90 дней</span><span class="tv"><b>${fmt(K.deficit90)}</b> поз.</span><span class="k2">остатка и в пути не хватит</span></button>
      <button class="tile" type="button" data-kpi="nip"><span class="kl">Решить вне плана</span><span class="tv"><b>${fmt(nip.margin + nip.blocked)}</b> поз.</span><span class="k2">наценка ${fmt(nip.margin)} · сменить поставщика ${fmt(nip.blocked)}</span></button>
    </div>
    <section aria-labelledby="h-seas"><div class="sec-head"><h2 id="h-seas">Сезоны: что решить в этом цикле</h2><a class="btn btn-quiet btn-sm" href="#run">Как посчитано${icon('chevron-right', 14)}</a></div>
      <div class="ccards">${R.seasonReadiness.map(seasonCardMini).join('')}</div></section>
    <div class="home-grid">
      <section class="panel" aria-labelledby="h-orders">
        <div class="panel-head"><h2 id="h-orders">Заказы по поставщикам</h2><button class="btn btn-quiet btn-sm" type="button" data-go="plan">Весь план${icon('chevron-right', 14)}</button></div>
        <div class="tbl-wrap flat"><table class="tbl home-tbl"><colgroup><col><col style="width:44px"><col style="width:72px"><col style="width:96px"><col style="width:92px"><col style="width:28px"></colgroup>
          <thead><tr><th scope="col">Поставщик</th><th class="num" scope="col">Поз.</th><th class="num" scope="col">Шт</th><th class="num" scope="col">Срок</th><th class="num" scope="col">Приход</th><th class="chev" scope="col"><span class="sr">Открыть</span></th></tr></thead>
          <tbody>${top.map(supRow).join('')}</tbody></table></div>
        <p class="note">ещё ${groups.length - top.length} ${plural(groups.length - top.length, 'поставщик', 'поставщика', 'поставщиков')} в плане</p>
      </section>
      <section class="panel" aria-labelledby="h-sig">
        <div class="panel-head"><h2 id="h-sig">Требует решения</h2></div>
        <ul class="sigs">${sigs}</ul>
      </section>
    </div>
    <section class="changes"><button class="disc-btn" type="button" id="chg-btn" aria-expanded="${homeChangesOpen}" aria-controls="chg-body">${icon('chevron-down', 16)}Что изменилось${LAST_DIFF ? ` · ${fmt(LAST_DIFF.count)}` : ''}</button><div id="chg-body"${homeChangesOpen ? '' : ' hidden'}>${changesHtml()}</div></section>
  </div>`;
  el.onclick = e => {
    const k = e.target.closest('[data-kpi]');
    if (k) { const v = k.dataset.kpi; if (v === 'plan') go('plan'); else if (v === 'late') go('plan', {query: {st: 'late'}}); else if (v === 'def') go('seasons', {sub: 'deficit'}); else go('plan', {query: {grp: '#blocked'}}); return; }
    const sg = e.target.closest('[data-sig]');
    if (sg) { signalGo(R.signals[+sg.dataset.sig]); return; }
    const mv = e.target.closest('[data-move-cat]');
    if (mv) { moveToAlt(R.skus.filter(s => s.status === 'blocked' && s.cat === mv.dataset.moveCat && s.alt).map(s => s.id)); return; }
    const pc = e.target.closest('[data-plan-cat]');
    if (pc) { go('plan', {query: {cat: pc.dataset.planCat}}); return; }
    const gg = e.target.closest('[data-grp-go]');
    if (gg) { go('plan', {query: {grp: gg.dataset.grpGo}}); return; }
    const gs = e.target.closest('[data-go-season]');
    if (gs) { go('seasons', {sub: 'ready', query: {cat: gs.dataset.goSeason}}); return; }
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    const sk = e.target.closest('[data-sku]');
    if (sk) { openSku(sk.dataset.sku, sk); return; }
    if (e.target.closest('#chg-btn')) { homeChangesOpen = !homeChangesOpen; $('#chg-btn').setAttribute('aria-expanded', String(homeChangesOpen)); $('#chg-body').hidden = !homeChangesOpen; }
  };
}
function signalGo(x) {
  if (!x) return;
  if (x.code === 'blocked_supplier' || x.code === 'blocked_nosupplier') { go('plan', {query: {grp: x.code === 'blocked_nosupplier' ? '#nosup' : '#blocked'}}); return; }
  if (x.ref && x.ref.type === 'sku') { go('plan', {query: {sku: x.ref.id}}); return; }
  if (x.ref && x.ref.type === 'supplier') { go('suppliers', {sub: x.ref.id}); return; }
  if (x.ref && x.ref.type === 'category') { go('seasons', {sub: 'ready', query: {cat: x.ref.id}}); return; }
  go(x.go || 'plan');
}

/* ===== план закупок ===== */
const PLAN_COLS_G = ['pos', 'status', 'stock', 'transit', 'window', 'lasts', 'decide', 'qty', 'chev'];
const PLAN_COLS_F = ['pos', 'status', 'stock', 'transit', 'window', 'lasts', 'decide', 'qty', 'sup', 'chev'];
const PLAN_VIEWS = {now: 'Сейчас', next: 'Следующий цикл', all: 'Все решения'};
const GROUP_TOP = 10;
const planCols = () => state.plan.bySupplier && !planFiltered() ? PLAN_COLS_G : PLAN_COLS_F;
function viewList(view) {
  if (view === 'next') return R.skus.filter(s => s.status === 'next');
  if (view === 'all') return R.skus.filter(s => inPlan(s) || s.status === 'next' || s.status === 'blocked');
  return R.skus.filter(s => inPlan(s) || s.status === 'blocked');
}
const byPriority = (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1);
function planGroups(list) {
  const m = new Map();
  list.forEach(s => {
    const key = s.status === 'blocked' ? (s.sup ? '#blocked' : '#nosup') : (s.sup || '#nosup');
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(s);
  });
  /* «хвост C» (годовой прогноз ниже порога) — внутри своей группы последним, за «ещё N» (B-26): итоги групп совпадают с ядром и поставщиками */
  const tailLast = (a, b) => (a.flags.tailC - b.flags.tailC) || byPriority(a, b);
  const gs = [...m.entries()].map(([key, rows]) => ({key, rows: rows.sort(tailLast), priority: rows.reduce((a, s) => a + s.priority, 0)}));
  return gs.sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : 1));
}
const planFiltered = () => { const P = state.plan, f = P.f; return !!(P.q.trim() || f.cat || f.cls || f.status || f.sup || f.lowFill); };
function filteredList() {
  const P = state.plan, f = P.f, q = norm(P.q);
  const base = q ? R.skus : viewList(P.view);
  return base.filter(s => {
    if (q && ![s.name, s.id, s.supName, s.catName].some(v => norm(v).includes(q))) return false;
    if (f.cat && s.cat !== f.cat) return false;
    if (f.cls && (s.cls || '—') !== f.cls) return false;
    if (f.status && s.status !== f.status) return false;
    if (f.sup && (s.sup || '#none') !== f.sup) return false;
    if (f.lowFill && !(s.sup && s.fill < 0.5)) return false;
    return true;
  }).sort((a, b) => STATUS[a.status].sort - STATUS[b.status].sort || byPriority(a, b));
}
function groupHead(g, span, open) {
  const gf = (v, l, cls = '') => `<span class="gf ${cls}">${v ? `<b>${v}</b> ` : ''}${l}</span>`;
  const rows = g.rows, t = planTotals(rows.filter(inPlan)), late = rows.filter(s => s.status === 'late').length;
  const near = rows.map(s => s.decisionBy).filter(Boolean).sort()[0];
  let name, meta, total, extra = '';
  if (g.key === '#blocked' || g.key === '#nosup') {
    const dem = rows.reduce((a, s) => a + s.qtyCalc, 0), sups = {};
    rows.forEach(s => { if (s.sup) sups[s.sup] = (sups[s.sup] || 0) + 1; });
    name = g.key === '#blocked' ? 'Сменить поставщика' : 'Без поставщика';
    meta = '';
    total = gf(fmt(rows.length), 'поз.') + gf(fmt(dem), 'шт по спросу') + gf('', 'вне итогов', 'muted');
    const movable = rows.filter(s => s.alt).length;
    if (movable) extra = `<button class="btn btn-sm" type="button" data-move-grp="${g.key}" aria-label="Перенести на альтернативу ${movable} поз. группы «${name}»">${icon('arrow-right', 14)}Перенести ${movable} поз.</button>`;
  } else if (g.key === '#tail') {
    name = 'Хвост C';
    meta = `годовой прогноз меньше ${fmt(R.params.tailCQtyYear)} шт — проверить вручную, по порядку не первые`;
    total = `<b>${rows.length} поз. · ${fmt(t.qty)} шт</b>`;
  } else {
    const S = SP[g.key];
    name = esc(supNameOf(g.key));
    meta = S && S.fill < 0.7 ? `<span class="gf warn">доля поставки ${fmtF(S.fill)}</span>` : '';
    total = gf(fmt(rows.length), 'поз.') + gf(fmt(t.qty), 'шт') + gf(tonsS(t.tons, t.approx), 'т') + `<span class="gf gf-date">приход <b>${S ? dmy(isoOf(todayD() + S.leadMed)) : '—'}</b></span>`;
  }
  const ic = g.key === '#blocked' || g.key === '#nosup' ? `<span class="grp-ic" style="color:var(--blocked)">${icon('ban', 16)}</span>` : '';
  return `<tr class="grp"><th colspan="${span}" scope="rowgroup"><div style="display:flex;align-items:center;gap:8px"><button type="button" class="grp-btn" data-grp="${g.key}" aria-expanded="${open}">${icon('chevron-down', 16)}${ic}<span class="grp-name">${name}</span><span class="grp-meta">${meta}</span><span class="grp-total">${total}</span></button>${extra}</div></th></tr>`;
}
function planTableHtml() {
  const P = state.plan, cols = planCols(), span = cols.length, o = {ctx: 'plan', editable: true};
  let body = '';
  if (planFiltered()) {
    const list = filteredList(), shown = list.slice(0, P.page);
    body = `<tbody>${list.length ? rowsHtml(shown, cols, o, P.open) : `<tr><td colspan="${span}" class="empty">По запросу «${esc(P.q || 'фильтры')}» ничего нет<button class="btn btn-sm" type="button" data-reset>Сбросить</button></td></tr>`}
      ${list.length > shown.length ? `<tr class="more"><td colspan="${span}"><button class="btn btn-ghost btn-sm" type="button" data-page>Показать ещё ${Math.min(50, list.length - shown.length)} из ${list.length - shown.length}</button></td></tr>` : ''}</tbody>`;
    return {html: colgroup(cols) + thead(cols) + body, count: list.length};
  }
  const list = viewList(P.view);
  if (!list.length) return {html: colgroup(cols) + thead(cols) + `<tbody><tr><td colspan="${span}" class="empty">${P.view === 'next' ? 'Решений в следующем цикле нет' : 'Решений нет'}</td></tr></tbody>`, count: 0};
  if (!P.bySupplier) {
    const all = list.slice().sort(byPriority), shown = all.slice(0, P.page);
    body = `<tbody>${rowsHtml(shown, cols, o, P.open)}${all.length > shown.length ? `<tr class="more"><td colspan="${span}"><button class="btn btn-ghost btn-sm" type="button" data-page>Показать ещё ${Math.min(50, all.length - shown.length)} из ${all.length - shown.length}</button></td></tr>` : ''}</tbody>`;
    return {html: colgroup(cols) + thead(cols) + body, count: list.length};
  }
  body = planGroups(list).map(g => {
    const open = P.openGroups.has(g.key), n = P.shown[g.key] || GROUP_TOP, rows = open ? g.rows.slice(0, n) : [];
    return `<tbody data-g="${g.key}">${groupHead(g, span, open)}${rowsHtml(rows, cols, o, P.open)}${open && g.rows.length > rows.length ? `<tr class="more"><td colspan="${span}"><button class="btn btn-ghost btn-sm" type="button" data-more="${g.key}">Показать ещё ${g.rows.length - rows.length}</button></td></tr>` : ''}</tbody>`;
  }).join('');
  return {html: colgroup(cols) + thead(cols) + body, count: list.length};
}
function planUnderHtml() {
  const c = R.statusCounts, urgent = R.skus.filter(s => s.flags.urgentPrice).length;
  const urgentBy = R.skus.filter(s => s.flags.urgentPrice).map(s => s.orderBy).filter(Boolean).sort()[0];
  const l = (txt, act) => `<button class="link" type="button" data-under="${act}">${txt}</button>`;
  return `В плане <b>${fmt(c.late + c.order)}</b> · ${l('следующий цикл ' + fmt(c.next), 'next')} · ${l('в норме ' + fmt(c.ok), 'ok')} · вне плана: ${l('наценка ' + fmt(c.margin), 'margin')} · ${l('сменить поставщика ' + fmt(c.blocked), 'blocked')} · ${l('избыток ' + fmt(c.over), 'over')} · ${l('мёртвые ' + fmt(c.dead), 'dead')}`;
}
function planToolbarTotal() {
  const P = state.plan;
  if (planFiltered()) return `Найдено <b>${fmt(filteredList().length)}</b>${P.q.trim() ? ` · поиск по всем ${fmt(R.skus.length)} позициям` : ''}`;
  const list = viewList(P.view).filter(inPlan), t = planTotals(list);
  return P.view === 'next' ? '' : `<b>${fmt(t.count)} поз. · ${fmt(t.qty)} шт</b>`;
}
function renderPlanBody() {
  const t = $('#plan-tbl'); if (!t) return;
  const r = planTableHtml();
  t.innerHTML = r.html;
  $('#plan-total').innerHTML = planToolbarTotal();
  $('#plan-under').innerHTML = planUnderHtml();
  const ex = $('#plan-expand'); if (ex) { const all = planAllOpen(); ex.innerHTML = icon('chevrons-up-down') + (all ? 'Свернуть всё' : 'Развернуть всё'); ex.setAttribute('aria-pressed', String(all)); ex.disabled = planFiltered() || !state.plan.bySupplier; }
  $('#plan-orders') && ($('#plan-orders').hidden = state.plan.view === 'next');
  const f = state.plan.f, n = ['cat', 'cls', 'status', 'sup'].filter(k => f[k]).length + (f.lowFill ? 1 : 0), fn = $('#plan-flt-n'); if (fn) fn.textContent = n ? ' · ' + n : '';
}
const planAllOpen = () => { const gs = planGroups(viewList(state.plan.view)); return gs.length > 0 && gs.every(g => state.plan.openGroups.has(g.key)); };
function ensureRowVisible(id) {
  const s = SK[id], P = state.plan;
  if (!s) return;
  const inView = v => viewList(v).some(x => x.id === id);
  if (!inView(P.view)) { if (inView('all')) P.view = 'all'; }
  if (!inView(P.view)) { P.q = s.id; P.f = {cat: '', cls: '', status: '', sup: '', lowFill: false}; return; }
  if (planFiltered()) { P.q = ''; P.f = {cat: '', cls: '', status: '', sup: '', lowFill: false}; }
  if (P.bySupplier) {
    const g = planGroups(viewList(P.view)).find(x => x.rows.some(r => r.id === id));
    if (g) { P.openGroups.add(g.key); const k = g.rows.findIndex(r => r.id === id); if (k >= (P.shown[g.key] || GROUP_TOP)) P.shown[g.key] = k + 1; }
  } else { const k = viewList(P.view).sort(byPriority).findIndex(r => r.id === id); if (k >= P.page) P.page = k + 1; }
}
function planSelect(name, label, opts, val) {
  return `<label class="flt"><span class="sr">${label}</span><select data-f="${name}"${name === 'cls' ? ' class="narrow"' : ''}><option value="">${label}: все</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}
function renderPlan(el) {
  const P = state.plan, Q = state.route.query || {};
  if (Q.view && PLAN_VIEWS[Q.view]) P.view = Q.view;
  if (Q.st && STATUS[Q.st]) { P.f.status = Q.st; P.q = ''; }
  if (Q.cat && CAT[Q.cat]) { P.f = {cat: Q.cat, cls: '', status: '', sup: '', lowFill: false}; P.q = ''; }
  if (Q.grp) { P.bySupplier = true; P.q = ''; P.f = {cat: '', cls: '', status: '', sup: '', lowFill: false}; if (Q.grp === '#blocked' || Q.grp === '#nosup') P.view = 'now'; P.openGroups.add(Q.grp); }
  if (Q.sku) ensureRowVisible(Q.sku);
  if (Q.sku) P.open.add(Q.sku);
  const counts = {now: viewList('now').length, next: viewList('next').length, all: viewList('all').length};
  const cats = Object.keys(CAT).map(k => [k, CAT[k].name]);
  const sups = R.suppliers.filter(s => s.skus).map(s => [s.id, s.name]).concat([['#none', 'Без поставщика']]);
  el.innerHTML = `
    <div class="toolbar" role="search">
      <div class="seg" role="group" aria-label="Вид плана">${Object.keys(PLAN_VIEWS).map(k => `<button type="button" data-view="${k}" aria-pressed="${P.view === k}">${PLAN_VIEWS[k]} <span class="cnt">${counts[k]}</span></button>`).join('')}</div>
      <label class="sr" for="plan-q">Поиск позиции</label>
      <input type="search" id="plan-q" class="search" placeholder="Поиск позиции" value="${esc(P.q)}" autocomplete="off">
      <span class="pop-wrap"><button class="btn" type="button" id="plan-flt" aria-expanded="false" aria-controls="plan-flt-pop">${icon('filter')}Фильтры<span class="cnt" id="plan-flt-n"></span></button>
        <div class="pop pop-flt left" id="plan-flt-pop" role="group" aria-label="Фильтры и вид плана" hidden>
          <label class="switch"><input type="checkbox" role="switch" id="plan-group"${P.bySupplier ? ' checked' : ''}>Группировать по поставщику</label>
          <button class="btn btn-sm" type="button" id="plan-expand" aria-pressed="false"></button>
          ${planSelect('cat', 'Категория', cats, P.f.cat)}
          ${planSelect('cls', 'ABC', [['A', 'A'], ['B', 'B'], ['C', 'C']], P.f.cls)}
          ${planSelect('status', 'Статус', Object.keys(STATUS).map(k => [k, STATUS[k].label]), P.f.status)}
          ${planSelect('sup', 'Поставщик', sups, P.f.sup)}
          <label class="switch"><input type="checkbox" role="switch" id="plan-lowfill"${P.f.lowFill ? ' checked' : ''}>Только доля поставки ниже 0,5</label>
          <button class="btn btn-quiet btn-sm" type="button" data-reset>Сбросить фильтры</button>
        </div></span>
      <span class="spacer"></span>
      <span class="total" id="plan-total"></span>
      <button class="btn btn-icon" type="button" id="plan-csv" aria-label="Экспорт CSV" title="Экспорт CSV">${icon('download', 18)}</button>
      <button class="btn btn-primary" type="button" id="plan-orders">${icon('shopping-cart')}Сформировать заказы</button>
    </div>
    <div class="tbl-wrap scroll" id="plan-wrap"><table class="tbl plan-tbl" id="plan-tbl"></table></div>
    <p class="under" id="plan-under"></p>`;
  renderPlanBody();
  const wrap = $('#plan-wrap', el);
  fitWrap(wrap, 56);
  bindRows(wrap, {openSet: P.open, cols: planCols, o: {ctx: 'plan', editable: true}});
  wrap.addEventListener('click', e => {
    const g = e.target.closest('[data-grp]');
    if (g) { const k = g.dataset.grp; if (P.openGroups.has(k)) P.openGroups.delete(k); else P.openGroups.add(k); keepFocus(wrap, renderPlanBody); return; }
    const m = e.target.closest('[data-more]');
    if (m) { const k = m.dataset.more; P.shown[k] = 1e9; renderPlanBody(); const first = $(`tbody[data-g="${CSS.escape(k)}"] .grp-btn`); if (first) first.focus(); return; }
    const pg = e.target.closest('[data-page]');
    if (pg) { P.page += 50; renderPlanBody(); return; }
    const mv = e.target.closest('[data-move-grp]');
    if (mv) { const k = mv.dataset.moveGrp; moveToAlt(viewList(P.view).filter(s => s.status === 'blocked' && (k === '#blocked' ? s.sup : !s.sup) && s.alt).map(s => s.id)); return; }
    if (e.target.closest('[data-reset]')) { resetPlanFilters(el); }
  });
  $$('[data-view]', el).forEach(b => b.onclick = () => { P.view = b.dataset.view; P.page = 50; $$('[data-view]', el).forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderPlanBody(); });
  $('#plan-group', el).onchange = e => { P.bySupplier = e.target.checked; renderPlanBody(); };
  $('#plan-expand', el).onclick = () => { const gs = planGroups(viewList(P.view)); if (planAllOpen()) { P.openGroups.clear(); P.shown = {}; } else gs.forEach(g => P.openGroups.add(g.key)); renderPlanBody(); $('#plan-expand').focus(); };
  let qt = null;
  $('#plan-q', el).oninput = e => { clearTimeout(qt); qt = setTimeout(() => { P.q = e.target.value; P.page = 50; renderPlanBody(); }, 150); };
  el.addEventListener('change', e => { const f = e.target.dataset.f; if (f) { P.f[f] = e.target.value; P.page = 50; renderPlanBody(); } });
  $('#plan-lowfill', el).onchange = e => { P.f.lowFill = e.target.checked; P.page = 50; renderPlanBody(); };
  const pop = $('#plan-flt-pop', el), fb = $('#plan-flt', el);
  const setPop = open => { pop.hidden = !open; fb.setAttribute('aria-expanded', String(open)); };
  fb.onclick = () => { setPop(pop.hidden); if (!pop.hidden) { const f = $('input,select,button', pop); if (f) f.focus(); } };
  el.addEventListener('mousedown', e => { if (!pop.hidden && !e.target.closest('#plan-flt-pop, #plan-flt')) setPop(false); });
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); setPop(false); fb.focus(); } });
  pop.addEventListener('click', e => { if (e.target.closest('[data-reset]')) resetPlanFilters(el); });
  $('#plan-csv', el).onclick = () => planCsv();
  $('#plan-orders', el).onclick = () => openOrders(null);
  $('#plan-under', el).onclick = e => {
    const b = e.target.closest('[data-under]'); if (!b) return;
    const k = b.dataset.under;
    if (k === 'next') { go('plan', {query: {view: 'next'}}); return; }
    if (k === 'blocked') { go('plan', {query: {grp: '#blocked'}}); return; }
    if (k === 'over' || k === 'dead') { go('seasons', {sub: 'over'}); return; }
    if (k === 'margin') { go('assortment'); return; }
    go('table', {query: {status: k}});
  };
  if (Q.sku) {
    const tr = $(`tr.row[data-row="${CSS.escape(Q.sku)}"]`, el);
    if (tr) { wrap.scrollTop = Math.max(0, tr.offsetTop - wrap.clientHeight / 3); const b = $('.row-btn', tr); if (b) b.focus({preventScroll: true}); }
    if (Q.edit) setTimeout(() => startQtyEdit(Q.sku), 0);
  } else if (Q.grp) { const b = $(`[data-grp="${CSS.escape(Q.grp)}"]`, el); if (b) { wrap.scrollTop = b.closest('tbody').offsetTop - 36; b.focus({preventScroll: true}); } }
}
function resetPlanFilters(el) {
  const P = state.plan; P.q = ''; P.f = {cat: '', cls: '', status: '', sup: '', lowFill: false}; P.page = 50;
  $('#plan-q', el).value = ''; $('select[data-f]', el).forEach(s => { s.value = ''; }); $('#plan-lowfill', el).checked = false;
  renderPlanBody();
}
function planCsv() {
  const P = state.plan, list = planFiltered() ? filteredList() : viewList(P.view).slice().sort(byPriority);
  const defs = PLAN_COLS_F.flatMap(k => COLS[k].csv);
  const head = [...defs.map(d => d[0]), 'Причина правки'], rows = list.map(s => [...defs.map(d => d[1](s)), state.edits[s.id] ? state.edits[s.id].reason : '']);
  const name = `plan-${P.view}-${today()}.csv`;
  exportCsv(name, head, rows);
  toast(`Файл ${name} скачан: ${list.length} поз.`);
}

/* ===== «Сформировать заказы» (B-51): окно подтверждения с составом и CSV ===== */
function openOrders(supId) {
  const list = planList().filter(s => !supId || s.sup === supId);
  const bySup = new Map();
  list.forEach(s => { if (!bySup.has(s.sup)) bySup.set(s.sup, []); bySup.get(s.sup).push(s); });
  const groups = [...bySup.entries()].map(([k, rs]) => ({k, rs, t: planTotals(rs)})).sort((a, b) => b.t.qty - a.t.qty);
  const blocked = R.skus.filter(s => s.status === 'blocked' && (!supId || s.sup === supId));
  const margin = R.skus.filter(s => s.status === 'margin' && s.flags.urgentPrice && (!supId || s.sup === supId));
  const edits = list.filter(s => state.edits[s.id]).length, tot = planTotals(list);
  const body = `<p class="m-data">Черновик заказов по плану «Сейчас». Размещение в ERP и подтверждение проформой — фаза 2; здесь — состав и CSV для поставщика.</p>
    <h3 class="m-sec">Состав: ${groups.length} ${plural(groups.length, 'поставщик', 'поставщика', 'поставщиков')}, ${fmt(tot.count)} поз., ${fmt(tot.qty)} шт, ${tonsS(tot.tons, tot.approx)} т</h3>
    <div class="tbl-wrap"><table class="res-tbl"><thead><tr><th scope="col">Поставщик</th><th class="num" scope="col">Поз.</th><th class="num" scope="col">Заказать, шт</th><th class="num" scope="col">Вес, т</th><th class="num" scope="col">Ожидаемо придёт</th><th class="num" scope="col">Приход</th></tr></thead>
    <tbody>${groups.map(g => `<tr><td>${esc(supNameOf(g.k))}<span class="sub">${g.k || ''}</span></td><td class="num">${g.rs.length}</td><td class="num">${fmt(g.t.qty)}</td><td class="num">${tonsS(g.t.tons, g.t.approx)}</td><td class="num">${fmt(g.t.expected)}</td><td class="num">${g.k && SP[g.k] ? dmy(isoOf(todayD() + SP[g.k].leadMed)) : '—'}</td></tr>`).join('')}</tbody></table></div>
    <h3 class="m-sec">Что исключено и почему</h3>
    <ul class="m-list">
      <li>Сменить поставщика: ${fmt(blocked.length)} поз. — поставщик не отгружает или его нет в данных${blocked.filter(s => s.alt).length ? `; перенос на альтернативу — в плане, группа «Сменить поставщика»` : ''}</li>
      <li>Низкая наценка со спросом к заказу: ${fmt(margin.length)} поз. — сначала решение по цене (раздел «Ассортимент и цены»)</li>
      <li>Избыток и мёртвые в заказ не входят по правилу</li>
      ${edits ? `<li>Изменено вручную: ${edits} поз. — в CSV новое количество и причина</li>` : ''}
    </ul>`;
  openModal({title: supId ? 'Сформировать заказ: ' + supNameOf(supId) : 'Сформировать заказы', body, auto: true, actions: [
    {label: 'Отмена'},
    {label: 'Скачать CSV заказов', icon: 'download', primary: true, disabled: !list.length, onClick: () => {
      const head = ['Поставщик', 'Код поставщика', 'Позиция', 'Код', 'Заказать, шт', 'Партия', 'Вес, кг', 'Ожидаемо придёт, шт', 'Желаемая отгрузка', 'Приход по плечу', 'Артикул поставщика', '№ PO', 'Причина правки'];
      const rows = groups.flatMap(g => g.rs.map(s => [supNameOf(s.sup), s.sup || '', s.name, s.id, qtyOf(s), s.batch, Math.round(qtyOf(s) * s.weightKg), Math.round(qtyOf(s) * (s.sup ? s.fill : 1)), dmy(today()), dmy(s.arrival), '', '', state.edits[s.id] ? state.edits[s.id].reason : '']));
      const name = `orders-${supId || 'all'}-${today()}.csv`;
      exportCsv(name, head, rows);
      closeModal();
      toast(`Черновик заказов: ${groups.length} ${plural(groups.length, 'поставщик', 'поставщика', 'поставщиков')}, ${fmt(tot.count)} поз. — файл ${name} скачан`);
    }}
  ]});
}

/* ===== сезоны и запасы ===== */
const SEASON_TABS = [['ready', 'Готовность к сезону'], ['deficit', 'Дефицит'], ['over', 'Избыток']];
let seasonGapCache = null;
/* разрыв сезона по позициям: та же дневная проекция, что у готовности (ожидаемо, с заказом плана × доля поставки) */
function seasonGaps() {
  if (seasonGapCache) return seasonGapCache;
  const out = {};
  R.seasonReadiness.forEach(r => {
    const a0 = Math.max(0, daysBetween(today(), r.start)), a1 = daysBetween(today(), r.end) + 1, list = [];
    R.skus.filter(s => s.cat === r.cat && s.status !== 'dead').forEach(s => {
      const tr = traceOf(s.id); if (!tr) return;
      const L = (inPlan(s) && tr.order ? tr.order : tr.exp).lost;
      /* «позже» — потери в днях, куда успеет заказ следующего цикла: t ≥ цикл + плечо (у позиции без поставщика — плечо альтернативы) */
      const cut = R.params.cycleDays + (s.status === 'blocked' && s.alt ? s.alt.leadMed : s.lead.med);
      let g = 0, late = 0; for (let t = a0; t < Math.min(a1, L.length); t++) { g += L[t]; if (t >= cut) late += L[t]; }
      if (g >= 0.5) list.push({s, gap: Math.round(g), later: Math.round(late)});
    });
    out[r.cat] = list.sort((x, y) => y.gap - x.gap);
  });
  return (seasonGapCache = out);
}
function monthsProfile(cat, maxShare, marks) {
  const c = CAT[cat], start = R.calendar.month;
  const cols = [];
  for (let k = 0; k < 12; k++) {
    const m = addMonth(start, k), mi = +m.slice(5, 7) - 1, p = c.share[mi];
    const inS = c.season && (c.season.toMonth >= c.season.fromMonth ? mi + 1 >= c.season.fromMonth && mi + 1 <= c.season.toMonth : mi + 1 >= c.season.fromMonth || mi + 1 <= c.season.toMonth);
    const peak = mi + 1 === c.peakMonth;
    cols.push(`<div class="mcol${inS ? ' in' : ''}${k === 0 ? ' now' : ''}${marks.arr === m ? ' arr' : ''}" title="${MONTHS_FULL[mi]}: ${pctS(p)} годовых продаж"><span class="mv">${peak ? pctS(p) : ''}</span><span class="mb"><i style="height:${p ? Math.max(2, Math.round(p / maxShare * 54)) : 0}px"></i></span><span class="ml">${MONTHS[mi]}</span></div>`);
  }
  const arrTxt = marks.arr ? `, приход при заказе сегодня — ${MONTHS_FULL[+marks.arr.slice(5, 7) - 1]}` : '';
  return `<div class="mchart" role="img" aria-label="Доля годовых продаж по месяцам с ${MONTHS_FULL[+start.slice(5, 7) - 1]}: пик — ${MONTHS_FULL[c.peakMonth - 1]} ${pctS(c.peakShare)}, сезон ${c.season ? c.season.label : 'нет'}${arrTxt}">${cols.join('')}</div>`;
}
function seasonCardHtml(r, maxShare) {
  const c = CAT[r.cat], gaps = seasonGaps()[r.cat] || [];
  const catSkus = R.skus.filter(s => s.cat === r.cat && s.status !== 'dead');
  const arr = r.firstArrival || catSkus.map(s => s.arrival).sort()[0];
  const fact = (l, v, sub) => `<div class="fact"><span class="fl">${l}</span><b>${v}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  const allLate = r.skus && r.skusStartBeforeArrival === r.skus;
  return `<article class="panel scard" aria-labelledby="sc-${r.cat}" id="season-${r.cat}" tabindex="-1">
    <div class="sc-head"><div class="sc-title"><h2 id="sc-${r.cat}">${esc(r.title)}</h2><span class="sub">сезон ${r.season} · ${pctS(r.share)} годовых продаж · пик — ${MONTHS_FULL[r.peakMonth - 1]} (${pctS(r.peakShare)})</span></div>
      <div class="sc-act"><button class="btn" type="button" data-fill="${r.cat}">Заполнить сезон</button><button class="btn btn-quiet" type="button" data-ask-cat="${r.cat}">${icon('bot')}Спросить агента</button></div></div>
    <div class="sc-body">
      <div>${monthsProfile(r.cat, maxShare, {arr: arr ? arr.slice(0, 7) : null})}<p class="sc-cap">доля годовых продаж по месяцам</p></div>
      <div>
        ${readinessRowHtml(r, false)}
        <div class="rd3">
          ${fact('Нужно на сезон', fmt(r.need))}
          ${fact('Есть сейчас', fmt(r.stock))}
          ${fact('В пути', fmt(r.transit))}
          ${fact('Заказ цикла', fmt(r.planQty))}
          ${fact('Заказать к сезону до', r.orderBy ? `<span class="${r.orderByPassed ? 'warn' : ''}">${dmy(r.orderBy)}</span>` : '—')}
          ${fact('Первый приход заказа', dmy(arr))}
        </div>
        ${gaps.length ? `<div class="sc-top"><h3>Больше всего не хватит после плана</h3><table><tbody>${gaps.slice(0, 5).map(g => `<tr><td><button class="link" type="button" data-sku="${g.s.id}">${esc(g.s.name)}</button><span class="sub">${statusPlain(g.s)}</span></td><td class="num">${fmt(g.gap)} шт</td></tr>`).join('')}</tbody></table></div>` : '<p class="sc-cap">Разрыва после плана нет.</p>'}
      </div></div></article>`;
}
const statusPlain = s => STATUS[s.status].label;
function seasonsReadyHtml() {
  const maxShare = Math.max(...R.seasonReadiness.map(r => Math.max(...CAT[r.cat].share)));
  const others = Object.keys(CAT).filter(k => !CAT[k].seasonal);
  const fr = state.runs.fill;
  return R.seasonReadiness.map(r => seasonCardHtml(r, maxShare) + (fr && fr.ctx.cat === r.cat ? resultPanelHtml('fill') : '')).join('') + `<section class="flatline">
    <button class="disc-btn" type="button" id="flat-btn" aria-expanded="${state.seasons.flatOpen}" aria-controls="flat-body">${icon('chevron-down', 16)}Без сезонной подготовки: ${others.map(k => CAT[k].name.toLowerCase()).join(', ')}</button>
    <div class="disc-body" id="flat-body"${state.seasons.flatOpen ? '' : ' hidden'}><ul>${others.map(k => { const c = CAT[k]; return `<li><b>${esc(c.name)}</b> — ${c.type === 'moderate' ? 'умеренно сезонная' : 'ровная'} (CV индекса ${fmtF(c.cv)}), пик — ${MONTHS[c.peakMonth - 1]} ${pctS(c.peakShare)} годовых продаж. ${c.type === 'moderate' ? 'Индекс месяца входит в прогноз, сезонного правила заказа нет.' : 'Сезонного правила нет.'}</li>`; }).join('')}</ul>
    <p>Тип спроса определяет ядро по данным: CV индекса больше ${fmtF(R.params.seasonalCV)} и окно ≥ ${pctS(R.params.seasonShare)} года не длиннее ${R.params.seasonMaxMonths} мес — сезонная.</p></div></section>`;
}
/* дефицит */
const DEF_COLS = ['lastsD', 'posN', 'status', 'supD', 'decision', 'chev'];
Object.assign(COLS, {
  lastsD: {head: 'Хватит до', w: 124, num: true, cell: s => lastsCell(s), csv: COLS.lasts.csv},
  supD: {head: 'Поставщик', w: 184, cell: s => s.sup ? `<span title="${esc(supNameOf(s.sup))}">${esc(supNameOf(s.sup))}</span><span class="sub">доля поставки ${fmtF(s.fill)}</span>` : '<span class="zero">нет в данных</span>', csv: COLS.sup.csv},
  decision: {head: 'Решение', w: 232, cell: s => {
    if (inPlan(s)) return `<button class="link" type="button" data-plan="${s.id}">Заказать ${fmt(qtyOf(s))} шт · в плане</button><span class="sub">${STATUS[s.status].label.toLowerCase()}, до ${dmy(s.decisionBy)}</span>`;
    if (s.status === 'blocked') return `<button class="link" type="button" data-plan="${s.id}">Сменить поставщика · в плане</button><span class="sub">${s.alt ? 'альтернатива ' + esc(s.alt.name) : 'альтернативы нет'}</span>`;
    if (s.status === 'next') return `<button class="link" type="button" data-plan="${s.id}">Следующий цикл · в плане</button><span class="sub">до ${dmy(s.decisionBy)}</span>`;
    if (s.status === 'margin') return 'Пересмотр цены<span class="sub">наценка ' + s.markup + ' %</span>';
    return 'Заказ не нужен';
  }, csv: [['Решение', s => decisionText(s)]]}
});
const deficitRows = () => R.skus.filter(s => s.status !== 'dead' && s.status !== 'over' && s.lastsUntil && s.lastsUntil < isoOf(todayD() + 365)).sort((a, b) => a.lastsUntil < b.lastsUntil ? -1 : a.lastsUntil > b.lastsUntil ? 1 : byPriority(a, b));
function seasonsDeficitHtml() {
  const S = state.seasons, rows = deficitRows(), lim = isoOf(todayD() + 90);
  const near = rows.filter(s => s.lastsUntil <= lim), later = rows.filter(s => s.lastsUntil > lim);
  const head = `<div class="toolbar"><div class="seg" role="group" aria-label="Вид дефицита"><button type="button" data-dv="list" aria-pressed="${S.defView === 'list'}">Список</button><button type="button" data-dv="tl" aria-pressed="${S.defView === 'tl'}">Шкала</button></div>
    <span class="total">Хватит остатка меньше чем на 90 дней: <b>${fmt(near.length)} поз.</b> · позже в пределах года ${fmt(later.length)}</span><span class="spacer"></span>
    <button class="btn" type="button" id="def-csv">${icon('download')}Экспорт CSV</button></div>`;
  if (S.defView === 'tl') return head + timelineFilteredHtml();
  const o = {ctx: 'def'}, span = DEF_COLS.length;
  const grp = (key, label, meta, open, list, shown) => `<tbody data-g="${key}"><tr class="grp"><th colspan="${span}" scope="rowgroup"><button type="button" class="grp-btn" data-dgrp="${key}" aria-expanded="${open}">${icon('chevron-down', 16)}<span class="grp-name">${label}</span><span class="grp-meta">${meta}</span><span class="grp-total"><b>${fmt(list.length)} поз.</b></span></button></th></tr>
    ${open ? rowsHtml(list.slice(0, shown), DEF_COLS, o, S.open) + (list.length > shown ? `<tr class="more"><td colspan="${span}"><button class="btn btn-ghost btn-sm" type="button" data-dmore="${key}">Показать ещё ${Math.min(50, list.length - shown)} из ${list.length - shown}</button></td></tr>` : '') : ''}</tbody>`;
  return head + `<div class="tbl-wrap scroll" id="def-wrap"><table class="tbl plan-tbl">${colgroup(DEF_COLS)}${thead(DEF_COLS)}
    ${grp('near', 'Ближайшие 90 дней', 'хватит до ' + dmy(lim) + ' включительно', true, near, S.nearShown)}
    ${grp('later', 'Позже', 'в пределах года', S.laterOpen, later, S.laterShown)}</table></div>
    <section class="flatline" style="margin-top:12px"><button class="disc-btn" type="button" id="lost-btn" aria-expanded="${S.lostOpen}" aria-controls="lost-body">${icon('chevron-down', 16)}Упущенный спрос: восстановлено ${fmt(R.lostDemand.restoredMonths)} мес, +${fmt(R.lostDemand.restoredQty)} шт</button>
    <div class="disc-body" id="lost-body"${S.lostOpen ? '' : ' hidden'}><p>${esc(lostText())}</p><p>${esc(R.lostDemand.method)}</p></div></section>`;
}
function lostText() {
  const L = R.lostDemand, by = L.byCat.slice().sort((a, b) => b.qty - a.qty);
  return `Нулевые продажи при нулевом остатке не значат, что спроса нет. Среди активных позиций за ${L.period.replace('…', '–')} месяцев без остатка ${fmt(L.monthsNoStockActive)}, из них без продаж ${fmt(L.monthsNoStockZeroSalesActive)}. Восстановлено ${fmt(L.restoredMonths)} мес, +${fmt(L.restoredQty)} шт спроса; больше всего — ${by.slice(0, 2).map(x => catName(x.cat).toLowerCase() + ' ' + fmt(x.qty)).join(', ')} шт.`;
}
/* шкала */
const tlStart = () => R.calendar.month + '-01';
const tlEnd = () => addMonth(R.calendar.month, 12) + '-01';
const tlPct = d => { const a = dnum(tlStart()), b = dnum(tlEnd()), x = typeof d === 'number' ? d : dnum(d); return Math.max(0, Math.min(100, (x - a) / (b - a) * 100)); };
function tlSeason(cat) {
  return seasonBands(cat, R.params.horizonDays).map(b => { const a = tlPct(todayD() + b[0]), c = tlPct(todayD() + b[1]); return c > a ? `<div class="season" style="left:${a}%;width:${c - a}%"></div>` : ''; }).join('');
}
function tlBars(s) {
  const T = todayD(), pt = tlPct(T);
  if (s.status === 'dead') return `<div class="notice" style="left:calc(${pt}% + 8px)">нет продаж с ${mmyyyy(s.lastSale)}</div>`;
  if (s.status === 'over') return `<div class="bar cover" style="left:${pt}%;width:${100 - pt}%"></div><div class="notice" style="left:calc(${pt}% + 8px)">заморожено ${fmt(s.overFrozen)} шт</div>`;
  let h = '';
  const end = s.lastsUntil ? dnum(s.lastsUntil) + 1 : dnum(tlEnd()), end100 = s.lastsUntil100 ? dnum(s.lastsUntil100) + 1 : dnum(tlEnd());
  if (end > T) h += `<div class="bar cover" style="left:${pt}%;width:${tlPct(end) - pt}%" title="хватит до ${lastsText(s)} (ожидаемо)"></div>`;
  if (end100 > end + 7) h += `<div class="bar cover po" style="left:${tlPct(end)}%;width:${tlPct(end100) - tlPct(end)}%" title="только если PO придёт полностью: до ${s.lastsUntil100 ? dmy(s.lastsUntil100) : '> 18 мес'}"></div>`;
  if (s.decisionBy && s.status !== 'margin') {
    const ob = dnum(s.decisionBy), late = ob < T;
    h += `<div class="flag${late ? ' late' : ''}" style="left:${tlPct(late ? T : ob)}%"><span class="fl-l">${late ? icon('clock-alert', 12) + 'срок прошёл ' + fmt(T - ob) + ' дн' : 'до ' + dmy(s.decisionBy)}</span></div>`;
  }
  const arr = dnum(s.arrival);
  if ((inPlan(s) || s.status === 'next') && s.qtyCalc > 0 && s.status !== 'blocked') {
    const q = inPlan(s) ? qtyOf(s) : s.qtyCalc;
    h += `<div class="bar transit${s.decisionBy < today() ? ' late' : ''}" style="left:${pt}%;width:${tlPct(arr) - pt}%"><span class="lbl${tlPct(arr) > 62 ? " end" : ""}">${fmt(q)} шт · ожидаемо ${fmt(Math.round(q * (s.sup ? s.fill : 1)))} · ${dmy(s.arrival)}</span></div>`;
    const ds = Math.max(end, T);
    if (ds < arr) h += `<div class="bar deficit" style="left:${tlPct(ds)}%;width:${tlPct(arr) - tlPct(ds)}%" title="дефицит с ${dmy(isoOf(ds))} до прихода ${dmy(s.arrival)}"></div>`;
  } else if (s.status === 'blocked') h += `<div class="notice" style="left:calc(${pt}% + 8px);top:30px">${s.alt ? 'перенести на ' + esc(s.alt.name) : 'искать поставщика'}</div>`;
  else if (s.status === 'margin') h += `<div class="notice" style="left:calc(${pt}% + 8px);top:30px">без заказа: наценка ${s.markup} %</div>`;
  (R.openPOs.filter(p => p.sku === s.id && p.pending > 0)).forEach(p => { h += `<div class="dia${p.expectedQty ? '' : ' ovr'}" style="left:${tlPct(p.expectedDate)}%" title="${p.po}: ${fmt(p.pending)} шт, ожидаем ${fmt(p.expectedQty)} ${dmy(p.expectedDate)}${p.state !== 'future' ? ', просрочен' : ''}"></div>`; });
  return h;
}
function timelineHtml(rows, {groupBy = null, title = 'Позиция · статус · заказать, шт'} = {}) {
  const months = [];
  for (let k = 0; k < 12; k++) { const m = addMonth(R.calendar.month, k), y = k === 0 || m.slice(5, 7) === '01'; months.push(`<div class="${y ? 'y' : ''}">${MONTHS[+m.slice(5, 7) - 1]}${y ? ' ' + m.slice(0, 4) : ''}</div>`); }
  const pt = tlPct(todayD());
  let h = `<div class="tl" id="tl" role="table" aria-label="Шкала: хватит остатка, срок заказа и приход по позициям"><div class="tl-head" role="row"><div class="l" role="columnheader">${title}</div><div class="months" role="columnheader" aria-label="Месяцы с ${MONTHS_FULL[+R.calendar.month.slice(5, 7) - 1]}">${months.join('')}<div class="today" style="left:${pt}%"></div><span class="today-lbl" style="left:${pt}%">сегодня ${dmy(today())}</span></div></div>`;
  const keys = groupBy ? [...new Set(rows.map(groupBy))] : [null];
  keys.forEach(g => {
    const rs = g === null ? rows : rows.filter(r => groupBy(r) === g);
    if (g !== null) { const S = SP[g], to = rs.filter(inPlan), q = to.reduce((a, r) => a + qtyOf(r), 0); h += `<div class="tl-group" role="row"><div class="l" role="cell">${esc(supNameOf(g))}<span>${S ? `${g} · плечо ${S.leadMed} дн · доля поставки ${fmtF(S.fill)}` : 'нет истории приходов'}</span></div><div class="r" role="cell">${to.length ? `к заказу сейчас ${to.length} поз., ${fmt(q)} шт · приход при заказе сегодня ${S ? dmy(isoOf(todayD() + S.leadMed)) : '—'}` : 'заказов в этом цикле нет'}</div></div>`; }
    rs.forEach(s => { h += `<div class="tl-row" role="row" data-tl="${s.id}"><div class="l" role="cell"><div class="id"><button type="button" class="row-btn" data-act="card" data-id="${s.id}">${esc(s.name)}</button><span class="sub">${s.id} · ${esc(s.catName)}</span></div>${statusHtml(s.status)}<div class="q">${inPlan(s) ? fmt(qtyOf(s)) : '—'}</div></div><div class="r" role="cell"><div class="grid">${'<div></div>'.repeat(12)}</div>${tlSeason(s.cat)}<div class="today" style="left:${pt}%"></div>${tlBars(s)}</div></div>`; });
  });
  return h + `</div><div class="legend tl-legend"><span><i class="lg cover"></i>хватит (ожидаемо)</span><span><i class="lg cover po"></i>только если PO придёт полностью</span><span><i class="lg deficit"></i>дефицит до прихода</span><span><i class="lg flag"></i>заказать до</span><span>${icon('clock-alert', 12)}срок прошёл</span><span><i class="lg transit"></i>заказ сегодня → приход</span><span><i class="lg dia"></i>приход открытого PO</span><span><i class="lg season"></i>сезон категории</span></div>`;
}
function timelineFilteredHtml() {
  const F = state.seasons.tl;
  const base = deficitRows();
  const rows = base.filter(s => (!F.sup || (s.sup || '#none') === F.sup) && (!F.cat || s.cat === F.cat) && (F.st === 'all' || ['late', 'order', 'next'].includes(s.status)));
  const sups = [...new Set(base.map(s => s.sup || '#none'))].map(k => [k, k === '#none' ? 'Без поставщика' : supNameOf(k)]).sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  const sel = (k, label, opts, v) => `<label class="flt"><span>${label}</span><select data-tlf="${k}">${opts.map(([a, b]) => `<option value="${esc(a)}"${a === v ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select></label>`;
  return `<div class="toolbar">${sel('st', 'Показать', [['plan', 'к решению: просрочено, заказать, следующий цикл'], ['all', 'все с дефицитом в пределах года']], F.st)}${sel('sup', 'Поставщик', [['', 'все'], ...sups], F.sup)}${sel('cat', 'Категория', [['', 'все'], ...Object.keys(CAT).map(k => [k, CAT[k].name])], F.cat)}<span class="total">на шкале <b>${fmt(rows.length)} поз.</b></span></div>
    <div id="tl-box">${rows.length ? timelineHtml(rows, {groupBy: s => s.sup || '#none'}) : '<p class="empty">Под фильтры ничего не подошло</p>'}</div>`;
}
/* избыток */
function seasonsOverHtml() {
  const E = R.excess, D = R.dead, over = R.skus.filter(s => s.status === 'over').sort((a, b) => b.overFrozen - a.overFrozen), top = over.slice(0, 20);
  const dead = R.skus.filter(s => s.status === 'dead');
  const byCat = D.byCat.map(c => ({...c, withStock: dead.filter(s => s.cat === c.cat && s.stock > 0).length}));
  return `<div class="toolbar"><span class="total">Избыток: <b>${fmt(E.count)} поз.</b>, заморожено сверх ${R.params.overMonths} мес <b>${fmt(E.frozenQty)} шт</b> · мёртвые: <b>${fmt(D.count)} поз.</b>, остаток у ${fmt(D.withStock)}, <b>${fmt(D.stockQty)} шт</b></span><span class="spacer"></span>
    <button class="btn" type="button" id="dead-csv">${icon('download')}CSV мёртвых</button><button class="btn btn-primary" type="button" id="liq-btn">Предложить ликвидацию</button></div>
    ${resultPanelHtml('liq')}
    <section class="panel" aria-labelledby="over-h"><div class="panel-head"><h2 id="over-h">Избыток: топ-${top.length} по замороженному остатку</h2>${over.length > top.length ? `<span class="muted">из ${over.length}, остальные — в сводной</span>` : ''}</div>
    <div class="tbl-wrap"><table class="tbl over-tbl"><colgroup><col><col style="width:88px"><col style="width:112px"><col style="width:112px"><col style="width:104px"><col style="width:128px"><col style="width:280px"></colgroup>
    <thead><tr><th scope="col">Позиция</th><th class="num" scope="col">Остаток</th><th class="num" scope="col">В пути, ожидаем</th><th class="num" scope="col">Прогноз, шт/мес</th><th class="num" scope="col">Покрытие, мес</th><th class="num" scope="col">Заморожено, шт</th><th scope="col">Рекомендация</th></tr></thead>
    <tbody>${top.map(s => `<tr><td class="pos"><button type="button" class="row-btn" data-act="card" data-id="${s.id}">${esc(s.name)}</button><span class="code">${s.id}</span><span class="sub">${esc(s.catName)}</span></td><td class="num">${fmt(s.stock)}</td><td class="num">${s.transitExpected ? fmt(s.transitExpected) : '<span class="zero">0</span>'}</td><td class="num">${fmt(s.perMonth)}</td><td class="num">${s.coverMonths == null ? '—' : fmt(s.coverMonths)}</td><td class="num"><b>${fmt(s.overFrozen)}</b></td><td>${liqRec(s)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="panel" aria-labelledby="dead-h" style="margin-top:12px"><div class="panel-head"><h2 id="dead-h">Мёртвые по категориям</h2></div>
    <p class="as-note">${esc(D.note)}</p>
    <div class="tbl-wrap flat"><table class="res-tbl"><thead><tr><th scope="col">Категория</th><th class="num" scope="col">Позиций</th><th class="num" scope="col">С остатком</th><th class="num" scope="col">Остаток, шт</th></tr></thead>
    <tbody>${byCat.map(c => `<tr><td>${esc(catName(c.cat))}</td><td class="num">${fmt(c.count)}</td><td class="num">${fmt(c.withStock)}</td><td class="num">${fmt(c.stockQty)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function liqRec(s) { const r = state.runs.liq; if (r && r.map && r.map[s.id]) return esc(r.map[s.id]); return s.flags.seasonal ? 'перераспределить, стоп заказа до сезона' : 'акция или перераспределение, стоп заказа'; }
function renderSeasons(el) {
  const S = state.seasons, sub = state.route.sub;
  if (sub && SEASON_TABS.some(t => t[0] === sub)) S.tab = sub;
  const draw = () => {
    killCharts();
    const body = S.tab === 'ready' ? seasonsReadyHtml() : S.tab === 'deficit' ? seasonsDeficitHtml() : seasonsOverHtml();
    el.innerHTML = `<div class="tabs" role="tablist" aria-label="Сезоны и запасы">${SEASON_TABS.map(([k, l]) => `<button type="button" role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${S.tab === k}" aria-controls="seasons-body" tabindex="${S.tab === k ? 0 : -1}">${l}</button>`).join('')}</div><div id="seasons-body" role="tabpanel" aria-labelledby="tab-${S.tab}">${body}</div>`;
    const dw = $('#def-wrap', el);
    if (dw) { fitWrap(dw, 72); bindRows(dw, {openSet: S.open, cols: DEF_COLS, o: {ctx: 'def'}, onAct: () => false}); }
  };
  draw();
  const q = state.route.query || {};
  if (S.tab === 'ready' && q.cat) { const c = $('#season-' + CSS.escape(q.cat), el); if (c) { c.scrollIntoView({block: 'start'}); c.focus({preventScroll: true}); } }
  tabKeys(el, '[role=tab]', b => { go('seasons', {sub: b.dataset.tab}); });
  el.onclick = e => {
    const t = e.target.closest('[data-tab]');
    if (t) { if (S.tab !== t.dataset.tab) go('seasons', {sub: t.dataset.tab}); return; }
    const dv = e.target.closest('[data-dv]');
    if (dv) { S.defView = dv.dataset.dv; draw(); $(`[data-dv="${S.defView}"]`, el).focus(); return; }
    const dg = e.target.closest('[data-dgrp]');
    if (dg) { if (dg.dataset.dgrp === 'later') S.laterOpen = !S.laterOpen; draw(); const b = $(`[data-dgrp="${dg.dataset.dgrp}"]`, el); if (b) b.focus(); return; }
    const dm = e.target.closest('[data-dmore]');
    if (dm) { if (dm.dataset.dmore === 'near') S.nearShown += 50; else S.laterShown += 50; draw(); return; }
    const pl = e.target.closest('[data-plan]');
    if (pl) { go('plan', {query: {sku: pl.dataset.plan}}); return; }
    const sk = e.target.closest('[data-sku]');
    if (sk) { openSku(sk.dataset.sku, sk); return; }
    const card = e.target.closest('[data-act="card"]');
    if (card && !card.closest('#def-wrap')) { openSku(card.dataset.id, card); return; }
    const fill = e.target.closest('[data-fill]');
    if (fill) { runScenario('fill', {ctx: {cat: fill.dataset.fill}}); return; }
    const ask = e.target.closest('[data-ask-cat]');
    if (ask) { agentOpen({context: {type: 'category', id: ask.dataset.askCat}}); return; }
    if (e.target.closest('#liq-btn')) { runScenario('liq'); return; }
    if (e.target.closest('#dead-csv')) { const d = R.skus.filter(s => s.status === 'dead'); exportCsv(`dead-${today()}.csv`, ['Позиция', 'Код', 'Категория', 'Последняя продажа', 'Остаток', 'Наценка', 'Флаг'], d.map(s => [s.name, s.id, s.catName, mmyyyy(s.lastSale), s.stock, s.markup == null ? '' : s.markup, ''])); toast(`Файл dead-${today()}.csv скачан: ${d.length} поз.`); return; }
    if (e.target.closest('#def-csv')) { const rows = deficitRows(), defs = ['lasts', 'pos', 'status', 'sup', 'decision'].flatMap(k => COLS[k].csv); exportCsv(`deficit-${today()}.csv`, defs.map(d => d[0]), rows.map(s => defs.map(d => d[1](s)))); toast(`Файл deficit-${today()}.csv скачан: ${rows.length} поз.`); return; }
    const tog = e.target.closest('#flat-btn, #lost-btn');
    if (tog) { const isFlat = tog.id === 'flat-btn', body = $(isFlat ? '#flat-body' : '#lost-body', el), next = body.hidden; body.hidden = !next; tog.setAttribute('aria-expanded', String(next)); if (isFlat) S.flatOpen = next; else S.lostOpen = next; }
  };
  el.onchange = e => { const k = e.target.dataset.tlf; if (k) { S.tl[k] = e.target.value; const t0 = performance.now(); draw(); const b = $(`[data-tlf="${k}"]`, el); if (b) b.focus(); RUNLOG.tlMs = Math.round(performance.now() - t0); } };
}
/* стрелки по вкладкам (B-57): ←/→, Home/End */
function tabKeys(root, sel, activate) {
  root.addEventListener('keydown', e => {
    const t = e.target.closest(sel); if (!t) return;
    const list = $$(sel, t.parentElement), i = list.indexOf(t);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length; else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = list.length - 1;
    if (j == null) return;
    e.preventDefault(); activate(list[j]);
    setTimeout(() => { const n = $$(sel, root)[j]; if (n) n.focus(); }, 0);
  });
}

/* ===== поставщики ===== */
let supSort = 'share';
const supActive = () => R.suppliers.filter(s => s.skus > 0);
function supDecide(S) { const to = R.skus.filter(s => s.sup === S.id && inPlan(s)); return {to, qty: to.reduce((a, s) => a + qtyOf(s), 0), by: to.map(s => s.decisionBy).sort()[0]}; }
function supComment(S) {
  const d = supDecide(S), parts = [];
  if (S.blocked) parts.push(S.blockReason === 'silent' ? `не отгружает: последний приход ${dmy(S.lastReceipt)}, заказы были` : `доля поставки ниже ${fmtF(R.params.blockFill)}`);
  if (S.fillSource === 'unmatched') parts.push('PO не сопоставились с приходами — доля поставки средняя'); else if (S.fillSource !== 'data') parts.push('закрытых PO мало — доля поставки сглажена к среднему');
  if (S.overduePO) parts.push(`${S.overduePO} PO просрочено — запросить подтверждение`);
  if (!S.blocked && S.fill < 0.7) parts.push('подтверждать объём проформой');
  if (d.to.length) parts.push(`к заказу ${d.to.length} поз., ${fmt(d.qty)} шт`);
  if (!parts.length) parts.push('заказов в этом цикле нет');
  return parts.join('; ');
}
function supplierListHtml() {
  const list = supActive().slice().sort((a, b) => supSort === 'fill' ? a.fill - b.fill || b.demandShare - a.demandShare : b.demandShare - a.demandShare);
  const risky = list.filter(s => s.blocked || s.fill < 0.5).reduce((a, s) => a + s.demandShare, 0);
  const rows = list.map(S => {
    const d = supDecide(S), c = supComment(S);
    return `<tr class="row" data-sup="${S.id}"><td class="pos"><button type="button" class="row-btn" data-sup="${S.id}">${esc(S.name)}</button><span class="sub">${S.id} · ${S.type === 'local' ? 'локальный' : 'импорт'}${S.blocked ? ' · <span class="warn">не отгружает</span>' : ''}</span></td>
      <td class="num">${S.skus}</td><td class="num">${pctS(S.demandShare)}</td>
      <td class="num"><span class="${S.fill < 0.5 ? 'warn' : ''}">${fmtF(S.fillReceipts)}</span><span class="sub">ERP ${fmtF(S.fillErp)}</span></td><td class="num">${S.leadMed}<span class="sub">p90 ${S.leadP90}</span></td>
      <td class="num">${fmt(S.inTransit)}<span class="sub">ожид. ${fmt(S.expected)}</span></td><td class="num">${S.overduePO ? `<span class="warn">${S.overduePO}</span>` : '0'}<span class="sub">из ${S.openPO}</span></td>
      <td class="num">${d.to.length ? `${d.to.length} поз.<span class="sub">${fmt(d.qty)} шт</span>` : '<span class="zero">—</span>'}</td><td class="num">${d.by ? `<span class="${d.by < today() ? 'warn' : ''}">${dmy(d.by)}</span>` : '<span class="zero">—</span>'}</td>
      <td class="cmt"><span class="clamp2" title="${esc(c)}">${esc(c)}</span></td><td class="chev">${icon('chevron-right', 16)}</td></tr>`;
  }).join('');
  return `<div class="toolbar"><span class="total">${list.length} поставщиков · <b>${pctS(risky)} спроса</b> у заблокированных или с долей поставки ниже 0,5</span>
      <label class="flt"><span>Сортировать</span><select id="sup-sort"><option value="share"${supSort === 'share' ? ' selected' : ''}>по доле спроса</option><option value="fill"${supSort === 'fill' ? ' selected' : ''}>по доле поставки, худшие сверху</option></select></label>
      <span class="spacer"></span><button class="btn" type="button" id="sup-supply">${icon('clipboard-check')}Оценить надёжность</button></div>
    ${resultPanelHtml('supply')}
    <div class="tbl-wrap scroll" id="sup-wrap"><table class="tbl sup-tbl"><colgroup><col style="width:232px"><col style="width:56px"><col style="width:96px"><col style="width:112px"><col style="width:76px"><col style="width:96px"><col style="width:120px"><col style="width:84px"><col style="width:104px"><col><col style="width:28px"></colgroup>
    <thead><tr><th scope="col">Поставщик</th><th class="num" scope="col">Поз.</th><th class="num" scope="col">Доля спроса</th><th class="num" scope="col" title="Доля поставки (fill rate): по сверке PO с приходами; ниже — по полю ERP">Доля поставки</th><th class="num" scope="col">Плечо, дн</th><th class="num" scope="col">В пути, шт</th><th class="num" scope="col">Просрочено PO</th><th class="num" scope="col">К заказу</th><th class="num" scope="col">Заказать до</th><th scope="col">Комментарий</th><th class="chev" scope="col"><span class="sr">Открыть</span></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function sparkSvg(byYear) {
  const pts = byYear.filter(y => y.fillRc != null);
  if (pts.length < 2) return '';
  const W = 160, H = 40, x = i => 8 + i * (W - 16) / (pts.length - 1), y = v => H - 6 - v * (H - 12);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.fillRc).toFixed(1)}`).join('');
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Доля поставки по годам: ${pts.map(p => p.year + ' — ' + fmtF(p.fillRc)).join(', ')}; порог 0,5"><line x1="0" x2="${W}" y1="${y(0.5)}" y2="${y(0.5)}" stroke="var(--line-2)" stroke-dasharray="3 3"/><path d="${path}" fill="none" stroke="var(--c-hist)" stroke-width="2"/>${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.fillRc)}" r="3" fill="var(--c-hist)"/>`).join('')}</svg>`;
}
function supplierCardHtml(k) {
  const S = SP[k], mine = R.skus.filter(s => s.sup === k), d = supDecide(S);
  const decide = mine.filter(s => inPlan(s) || s.status === 'next' || s.status === 'blocked').sort((a, b) => (a.decisionBy || '9') < (b.decisionBy || '9') ? -1 : 1);
  const shown = decide.slice(0, 60);
  const cnt = st => mine.filter(s => s.status === st).length;
  const pos = R.openPOs.filter(p => p.sup === k).sort((a, b) => b.daysLate - a.daysLate || (a.po < b.po ? -1 : 1));
  const kv = (l, v) => `<div><dt>${l}</dt><dd>${v}</dd></div>`;
  const alts = Object.keys(S.cats).map(c => {
    const others = R.suppliers.filter(o => o.id !== k && o.cats[c] && !o.blocked && o.fill >= R.params.altFillMin && o.receipts12 > 0).sort((a, b) => b.fill - a.fill);
    return `<li><b>${esc(catName(c))}</b>, ${S.cats[c]} поз.<span class="sub">альтернативы в данных: ${others.length ? others.slice(0, 3).map(o => `${esc(o.name)} (доля поставки ${fmtF(o.fill)}, плечо ${o.leadMed} дн)`).join(', ') : 'нет — искать поставщика'}</span></li>`;
  }).join('');
  const passed = d.to.filter(s => s.decisionBy < today()), rest = d.to.filter(s => s.decisionBy >= today()).map(s => s.decisionBy).sort();
  const when = [passed.length ? `<b class="warn">${passed.length} поз. — срок прошёл</b>, разместить сейчас` : '', rest.length ? `${passed.length ? 'остальные ' : ''}заказать до <b>${dmy(rest[0])}</b>` : ''].filter(Boolean).join(', ');
  const t = planTotals(d.to);
  const decision = S.blocked ? `<p class="sup-decision">${icon('ban', 16)}<span><b>Не отгружает</b>: ${S.blockReason === 'silent' ? 'приходов нет с ' + dmy(S.lastReceipt) + ' при заказах' : 'доля поставки ниже ' + fmtF(R.params.blockFill)}. ${cnt('blocked')} поз. в группе «Сменить поставщика», ожидаемый приход по его PO — 0.</span></p>`
    : d.to.length ? `<p class="sup-decision">${icon('shopping-cart', 16)}<span>К заказу сейчас: <b>${d.to.length} поз., ${fmt(t.qty)} шт, ${tonsS(t.tons, t.approx)} т</b> · ${when} · приход при заказе сегодня ${dmy(isoOf(todayD() + S.leadMed))}</span></p>`
    : `<p class="sup-decision muted">${icon('circle-check', 16)}<span>Заказов в этом цикле нет</span></p>`;
  const cr = state.runs.container;
  return `<div class="back-row"><button class="btn btn-ghost" type="button" id="sup-back">${icon('arrow-left', 14)}Все поставщики</button></div>
    <section class="panel sup-head" aria-labelledby="sup-name">
      <h2 id="sup-name">${esc(S.name)} <span class="code">${k} · ${S.type === 'local' ? 'локальный' : 'импорт'} · основная категория ${esc(catName(S.mainCat))}</span></h2>
      <p class="sup-note">${esc(S.note)}</p>
      <dl class="kvs">
        ${kv('Доля поставки (fill rate)', `<span class="${S.fill < 0.5 ? 'warn' : ''}">${fmtF(S.fillReceipts)}</span> по приходам<span class="sub">${fmtF(S.fillErp)} по полю ERP${S.fillSource === 'unmatched' ? ' · PO не сопоставились с приходами, взята средняя' : S.fillSource !== 'data' ? ' · мало PO, сглажено к среднему' : ''}</span>`)}
        ${kv('Плечо, дн', `${S.leadMed}<span class="sub">p90 ${S.leadP90} · план ${S.leadPlanMed == null ? '—' : S.leadPlanMed} · ${leadSrc(S.leadSource)}</span>`)}
        ${kv('Доля нашего спроса', pctS(S.demandShare))}
        ${kv('В пути', `${fmt(S.inTransit)} шт<span class="sub">ожидаем ${fmt(S.expected)}</span>`)}
        ${kv('Просрочено PO', `<span class="${S.overduePO ? 'warn' : ''}">${S.overduePO}</span><span class="sub">из ${S.openPO} открытых</span>`)}
      </dl>
      ${decision}
      <div class="sup-actions">
        <button class="btn btn-primary" type="button" data-sact="order"${d.to.length && !S.blocked ? '' : ' disabled aria-describedby="sup-order-why"'}>${icon('shopping-cart')}Сформировать заказ${d.to.length ? ` (${d.to.length} поз., ${fmt(d.qty)} шт)` : ''}</button>
        ${d.to.length && !S.blocked ? '' : `<span class="why" id="sup-order-why">${S.blocked ? 'поставщик не отгружает — перенос в плане, группа «Сменить поставщика»' : 'позиций к заказу нет'}</span>`}
        <button class="btn" type="button" data-sact="container">${icon('container')}Добить контейнер</button>
        ${S.openPO ? `<button class="btn" type="button" data-sact="letter">${icon('file-down')}Запросить подтверждение по открытым PO</button>` : ''}
        <button class="btn" type="button" data-sact="ask">${icon('bot')}Спросить агента</button>
      </div>
    </section>
    ${cr && cr.ctx.sup === k ? resultPanelHtml('container') : ''}
    <section class="sup-tl" aria-labelledby="sup-tl-h"><h2 id="sup-tl-h">К решению: ${decide.length} поз.${decide.length > shown.length ? `, показаны первые ${shown.length} по сроку` : ''}</h2>
      ${shown.length ? `<div id="sup-tl">${timelineHtml(shown)}</div>` : '<p class="muted">Позиций к решению нет.</p>'}
      <p class="counters">Остальные: ${['ok', 'over', 'margin', 'dead'].map(st => cnt(st) ? `<button class="link" type="button" data-sup-st="${st}">${STATUS[st].label.toLowerCase()} ${cnt(st)}</button>` : '').filter(Boolean).join(' · ') || 'нет'}</p></section>
    <section class="panel" aria-labelledby="sup-po"><h2 id="sup-po">Открытые заказы: ${pos.length}</h2>${pos.length
      ? `<div class="tbl-wrap flat"><table class="res-tbl"><thead><tr><th scope="col">PO</th><th scope="col">Позиция</th><th class="num" scope="col">В пути, шт</th><th class="num" scope="col">Заказан</th><th class="num" scope="col">Обещан</th><th scope="col">Состояние</th><th class="num" scope="col">Ожидаем × доля поставки</th></tr></thead><tbody>${pos.map(p => `<tr><td class="nw">${p.po}</td><td><button class="link" type="button" data-sku="${p.sku}">${esc(nameOf(p.sku))}</button></td><td class="num">${fmt(p.pending)}</td><td class="num">${dmy(p.ordered)}</td><td class="num">${dmy(p.promised)}</td><td>${p.state === 'future' ? 'в срок' : p.state === 'late' ? `<span class="warn">просрочен ${p.daysLate} дн</span>, подтверждён` : `<span class="warn">просрочен ${p.daysLate} дн</span>${p.confirmed ? '' : ', без подтверждения'}`}</td><td class="num">${fmt(p.expectedQty)}<span class="sub">${dmy(p.expectedDate)}</span></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Открытых заказов нет.</p>'}</section>
    <div class="sup-grid">
      <section class="panel" aria-labelledby="sup-rel"><h2 id="sup-rel">Надёжность по годам</h2>${S.byYear.length ? `<table class="years"><thead><tr><th scope="col">Год</th><th scope="col">Заказано, шт</th><th scope="col">По приходам</th><th scope="col">По полю ERP</th></tr></thead><tbody>${S.byYear.map(y => `<tr><td>${y.year}${y.year === +today().slice(0, 4) ? ' (янв–' + MONTHS[+today().slice(5, 7) - 1] + ')' : ''}</td><td>${fmt(y.ordered)}</td><td class="${y.fillRc < 0.5 ? 'warn' : ''}">${fmtF(y.fillRc)}</td><td>${fmtF(y.fillErp)}</td></tr>`).join('')}</tbody></table>${sparkSvg(S.byYear)}` : '<p class="muted">Закрытых PO в выгрузке нет: доля поставки — среднее по всем поставщикам.</p>'}
        <p class="note">Закрытые PO, приходы той же пары в окне [дата заказа; обещанная дата + ${R.params.fillWindowDays} дн]. Пунктир — порог 0,5. PO в выгрузке начинаются с 2024 года.</p></section>
      <section class="panel" aria-labelledby="sup-port"><h2 id="sup-port">Портфель и альтернативы</h2><ul class="plain">${alts}</ul></section>
    </div>`;
}
function renderSuppliers(el) {
  if (state.route.sub && !SP[state.route.sub]) history.replaceState(null, '', '#suppliers');
  const k = state.route.sub && SP[state.route.sub] ? state.route.sub : null;
  if (!k) {
    el.innerHTML = supplierListHtml();
    fitWrap($('#sup-wrap', el));
    el.onclick = e => {
      if (e.target.closest('#sup-supply')) { runScenario('supply'); return; }
      const r = e.target.closest('[data-sup]');
      if (r) go('suppliers', {sub: r.dataset.sup});
    };
    el.onchange = e => { if (e.target.id === 'sup-sort') { supSort = e.target.value; renderSuppliers(el); $('#sup-sort').focus(); } };
    const from = state.route.query && state.route.query.from; if (from) { const b = $(`button[data-sup="${CSS.escape(from)}"]`, el); if (b) { b.focus(); b.scrollIntoView({block: 'center'}); } }
    return;
  }
  el.innerHTML = supplierCardHtml(k);
  el.onchange = null;
  el.onclick = e => {
    if (e.target.closest('#sup-back')) { go('suppliers', {query: {from: k}}); return; }
    const c = e.target.closest('[data-act="card"]'); if (c) { openSku(c.dataset.id, c); return; }
    const sk = e.target.closest('[data-sku]'); if (sk) { openSku(sk.dataset.sku, sk); return; }
    const st = e.target.closest('[data-sup-st]'); if (st) { go('table', {query: {status: st.dataset.supSt, sup: k}}); return; }
    const a = e.target.closest('[data-sact]'); if (!a) return;
    const act = a.dataset.sact;
    if (act === 'order') openOrders(k);
    if (act === 'container') runScenario('container', {ctx: {sup: k}});
    if (act === 'letter') openLetter(k);
    if (act === 'ask') agentOpen({context: {type: 'supplier', id: k}, role: 'logist'});
  };
}
function openLetter(k) {
  const text = AGENT.letter(k, agentCtx());
  if (!text) { toast('Открытых заказов у поставщика нет — письмо не нужно'); return; }
  openModal({title: 'Письмо поставщику: ' + supNameOf(k), auto: true, body: `<p class="m-data">Заготовленный текст запроса подтверждения по открытым PO из выгрузки, без отправки.</p><pre class="letter" id="letter" tabindex="0">${esc(text)}</pre>`, actions: [
    {label: 'Закрыть'},
    {label: 'Скопировать текст', primary: true, onClick: () => {
      const done = () => toast('Текст письма скопирован');
      try { navigator.clipboard.writeText(text).then(done, () => toast('Выделите текст и скопируйте вручную')); } catch (e) { toast('Выделите текст и скопируйте вручную'); }
    }}]});
}

/* ===== сводная таблица: data grid с группировкой и итогами ===== */
const TBL_STORE = 'velsa-v6-table-myview';
const TGROUPS = [['pos', 'Позиция'], ['stock', 'Запасы'], ['fc', 'Прогноз'], ['dec', 'Решение'], ['eco', 'Экономика'], ['sup', 'Поставка']];
const segOf = d => d == null ? '—' : (d <= 3 ? 'эконом' : d <= 7 ? 'средний' : 'проф') + ' · ' + d;
const trendPct = s => s.forecast.trend ? Math.round((s.forecast.trend - 1) * 100) : null;
const noDecision = s => s.status === 'margin' || s.status === 'dead' || s.status === 'over';
const median = a => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const ZERO = '<span class="zero">—</span>';
/* агрегаты строк групп и итога: v — для сортировки групп, html — ячейка */
const AGG = {
  sum: f => rows => { let v = 0; rows.forEach(s => { v += f(s) || 0; }); return {v, html: v ? fmt(v) : '<span class="zero">0</span>'}; },
  med: (f, show) => rows => { const v = median(rows.map(f)); return {v, html: v == null ? ZERO : `<span class="agg">мед</span>${show(v)}`}; },
  minDate: f => rows => { let v = null; rows.forEach(s => { const d = f(s); if (d && (!v || d < v)) v = d; }); return {v, html: v ? `<span class="agg">мин</span>${v < today() ? `<span class="warn">${dmy(v)}</span>` : dmy(v)}` : ZERO}; },
  count: (pred, word, warn) => rows => { const v = rows.filter(pred).length; return {v, html: `<span class="agg">${word}</span>${v ? (warn ? `<span class="warn">${fmt(v)}</span>` : fmt(v)) : '<span class="zero">0</span>'}`}; },
  distinct: (f, word) => rows => { const v = new Set(rows.map(f).filter(Boolean)).size; return {v, html: v ? `<span class="agg">${word}</span>${fmt(v)}` : ZERO}; }
};
const fcTip = n => `Прогноз продаж на ${n} от даты данных, шт. В итогах — сумма`;
const TCOLS = {
  name: {g: 'pos', head: 'Позиция', w: 208, cls: 'pos1', tip: 'Название условное, код — из выгрузки. Клик по строке — расчёт, «Карточка» — графики',
    cell: (s, o) => `<button type="button" class="row-btn" data-act="l2" data-id="${s.id}" aria-expanded="${!!o.open}" aria-controls="l2-${o.ctx}-${s.id}" title="${esc(s.name)} · ${s.id}">${esc(s.name)}</button>`, val: s => s.name, csv: s => s.name},
  code: {g: 'pos', head: 'Код', w: 104, tip: 'Код SKU из выгрузки', cell: s => `<span class="muted">${s.id}</span>`, val: s => s.id, csv: s => s.id},
  cat: {g: 'pos', head: 'Категория', w: 124, tip: 'Категория из справочника', cell: s => esc(s.catName), val: s => s.catName, csv: s => s.catName},
  cls: {g: 'pos', head: 'Класс', w: 64, tip: () => `ABC по индексу ценности. Уровень сервиса A / B / C — ${pctS(R.params.serviceA)} / ${pctS(R.params.serviceB)} / ${pctS(R.params.serviceC)}`,
    cell: s => s.cls || '—', val: s => s.cls, csv: s => s.cls || ''},
  kind: {g: 'pos', head: 'Тип спроса', w: 168, tip: 'Тип спроса ядро определяет по истории продаж: сезонный, ровный, прерывистый, новинка', cell: s => esc(demandType(s)), val: s => demandType(s), csv: s => demandType(s)},
  stock: {g: 'stock', head: 'Остаток', w: 72, num: true, tip: 'Остаток на складе на дату данных. В итогах — сумма', cell: s => fmt(s.stock), val: s => s.stock, csv: s => s.stock, agg: AGG.sum(s => s.stock)},
  transit: {g: 'stock', head: 'В пути', w: 88, num: true, tip: 'Открытые заказы поставщику. «Ожидаем» = в пути × доля поставки; просроченные PO без подтверждения — 0. В итогах — сумма в пути',
    cell: COLS.transit.cell, val: s => s.transit, csv: s => s.transit, agg: AGG.sum(s => s.transit)},
  arrival: {g: 'stock', head: 'Приход PO', w: 104, num: true, tip: 'Обещанная дата ближайшего открытого заказа. В итогах — самая ранняя',
    cell: s => s.transitDate ? dmy(s.transitDate) + (s.transitOverdue ? '<span class="sub warn">просрочен</span>' : '') : ZERO, val: s => s.transitDate, csv: s => s.transitDate ? dmy(s.transitDate) : '', agg: AGG.minDate(s => s.transitDate)},
  lasts: {g: 'stock', head: 'Хватит до', w: 100, num: true, tip: 'Когда кончится товар с учётом ожидаемых приходов. В итогах — сколько позиций уже в дефиците',
    cell: s => lastsCell(s), val: s => s.lastsUntil || '9999', csv: s => lastsText(s), agg: AGG.count(s => s.lastsUntil && s.lastsUntil <= today(), 'дефицит', true)},
  f30: {g: 'fc', head: '30 дн', w: 68, num: true, tip: fcTip('30 дней'), cell: s => fmt(s.f30), val: s => s.f30, csv: s => s.f30, agg: AGG.sum(s => s.f30)},
  f90: {g: 'fc', head: '90 дн', w: 64, num: true, tip: fcTip('90 дней'), cell: s => fmt(s.f90), val: s => s.f90, csv: s => s.f90, agg: AGG.sum(s => s.f90)},
  f180: {g: 'fc', head: '180 дн', w: 76, num: true, tip: fcTip('180 дней'), cell: s => fmt(s.f180), val: s => s.f180, csv: s => s.f180, agg: AGG.sum(s => s.f180)},
  year: {g: 'fc', head: '12 мес', w: 80, num: true, tip: fcTip('12 месяцев'), cell: s => fmt(s.f12), val: s => s.f12, csv: s => s.f12, agg: AGG.sum(s => s.f12)},
  trend: {g: 'fc', head: 'Тренд', w: 88, num: true, tip: 'Тренд год к году с ограничением ядра. В итогах — медиана',
    cell: s => { const t = trendPct(s); return t == null ? '—' : t === 0 ? '0 %' : `<span class="trend">${icon(t > 0 ? 'trending-up' : 'trending-down', 14, t > 0 ? 'растёт' : 'падает')}</span>${t > 0 ? '+' : '−'}${Math.abs(t)} %`; },
    val: s => s.forecast.trend, csv: s => trendPct(s) == null ? '' : trendPct(s) + ' %', agg: AGG.med(trendPct, v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)) + ' %')},
  status: {g: 'dec', head: 'Статус', w: 136, tip: 'Решение ядра по позиции. В итогах — сколько к заказу: «Просрочено» и «Заказать»',
    cell: s => statusHtml(s.status), val: s => STATUS[s.status].sort, csv: s => STATUS[s.status].label, agg: AGG.count(inPlan, 'к заказу')},
  decide: {g: 'dec', head: 'Заказать до', w: 104, num: true, tip: 'Последний день, когда заказ успевает к нужной дате. В итогах — самый ранний срок',
    cell: s => decideCell(s).replace(/(к сезону \d\d\.\d\d)\.\d{4}/, '$1'), val: s => noDecision(s) ? null : s.decisionBy, csv: s => noDecision(s) ? '' : dmy(s.decisionBy), agg: AGG.minDate(s => inPlan(s) ? s.decisionBy : null)},
  qty: {g: 'dec', head: 'Заказать, шт', w: 92, num: true, tip: 'Сколько заказать в этом цикле, кратно партии. Серым — оценка вне плана. В итогах — сумма по плану',
    cell: s => qtyCell(s, false), val: s => qtyOf(s), csv: s => qtyOf(s), agg: AGG.sum(s => inPlan(s) ? qtyOf(s) : 0)},
  window: {g: 'dec', head: 'Спрос на окно, шт', w: 112, num: true, tip: 'Прогноз спроса на окно [приход; приход + цикл + покрытие] — из него считается заказ. В итогах — сумма',
    cell: COLS.window.cell, val: s => windowOf(s).demand, csv: s => windowOf(s).demand, agg: AGG.sum(s => windowOf(s).demand)},
  arriveIf: {g: 'dec', head: 'Приход при заказе', w: 112, num: true, tip: 'Дата прихода, если разместить заказ сегодня: плечо по медиане',
    cell: s => s.sup && s.qtyCalc ? dmy(s.arrival) : ZERO, val: s => s.sup && s.qtyCalc ? s.arrival : null, csv: s => s.sup && s.qtyCalc ? dmy(s.arrival) : ''},
  markup: {g: 'eco', head: 'Наценка', w: 72, num: true, tip: () => `Наценка к себестоимости. Ниже ${R.params.minMarkup} % — в пересмотр цены, не в заказ. В итогах — медиана`,
    cell: s => s.markup == null ? ZERO : s.markup < R.params.minMarkup ? `<span class="warn">${s.markup} %</span>` : s.markup + ' %', val: s => s.markup, csv: s => s.markup == null ? '' : s.markup + ' %', agg: AGG.med(s => s.markup, v => Math.round(v) + ' %')},
  segment: {g: 'eco', head: 'Ценовой сегмент', w: 124, tip: 'Ценовой дециль внутри категории: 1–3 эконом, 4–7 средний, 8–10 проф', cell: s => segOf(s.priceDecile), val: s => s.priceDecile, csv: s => segOf(s.priceDecile)},
  brand: {g: 'eco', head: 'Бренд', w: 112, tip: 'Бренд из справочника', cell: s => s.brand ? `<span class="muted">${s.brand}</span>` : '—', val: s => s.brand, csv: s => s.brand || '', agg: AGG.distinct(s => s.brand, 'брендов')},
  sup: {g: 'sup', head: 'Поставщик', w: 128, tip: 'Основной поставщик позиции. В итогах — число поставщиков', cell: COLS.sup.cell, val: s => s.sup ? supNameOf(s.sup) : null, csv: s => s.sup ? supNameOf(s.sup) : '', agg: AGG.distinct(s => s.sup, 'поставщиков')},
  fill: {g: 'sup', head: 'Доля поставки', w: 72, num: true, tip: () => `Доля поставки (fill rate): сколько из заказанного приходит, ${R.params.fillMethod === 'erp' ? 'по полю qty_received в ERP' : 'по сверке заказов с приходами'}. В итогах — медиана`,
    cell: s => s.sup ? fmtF(s.fill) : '—', val: s => s.sup ? s.fill : null, csv: s => s.sup ? fmtF(s.fill) : '', agg: AGG.med(s => s.sup ? s.fill : null, v => fmtF(v))},
  fillErp: {g: 'sup', head: 'Доля по ERP', w: 84, num: true, tip: 'Доля поставки по полю qty_received в ERP: занижена, у закрытых заказов поле часто пустое. В итогах — медиана',
    cell: s => s.sup ? fmtF(s.fillErp) : '—', val: s => s.fillErp, csv: s => s.sup ? fmtF(s.fillErp) : '', agg: AGG.med(s => s.sup ? s.fillErp : null, v => fmtF(v))},
  lead: {g: 'sup', head: 'Плечо, дн', w: 88, num: true, tip: 'Плечо поставки: медиана дней от заказа до прихода, серым — p90. В итогах — медиана',
    cell: s => `${s.lead.med}<span class="sub">p90 ${s.lead.p90}</span>`, val: s => s.lead.med, csv: s => s.lead.med, agg: AGG.med(s => s.lead.med, v => fmt(Math.round(v)))},
  batch: {g: 'sup', head: 'Партия', w: 80, num: true, tip: 'Типичная партия прихода (медиана); заказ округляется до неё', cell: s => fmt(s.batch), val: s => s.batch, csv: s => s.batch}
};
const tipOf = k => { const t = TCOLS[k].tip; return typeof t === 'function' ? t() : t; };
const TVIEWS = {
  def: {label: 'Основной', cols: ['name', 'status', 'stock', 'transit', 'lasts', 'f90', 'decide', 'qty', 'markup', 'sup', 'fill']},
  cat: {label: 'Сводка по категориям', cols: ['name', 'status', 'stock', 'transit', 'lasts', 'f90', 'year', 'window', 'qty', 'markup', 'fill'], group: 'cat'},
  supply: {label: 'Поставка', cols: ['name', 'stock', 'transit', 'arrival', 'lasts', 'qty', 'arriveIf', 'fill', 'fillErp', 'lead', 'batch'], group: 'sup'},
  fc: {label: 'Прогноз', cols: ['name', 'cat', 'kind', 'stock', 'f30', 'f90', 'f180', 'year', 'trend', 'window', 'qty']},
  eco: {label: 'Экономика', cols: ['name', 'cat', 'cls', 'markup', 'segment', 'brand', 'status', 'f90', 'year', 'trend']},
  my: {label: 'Мой вид'}
};
const TFILTERS = [
  {k: 'status', label: 'Статус', opts: () => Object.keys(STATUS).map(k => [k, STATUS[k].label]), get: s => s.status, icon: true},
  {k: 'cat', label: 'Категория', opts: () => Object.keys(CAT).map(c => [c, CAT[c].name]), get: s => s.cat},
  {k: 'sup', label: 'Поставщик', opts: () => supActive().map(s => [s.id, s.name]).sort((a, b) => a[1].localeCompare(b[1], 'ru')).concat([['#none', 'Без поставщика']]), get: s => s.sup || '#none'},
  {k: 'cls', label: 'Класс', opts: () => [['A', 'A'], ['B', 'B'], ['C', 'C'], ['—', 'Без класса']], get: s => s.cls || '—'}
];
const TGROUPBY = {
  cat: {label: 'Категория', key: s => s.cat, name: k => catName(k)},
  sup: {label: 'Поставщик', key: s => s.sup || '#none', name: k => supNameOf(k === '#none' ? null : k)},
  status: {label: 'Статус', key: s => s.status, name: k => STATUS[k].label, rank: k => STATUS[k].sort, ic: k => STATUS[k]},
  cls: {label: 'Класс', key: s => s.cls || '—', name: k => k === '—' ? 'Без класса' : 'Класс ' + k, rank: k => k === '—' ? 9 : k.charCodeAt(0)}
};
function tblLoadMine() { try { const r = localStorage.getItem(TBL_STORE); const m = r ? JSON.parse(r) : null; return m && Array.isArray(m.cols) && m.cols.length ? m : null; } catch (e) { return null; } }
function tblSaveMine(v) { try { localStorage.setItem(TBL_STORE, JSON.stringify(v)); return true; } catch (e) { return false; } }
function tblApplyView(k) {
  const T = state.table, v = k === 'my' ? tblLoadMine() : TVIEWS[k];
  if (!v) return false;
  T.cols = ['name', ...v.cols.filter(c => TCOLS[c] && c !== 'name')];
  T.group = TGROUPBY[v.group] ? v.group : null; T.dense = !!v.dense; T.sort = v.sort && TCOLS[v.sort.key] ? v.sort : null;
  T.gOpen.clear(); T.gPage = {}; T.page = 50; T.view = k; T.dirty = false;
  return true;
}
function tblInit() {
  const T = state.table;
  if (T.cols) return;
  Object.assign(T, {q: '', filters: {}, sort: null, dense: false, pop: null, page: 50, open: new Set(), gOpen: new Set(), gPage: {}, facet: 'status', fq: '', cq: '', drag: null});
  if (!tblApplyView('my')) tblApplyView('def');
}
const tblCols = () => state.table.cols.filter(k => TCOLS[k]);
const hay = new WeakMap();
const tMatch = (s, q) => { if (!q) return true; let h = hay.get(s); if (!h) { h = norm([s.name, s.id, s.supName, s.catName].join('|')); hay.set(s, h); } return h.includes(q); };
const fPass = (s, skip) => TFILTERS.every(f => f.k === skip || !(state.table.filters[f.k] || []).length || state.table.filters[f.k].includes(f.get(s)));
const cmpV = (x, y) => x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y;
function tblRows() {
  const T = state.table, q = norm(T.q);
  let rows = R.skus.filter(s => tMatch(s, q) && fPass(s));
  if (T.sort) {
    const c = TCOLS[T.sort.key], dir = T.sort.dir === 'asc' ? 1 : -1;
    rows = rows.map((s, i) => [s, i]).sort((a, b) => { const x = c.val(a[0]), y = c.val(b[0]); if (x == null || y == null) return cmpV(x, y) || a[1] - b[1]; return cmpV(x, y) * dir || a[1] - b[1]; }).map(p => p[0]);
  } else rows.sort((a, b) => STATUS[a.status].sort - STATUS[b.status].sort || ((a.decisionBy || '9') < (b.decisionBy || '9') ? -1 : (a.decisionBy || '9') > (b.decisionBy || '9') ? 1 : 0) || byPriority(a, b));
  return rows;
}
function tblGroups(rows) {
  const T = state.table, G = TGROUPBY[T.group], map = new Map();
  rows.forEach(s => { const k = G.key(s); if (!map.has(k)) map.set(k, []); map.get(k).push(s); });
  const list = [...map].map(([key, rs]) => ({key, name: G.name(key), rows: rs}));
  const sk = T.sort && T.sort.key, dir = T.sort && T.sort.dir === 'asc' ? 1 : -1;
  if (sk === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'ru') * dir);
  else if (sk && TCOLS[sk].agg) { list.forEach(g => { g.sv = TCOLS[sk].agg(g.rows).v; }); list.sort((a, b) => (a.sv == null || b.sv == null ? cmpV(a.sv, b.sv) : cmpV(a.sv, b.sv) * dir) || a.name.localeCompare(b.name, 'ru')); }
  else if (G.rank) list.sort((a, b) => G.rank(a.key) - G.rank(b.key));
  else { list.forEach(g => { g.q = g.rows.reduce((a, s) => a + (inPlan(s) ? qtyOf(s) : 0), 0); }); list.sort((a, b) => b.q - a.q || b.rows.length - a.rows.length || a.name.localeCompare(b.name, 'ru')); }
  return list;
}
/* строка позиции — та же модель, что в плане: клик по строке = раскрытие, «Карточка» в раскрытии */
function tRow(s, cols, open) {
  const o = {ctx: 'tbl', open};
  return `<tr class="row${open ? ' open' : ''}" data-row="${s.id}">${cols.map(k => { const c = TCOLS[k]; return `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.cell(s, o)}</td>`; }).join('')}</tr>` + (open ? rowL2(s, cols.length, o) : '');
}
const aggCells = (rows, cols) => cols.slice(1).map(k => { const c = TCOLS[k]; return c.agg ? `<td class="${c.num ? 'num' : ''}">${c.agg(rows).html}</td>` : '<td></td>'; }).join('');
function grpHtml(g, cols) {
  const T = state.table, open = T.gOpen.has(g.key), G = TGROUPBY[T.group], ic = G.ic ? G.ic(g.key) : null, n = T.gPage[g.key] || 50;
  let h = `<tr class="tgrp${open ? ' open' : ''}" data-grp="${esc(g.key)}"><td class="pos1"><button type="button" class="tg-btn" data-gtoggle="${esc(g.key)}" aria-expanded="${open}">${icon('chevron-right', 16)}${ic ? `<span class="ic" style="color:var(${ic.color})">${icon(ic.icon, 16)}</span>` : ''}<span class="tg-name">${esc(g.name)}</span><span class="tg-n">${fmt(g.rows.length)}<span class="sr"> поз.</span></span></button></td>${aggCells(g.rows, cols)}</tr>`;
  if (!open) return h;
  h += g.rows.slice(0, n).map(s => tRow(s, cols, T.open.has(s.id))).join('');
  if (g.rows.length > n) h += `<tr class="gmore"><td colspan="${cols.length}"><button class="btn btn-sm btn-quiet" type="button" data-gmore="${esc(g.key)}">Показать ещё ${Math.min(50, g.rows.length - n)} из ${fmt(g.rows.length - n)}</button></td></tr>`;
  return h;
}
function tblHead(cols) {
  const T = state.table;
  return '<thead><tr>' + cols.map(k => { const c = TCOLS[k], on = T.sort && T.sort.key === k, aria = on ? (T.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${aria}"><button type="button" class="th-sort" data-sort="${k}" data-tip="${esc(tipOf(k))}" aria-describedby="tcd-${k}">${c.head}${on ? `<span class="sortic ${T.sort.dir}">${icon('chevron-down', 12)}</span>` : ''}</button></th>`; }).join('') + '</tr></thead>';
}
function tblBodyHtml(rows, cols) {
  const T = state.table;
  if (!rows.length) return `<tr><td colspan="${cols.length}" class="empty">${T.q ? `По запросу «${esc(T.q)}» ничего нет` : 'Под фильтры ничего не подошло'}<button class="btn btn-sm" type="button" data-treset>Сбросить</button></td></tr>`;
  if (T.group) return tblGroups(rows).map(g => grpHtml(g, cols)).join('');
  return rows.slice(0, T.page).map(s => tRow(s, cols, T.open.has(s.id))).join('');
}
function tblFootHtml(rows, cols) { return rows.length ? `<tfoot><tr class="tot"><th scope="row" class="pos1">Итого<span class="muted">${fmt(rows.length)} поз.</span></th>${aggCells(rows, cols)}</tr></tfoot>` : ''; }
function tblPagerHtml(rows) {
  const T = state.table;
  if (!rows.length) return '';
  if (T.group) { const g = new Set(rows.map(TGROUPBY[T.group].key)).size; return `<span>${fmt(g)} ${plural(g, 'группа', 'группы', 'групп')} · ${fmt(rows.length)} поз.</span>${T.gOpen.size ? '<button class="btn btn-sm" type="button" data-gcollapse>Свернуть все</button>' : ''}`; }
  const n = Math.min(T.page, rows.length);
  return `<span>1–${fmt(n)} из ${fmt(rows.length)}</span>${rows.length > n ? `<button class="btn btn-sm" type="button" data-tmore>Показать ещё ${Math.min(50, rows.length - n)}</button>` : ''}`;
}
const optName = (f, v) => (f.opts().find(o => o[0] === v) || [v, v])[1];
function chipsHtml() {
  const T = state.table, act = TFILTERS.filter(f => (T.filters[f.k] || []).length);
  if (!act.length) return '';
  return act.map(f => { const names = T.filters[f.k].map(v => optName(f, v)), label = `${f.label}: ${names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(', ')}`;
    return `<span class="fchip"><button type="button" class="fchip-b" data-chip="${f.k}" title="${esc(names.join(', '))}">${esc(label)}</button><button type="button" class="fchip-x" data-clear="${f.k}" aria-label="Снять фильтр «${f.label}»">${icon('x', 14)}</button></span>`; }).join('')
    + '<button class="btn btn-quiet btn-sm" type="button" data-treset>Сбросить всё</button>';
}
function facetCounts(f) { const T = state.table, q = norm(T.q), c = {}; R.skus.forEach(s => { if (tMatch(s, q) && fPass(s, f.k)) { const v = f.get(s); c[v] = (c[v] || 0) + 1; } }); return c; }
const pressMark = on => on ? icon('check', 14) : '<span class="ck-sp"></span>';
function popHtml(name) {
  const T = state.table;
  if (name === 'flt') {
    const f = TFILTERS.find(x => x.k === T.facet) || TFILTERS[0], sel = T.filters[f.k] || [], counts = facetCounts(f), nq = norm(T.fq), all = f.opts(), any = TFILTERS.some(x => (T.filters[x.k] || []).length);
    const list = all.filter(([, l]) => !nq || norm(l).includes(nq)).map(([v, l]) => `<label class="chk${counts[v] ? '' : ' none'}"><input type="checkbox" name="f-${f.k}" data-fv="${f.k}" value="${esc(v)}"${sel.includes(v) ? ' checked' : ''}>${f.icon && STATUS[v] ? `<span class="ic" style="color:var(${STATUS[v].color})">${icon(STATUS[v].icon, 14)}</span>` : ''}<span class="chk-l">${esc(l)}</span><span class="chk-n">${fmt(counts[v] || 0)}</span></label>`).join('') || '<p class="pop-empty">Ничего не найдено</p>';
    return `<div class="pop pop-ff left" role="dialog" aria-label="Фильтры"><div class="ff-nav" role="group" aria-label="Поле фильтра">${TFILTERS.map(x => { const n = (T.filters[x.k] || []).length; return `<button type="button" class="ff-tab" data-facet="${x.k}" aria-pressed="${x.k === f.k}">${x.label}${n ? `<span class="cnt">${n}<span class="sr"> выбрано</span></span>` : ''}</button>`; }).join('')}</div>`
      + `<div class="ff-pane">${all.length > 8 ? `<input type="search" name="f-q" data-fq value="${esc(T.fq)}" placeholder="Найти" aria-label="Найти в фильтре «${f.label}»">` : ''}<div class="ff-list" role="group" aria-label="${f.label}">${list}</div></div>`
      + (any ? '<div class="ff-foot"><button class="btn btn-quiet btn-sm" type="button" data-treset>Снять все фильтры</button></div>' : '') + '</div>';
  }
  if (name === 'grp') return `<div class="pop pop-opts left" role="dialog" aria-label="Группировка">${[['', 'Без группировки'], ...Object.entries(TGROUPBY).map(([k, g]) => [k, g.label])].map(([k, l]) => `<button type="button" class="chk opt" data-gpick="${k}" aria-pressed="${(T.group || '') === k}">${pressMark((T.group || '') === k)}${l}</button>`).join('')}</div>`;
  if (name === 'view') { const mine = tblLoadMine(); return `<div class="pop pop-opts" role="dialog" aria-label="Вид">${Object.keys(TVIEWS).map(k => `<button type="button" class="chk opt" data-view-pick="${k}" aria-pressed="${T.view === k}"${k === 'my' && !mine ? ' disabled' : ''}>${pressMark(T.view === k)}${TVIEWS[k].label}${k === 'my' && !mine ? '<span class="chk-n">не сохранён</span>' : ''}</button>`).join('')}<div class="pv-sep"></div><label class="chk"><input type="checkbox" name="dense" data-dense${T.dense ? ' checked' : ''}>Плотные строки</label></div>`; }
  if (name === 'cols') {
    const vis = tblCols(), nq = norm(T.cq), all = Object.keys(TCOLS);
    const item = (k, drag) => `<li class="pc-item" data-ck="${k}"${drag ? ' draggable="true"' : ''}>${drag ? `<button type="button" class="pc-grip" data-move="${k}" aria-label="Порядок колонки «${TCOLS[k].head}»: стрелки вверх и вниз" data-tip="Перетащите или двигайте стрелками">${icon('grip-vertical', 16)}</button>` : '<span class="pc-sp"></span>'}<label class="chk"><input type="checkbox" name="col" data-col="${k}"${vis.includes(k) ? ' checked' : ''}>${TCOLS[k].head}</label></li>`;
    const sec = (id, label, items) => items ? `<p class="pc-sec" id="pcs-${id}">${label}</p><ul aria-labelledby="pcs-${id}">${items}</ul>` : '';
    let body;
    if (nq) body = sec('q', 'Найдено', all.filter(k => k !== 'name' && norm(TCOLS[k].head).includes(nq)).map(k => item(k, false)).join('')) || '<p class="pop-empty">Такой колонки нет</p>';
    else body = sec('on', 'Показаны', `<li class="pc-item pinned"><span class="pc-sp">${icon('lock', 14)}</span><span class="chk">${TCOLS.name.head}<span class="sr"> — закреплена первой</span></span></li>` + vis.slice(1).map(k => item(k, true)).join(''))
      + TGROUPS.map(([g, l]) => sec(g, l, all.filter(k => TCOLS[k].g === g && !vis.includes(k)).map(k => item(k, false)).join(''))).join('');
    return `<div class="pop pop-cols left" role="dialog" aria-label="Колонки"><div class="pc-head"><input type="search" name="col-q" data-cq value="${esc(T.cq)}" placeholder="Найти колонку" aria-label="Найти колонку"><span class="pc-n">${vis.length} из ${all.length}</span></div><div class="pc-list">${body}</div>`
      + `<div class="pc-foot"><button class="btn btn-quiet btn-sm" type="button" data-col-reset${T.dirty ? '' : ' disabled'}>Сбросить</button><span class="spacer"></span><button class="btn btn-sm" type="button" data-save-view>${icon('save', 14)}Сохранить вид</button></div></div>`;
  }
  return '';
}
const POPKEYS = ['data-fv', 'data-facet', 'data-col', 'data-move', 'data-fq', 'data-cq', 'data-view-pick', 'data-gpick', 'data-dense', 'data-col-reset', 'data-save-view', 'data-treset'];
function renderTable(el) {
  tblInit();
  const T = state.table, Q = state.route.query || {};
  if (Q.status && STATUS[Q.status]) { T.filters = {status: [Q.status]}; if (Q.sup) T.filters.sup = [Q.sup]; T.q = ''; T.page = 50; }
  el.innerHTML = `<div class="toolbar t-bar">
      <label class="sr" for="tbl-q">Поиск по названию, коду, поставщику и категории</label>
      <input type="search" id="tbl-q" class="search" placeholder="Название, код, поставщик" value="${esc(T.q)}" autocomplete="off">
      <span class="pop-wrap"><button class="btn" type="button" data-pop="flt" aria-expanded="false" aria-haspopup="dialog"></button></span>
      <span class="pop-wrap"><button class="btn" type="button" data-pop="grp" aria-expanded="false" aria-haspopup="dialog"></button></span>
      <span class="pop-wrap"><button class="btn" type="button" data-pop="cols" aria-expanded="false" aria-haspopup="dialog"></button></span>
      <span class="spacer"></span>
      <span class="pop-wrap"><button class="btn" type="button" data-pop="view" aria-expanded="false" aria-haspopup="dialog"></button></span>
      <button class="btn" type="button" id="tbl-csv" data-tip="Текущие строки и колонки, для Excel">${icon('download')}CSV</button>
    </div>
    <div class="chips" id="t-chips"></div>
    <div class="tbl-wrap scroll" id="t-wrap"><table class="tbl t-tbl" id="t-tbl"></table><div class="pager" id="t-pager"></div></div>
    <div hidden>${Object.keys(TCOLS).map(k => `<span id="tcd-${k}">${esc(tipOf(k))}</span>`).join('')}</div>`;
  const wrap = $('#t-wrap', el), tbl = $('#t-tbl', el);
  const bar = () => {
    const nf = TFILTERS.filter(f => (T.filters[f.k] || []).length).length, b = k => $(`[data-pop="${k}"]`, el);
    b('flt').innerHTML = `${icon('filter')}Фильтры${nf ? `<span class="cnt">${nf}</span>` : ''}`; b('flt').classList.toggle('is-on', !!nf);
    b('grp').innerHTML = `${icon('list-tree')}${T.group ? 'Группа: ' + TGROUPBY[T.group].label.toLowerCase() : 'Группировать'}`; b('grp').classList.toggle('is-on', !!T.group);
    b('cols').innerHTML = `${icon('columns-3')}Колонки<span class="cnt">${tblCols().length}</span>`;
    b('view').innerHTML = `Вид: ${TVIEWS[T.view].label}${T.dirty ? '<span class="cnt">изменён</span>' : ''}${icon('chevron-down', 14)}`;
  };
  /* одна перерисовка на любое действие: таблица ≤ 50 строк на страницу или группы свёрнуты (бюджет 60 мс) */
  const draw = () => {
    const t0 = performance.now(), cols = tblCols(), rows = tblRows();
    tbl.className = `tbl t-tbl${T.dense ? ' dense' : ''}${T.group ? ' grouped' : ''}`;
    tbl.style.minWidth = cols.reduce((a, k) => a + TCOLS[k].w, 0) + 'px';
    tbl.innerHTML = `<colgroup>${cols.map(k => `<col style="width:${TCOLS[k].w}px">`).join('')}</colgroup>${tblHead(cols)}<tbody id="t-body">${tblBodyHtml(rows, cols)}</tbody>${tblFootHtml(rows, cols)}`;
    $('#t-pager', el).innerHTML = tblPagerHtml(rows);
    const ch = $('#t-chips', el), h = chipsHtml(); ch.innerHTML = h; ch.hidden = !h; fitWrap(wrap);
    bar();
    RUNLOG.tableMs = Math.round(performance.now() - t0);
  };
  const focusSel = sel => { const b = $(sel, el); if (b) b.focus(); return b; };
  const closePop = focusBack => { const p = $('.pop', el); if (p) p.remove(); const n = T.pop; T.pop = null; $$('[data-pop]', el).forEach(b => b.setAttribute('aria-expanded', 'false')); if (focusBack && n) focusSel(`[data-pop="${n}"]`); };
  const openPop = name => {
    closePop();
    const btn = $(`[data-pop="${name}"]`, el); T.pop = name; btn.setAttribute('aria-expanded', 'true');
    btn.closest('.pop-wrap').insertAdjacentHTML('beforeend', popHtml(name));
    const p = $('.pop', el), first = name === 'flt' ? $('[data-facet][aria-pressed="true"]', p) : name === 'cols' ? $('[data-cq]', p) : $('[aria-pressed="true"]', p) || $('button:not([disabled]),input', p);
    if (first) first.focus();
  };
  /* перерисовать открытый поповер на месте: фокус и прокрутка списка сохраняются */
  const refreshPop = () => {
    const p = $('.pop', el); if (!p || !T.pop) return;
    const a = document.activeElement, sel = a && p.contains(a) ? POPKEYS.filter(k => a.hasAttribute(k)).map(k => `[${k}="${CSS.escape(a.getAttribute(k))}"]`).join('') + (a.type === 'checkbox' && a.dataset.fv ? `[value="${CSS.escape(a.value)}"]` : '') : '';
    const sc = $('.ff-list, .pc-list', p), top = sc ? sc.scrollTop : 0;
    p.outerHTML = popHtml(T.pop);
    const np = $('.pop', el), sc2 = $('.ff-list, .pc-list', np); if (sc2) sc2.scrollTop = top;
    const b = sel && $(sel, np); if (b) { b.focus(); if (b.type === 'search') b.setSelectionRange(b.value.length, b.value.length); }
  };
  const dirty = () => { T.dirty = true; };
  const moveCol = (k, to) => { const c = T.cols.filter(x => x !== k); c.splice(Math.max(1, Math.min(c.length, to)), 0, k); T.cols = c; dirty(); };
  draw();
  fitWrap(wrap);
  bindRows(wrap, {openSet: T.open, cols: tblCols, o: {ctx: 'tbl'}});
  let qt = null;
  $('#tbl-q', el).oninput = e => { clearTimeout(qt); qt = setTimeout(() => { T.q = e.target.value; T.page = 50; draw(); }, 150); };
  el.addEventListener('input', e => {
    const d = e.target.dataset;
    if (d.fq != null) { T.fq = e.target.value; refreshPop(); }
    else if (d.cq != null) { T.cq = e.target.value; refreshPop(); }
  });
  el.addEventListener('change', e => {
    const d = e.target.dataset;
    if (d.col) { T.cols = e.target.checked ? [...T.cols, d.col] : T.cols.filter(k => k !== d.col); dirty(); draw(); refreshPop(); }
    else if (d.fv) { const cur = new Set(T.filters[d.fv] || []); if (e.target.checked) cur.add(e.target.value); else cur.delete(e.target.value); T.filters[d.fv] = [...cur]; T.page = 50; T.gOpen.clear(); draw(); refreshPop(); }
    else if (d.dense != null) { T.dense = e.target.checked; dirty(); draw(); refreshPop(); }
  });
  el.addEventListener('keydown', e => {
    const g = e.target.closest && e.target.closest('[data-move]');
    if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const k = g.dataset.move, i = T.cols.indexOf(k);
    moveCol(k, i + (e.key === 'ArrowUp' ? -1 : 1)); draw(); refreshPop();
    say(`${TCOLS[k].head}: ${T.cols.indexOf(k) + 1}-я из ${T.cols.length}`);
  });
  /* перетаскивание порядка колонок в поповере */
  el.addEventListener('dragstart', e => { const li = e.target.closest && e.target.closest('.pc-item[draggable]'); if (!li) return; T.drag = li.dataset.ck; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', T.drag); });
  el.addEventListener('dragover', e => { const li = e.target.closest && e.target.closest('.pc-item[draggable]'); if (!li || !T.drag) return; e.preventDefault(); const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2; $$('.pc-item', el).forEach(x => x.classList.remove('drop-before', 'drop-after')); li.classList.add(after ? 'drop-after' : 'drop-before'); });
  el.addEventListener('drop', e => { const li = e.target.closest && e.target.closest('.pc-item[draggable]'); if (!li || !T.drag) return; e.preventDefault(); const k = T.drag, after = li.classList.contains('drop-after'); T.drag = null; if (li.dataset.ck === k) { refreshPop(); return; } const c = T.cols.filter(x => x !== k); moveCol(k, c.indexOf(li.dataset.ck) + (after ? 1 : 0)); draw(); refreshPop(); focusSel(`[data-move="${k}"]`); });
  el.addEventListener('dragend', () => { T.drag = null; $$('.pc-item', el).forEach(x => x.classList.remove('drag', 'drop-before', 'drop-after')); });
  el.addEventListener('click', e => {
    const t = e.target, d = (t.closest('[data-pop],[data-facet],[data-chip],[data-clear],[data-treset],[data-gpick],[data-view-pick],[data-col-reset],[data-save-view],[data-sort],[data-gtoggle],[data-gmore],[data-gcollapse],[data-tmore],#tbl-csv') || {});
    const ds = d.dataset || {};
    if (ds.pop) { if (T.pop === ds.pop) closePop(); else openPop(ds.pop); return; }
    if (ds.facet) { T.facet = ds.facet; T.fq = ''; refreshPop(); focusSel(`[data-facet="${ds.facet}"]`); return; }
    if (ds.chip) { T.facet = ds.chip; T.fq = ''; openPop('flt'); return; }
    if (ds.clear) { const chips = $$('[data-chip]', el), i = chips.findIndex(c => c.dataset.chip === ds.clear); T.filters[ds.clear] = []; T.page = 50; draw(); const rest = $$('[data-chip]', el); (rest[Math.min(i, rest.length - 1)] || $('[data-pop="flt"]', el)).focus(); return; }
    if (d.hasAttribute && d.hasAttribute('data-treset')) { const inPop = !!d.closest('.pop'); T.q = ''; T.filters = {}; T.page = 50; T.fq = ''; $('#tbl-q', el).value = ''; draw(); if (inPop) { refreshPop(); focusSel('[data-facet][aria-pressed="true"]'); } else $('#tbl-q', el).focus(); return; }
    if (ds.gpick != null) { T.group = ds.gpick || null; T.gOpen.clear(); T.gPage = {}; dirty(); closePop(); draw(); focusSel('[data-pop="grp"]'); return; }
    if (ds.viewPick) { tblApplyView(ds.viewPick); closePop(); draw(); focusSel('[data-pop="view"]'); return; }
    if (d.hasAttribute && d.hasAttribute('data-col-reset')) { const keep = {sort: T.sort}; tblApplyView(T.view); T.sort = keep.sort; draw(); refreshPop(); focusSel('[data-cq]'); return; }
    if (d.hasAttribute && d.hasAttribute('data-save-view')) { if (tblSaveMine({cols: T.cols, dense: T.dense, group: T.group, sort: T.sort})) { T.view = 'my'; T.dirty = false; toast('Вид сохранён: «Мой вид»'); } else toast('Браузер не дал сохранить вид'); closePop(true); draw(); return; }
    if (ds.sort) { const k = ds.sort, s = T.sort; T.sort = !s || s.key !== k ? {key: k, dir: 'asc'} : s.dir === 'asc' ? {key: k, dir: 'desc'} : null; draw(); focusSel(`[data-sort="${k}"]`); return; }
    if (ds.gmore) { T.gPage[ds.gmore] = (T.gPage[ds.gmore] || 50) + 50; draw(); focusSel(`[data-gmore="${CSS.escape(ds.gmore)}"]`) || focusSel(`[data-gtoggle="${CSS.escape(ds.gmore)}"]`); return; }
    if (d.hasAttribute && d.hasAttribute('data-gcollapse')) { T.gOpen.clear(); draw(); focusSel('[data-gtoggle]'); return; }
    if (d.hasAttribute && d.hasAttribute('data-tmore')) { T.page += 50; draw(); focusSel('[data-tmore]'); return; }
    if (d.id === 'tbl-csv') {
      const rows = tblRows(), cols = tblCols().filter(k => k !== 'code'), G = T.group && TGROUPBY[T.group], name = `svodnaya-${today()}.csv`;
      exportCsv(name, [...(G ? [G.label] : []), ...cols.flatMap(k => k === 'name' ? ['Позиция', 'Код', 'Основание'] : [TCOLS[k].head])], rows.map(s => [...(G ? [G.name(G.key(s))] : []), ...cols.flatMap(k => k === 'name' ? [s.name, s.id, s.ground] : [TCOLS[k].csv(s)])]));
      toast(`Файл ${name} скачан: ${fmt(rows.length)} поз., ${cols.length + 1} кол.`); return;
    }
    const gt = ds.gtoggle != null ? ds.gtoggle : (t.closest('tr.tgrp') && !t.closest('button,a,input') ? t.closest('tr.tgrp').dataset.grp : null);
    if (gt != null) { if (T.gOpen.has(gt)) T.gOpen.delete(gt); else T.gOpen.add(gt); draw(); focusSel(`[data-gtoggle="${CSS.escape(gt)}"]`); }
  });
  if (!renderTable.bound) {
    renderTable.bound = true;
    document.addEventListener('mousedown', e => { if (state.section !== 'table' || !state.table.pop) return; if (e.target.closest('.pop, [data-pop]')) return; const p = $('.pop'); if (p) p.remove(); $$('[data-pop]').forEach(b => b.setAttribute('aria-expanded', 'false')); state.table.pop = null; });
  }
  renderTable.closePop = closePop;
}

/* ===== ассортимент и цены ===== */
const ASSORT_NOTE = 'Гипотезы по статистике категорий и позиций; чеков и клиентов в данных нет.';
const priceNeed = s => s.markup == null ? null : (1 + R.params.minMarkup / 100) / (1 + s.markup / 100) - 1;
function marginRows() { return R.skus.filter(s => s.status === 'margin').sort((a, b) => (b.flags.urgentPrice - a.flags.urgentPrice) || byPriority(a, b) || b.f12 - a.f12); }
function seasonReach(s) {
  if (!s.flags.seasonal || !s.season) return '';
  return s.season.startsBeforeArrival ? `на сезон ${s.season.label} — только остаток и в пути` : `к сезону ${s.season.label} успевает при заказе до ${dmy(s.season.orderBy)}`;
}
function renderAssortment(el) {
  const m = marginRows(), urgent = m.filter(s => s.flags.urgentPrice), shown = m.slice(0, state.runs.priceAll ? m.length : 15);
  el.innerHTML = `<div class="stack">
    <section class="panel" aria-labelledby="as-price"><div class="panel-head"><h2 id="as-price">Пересмотр цены: ${m.length} поз. с наценкой ниже ${R.params.minMarkup} %</h2><button class="btn btn-primary" type="button" data-run="price">${icon('play')}Подобрать цены</button></div>
      <p class="as-note">В заказ не идут, пока не решена цена. ${urgent.length ? `Со спросом к заказу — ${urgent.length} поз.: по ним решение срочное.` : ''} Сначала — срочные, затем по ценности.</p>
      <div class="tbl-wrap" style="margin-top:8px"><table class="res-tbl"><thead><tr><th scope="col">Позиция</th><th class="num" scope="col">Наценка</th><th class="num" scope="col">Цена до порога</th><th class="num" scope="col">Прогноз 12 мес</th><th class="num" scope="col">По спросу к заказу</th><th scope="col">Когда решить</th></tr></thead>
      <tbody>${shown.map(s => `<tr><td><button class="link" type="button" data-sku="${s.id}">${esc(s.name)}</button><span class="sub">${s.id} · ${esc(s.catName)}</span></td><td class="num warn">${s.markup} %</td><td class="num">+${fmtF(priceNeed(s) * 100, 1)} %</td><td class="num">${fmt(s.f12)}</td><td class="num">${s.flags.urgentPrice ? fmt(s.qtyCalc) : '<span class="zero">—</span>'}</td><td>${s.flags.urgentPrice ? `<span class="warn">${s.orderBy && s.orderBy > today() ? 'до ' + dmy(s.orderBy) : 'сейчас'}</span>` : 'в плановом порядке'}${seasonReach(s) ? `<span class="sub">${seasonReach(s)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${m.length > shown.length ? `<p class="note"><button class="link" type="button" id="price-all">Показать все ${m.length}</button></p>` : ''}
    </section>
    ${resultPanelHtml('price')}
    <section class="panel" aria-labelledby="as-assort"><div class="panel-head"><h2 id="as-assort">Что ещё попробовать</h2><button class="btn" type="button" data-run="assort">${icon('play')}Найти гипотезы</button></div><p class="as-note">${ASSORT_NOTE} Заготовка: формулировки — проверить вручную.</p></section>
    ${resultPanelHtml('assort')}</div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-run]'); if (b) { runScenario(b.dataset.run); return; }
    const k = e.target.closest('[data-sku]'); if (k) { openSku(k.dataset.sku, k); return; }
    if (e.target.closest('#price-all')) { state.runs.priceAll = true; renderAssortment(el); }
  };
}

/* ===== «Данные и проверки» (#run, B-48) ===== */
const PARAM_LABELS = {today: 'Сегодня', coverDays: 'Покрытие после прихода, дн', cycleDays: 'Цикл заказа, дн', minMarkup: 'Мин. наценка, %', overMonths: 'Порог избытка, мес', serviceA: 'Сервис A', serviceB: 'Сервис B', serviceC: 'Сервис C', bufferDays: 'Буфер к сроку, дн', fillMethod: 'Метод доли поставки', compensateFill: 'Компенсировать долю поставки в количестве', lateLossShare: 'Порог потерь для «Просрочено», мес спроса', tailCQtyYear: 'Порог «хвоста C», шт/год', leadDefault: 'Плечо по умолчанию, дн', leadNoSupplier: 'Плечо без поставщика, дн', fillWindowDays: 'Окно сверки PO с приходами, дн', containerKg: 'Контейнер по весу, кг'};
const paramVal = (k, v) => k === 'fillMethod' ? (v === 'erp' ? 'по полю ERP' : 'по сверке с приходами') : k === 'compensateFill' ? (v ? 'да' : 'нет') : /^service/.test(k) ? pctS(v) : k === 'today' ? dmy(v) : typeof v === 'number' ? (Number.isInteger(v) ? fmt(v) : fmtF(v, 2)) : String(v);
function renderRun(el) {
  const ch = R.checks, st = RUNLOG.selftest, rows = ch.rows;
  const fileRows = Object.keys(rows).map(k => `<tr><td>${k}.csv</td><td class="num">${fmt(rows[k])}</td></tr>`).join('');
  const isCh = k => JSON.stringify(R.params[k]) !== JSON.stringify(Engine.defaults[k]);
  const prm = k => `<dt>${PARAM_LABELS[k]}</dt><dd>${paramVal(k, R.params[k])}${isCh(k) ? ` <span class="warn">· по умолчанию ${paramVal(k, Engine.defaults[k])}</span>` : ''}</dd>`;
  const chKeys = Object.keys(PARAM_LABELS).filter(isCh), params = Object.keys(PARAM_LABELS).filter(k => !isCh(k)).map(prm).join('');
  const T = R.timing;
  el.innerHTML = `<div class="run-grid">
    <div class="stack">
      <section class="panel" aria-labelledby="run-in"><div class="panel-head"><h2 id="run-in">Входы и параметры прогона</h2><span class="total"><span class="${st.ok === st.all ? 'ok-ic' : 'bad-ic'}">${icon(st.ok === st.all ? 'circle-check' : 'triangle-alert', 14)}</span> проверки <b>${st.ok}/${st.all}</b> · прогон <b>${fmtF(T.total, 0)} мс</b></span><button class="btn btn-sm" type="button" id="run-recalc">${icon('refresh-cw', 14)}Пересчитать</button></div>
        <p class="as-note">${SOURCE.kind === 'upload' ? `Загружено ${SOURCE.files.length} файлов CSV в ${SOURCE.at.toTimeString().slice(0, 5)}` : 'Встроенный снимок data.js — шесть CSV из share/, собран Engine.ingest'} · история ${mmyyyy(R.calendar.histFrom)}–${mmyyyy(R.calendar.histTo)} · остатки с ${mmyyyy(R.calendar.stockFrom)} · сегодня ${dmy(R.today)}</p>
        <table class="checks-tbl" style="margin-top:8px"><thead><tr><th scope="col">Файл</th><th class="num" scope="col">Строк</th></tr></thead><tbody>${fileRows}</tbody></table>
        <h3 class="section-h">Параметры</h3>${chKeys.length || Object.keys(state.overrides).length ? `<dl class="kv-list">${chKeys.map(prm).join('')}${Object.keys(state.overrides).length ? `<dt>Перенос поставщика</dt><dd>${Object.keys(state.overrides).length} поз. на альтернативу</dd>` : ''}</dl>` : '<p class="as-note">Все по умолчанию.</p>'}<details class="chart-data"><summary>${chKeys.length ? 'Остальные параметры' : 'Все параметры'}</summary><dl class="kv-list" style="margin-top:4px">${params}</dl></details>
        <h3 class="section-h">Время прогона</h3>
        <p class="as-note">Engine.run по ${fmt(R.skus.length)} позициям: <b>${fmtF(T.total, 0)} мс</b> в ядре (${['history', 'suppliers', 'forecast', 'decisions', 'aggregates'].filter(k => T[k] != null).map(k => ({history: 'история', suppliers: 'поставщики', forecast: 'прогноз', decisions: 'решения', aggregates: 'агрегаты'}[k]) + ' ' + fmtF(T[k], 0)).join(' · ')}), в интерфейсе ${RUNLOG.ms} мс${RUNLOG.at ? ' · ' + RUNLOG.at.toTimeString().slice(0, 5) : ''}</p>
        <div class="res-actions"><button class="btn btn-sm" type="button" id="run-snap">${icon('save', 14)}Сохранить снимок данных (data.js)</button></div>
      </section>
      <section class="panel" aria-labelledby="run-chk"><h2 id="run-chk">Проверки</h2>
        <p class="as-note"><span class="${st.ok === st.all ? 'ok-ic' : 'bad-ic'}">${icon(st.ok === st.all ? 'circle-check' : 'triangle-alert', 16)}</span> Самопроверка ядра: <b>${st.ok}/${st.all}</b> — счётчики README, суммы, арифметика количества по всем позициям, эталоны.</p>
        <details class="chart-data"><summary>Все проверки</summary><table class="checks-tbl"><thead><tr><th scope="col">Проверка</th><th scope="col">Ожидалось</th><th scope="col">Получилось</th></tr></thead><tbody>${st.list.map(t => `<tr><td>${t.ok ? '' : '<b class="warn">не прошла · </b>'}${esc(t.name)}</td><td>${esc(String(t.expected))}</td><td>${esc(String(t.actual))}</td></tr>`).join('')}</tbody></table></details>
        <h3 class="section-h">Сверка с README данных</h3>
        <p class="as-note">${esc(R.dead.note)}.</p>
        <p class="as-note">Наценка ниже ${R.params.minMarkup} %: ${fmt(ch.belowMinMarkup)} из ${fmt(ch.withMarkup)} с наценкой · открытых PO ${fmt(ch.open)}, в будущем ${fmt(ch.openFuture)} на ${fmt(ch.openFuturePending)} шт · Σ в пути = Σ on_order_qty = ${fmt(ch.pendingOpen)} · без поставщика ${fmt(ch.noSupplier)} (активных ${fmt(ch.noSupplierActive)}).</p>
        <h3 class="section-h">Проверки критика</h3>
        ${R.critic.length ? `<ul class="m-list">${R.critic.map(c => `<li>${c.sku ? `<button class="link" type="button" data-sku="${c.sku}">${esc(c.text)}</button>` : esc(c.text)}</li>`).join('')}</ul>` : '<p class="as-note">Замечаний нет.</p>'}
        <h3 class="section-h">Допущения и ограничения</h3>
        <ul class="m-list">
          <li>У ${fmt(R.kpi.shortThanLead)} позиций остаток кончится раньше прихода заказа сегодня — это свойство ассортимента (плечо длиннее покрытия), а не ошибка расчёта. Поэтому «Просрочено» — ${pctS(R.kpi.lateShareOfPlan)} плана: в него попадают только позиции с потерями до прихода не меньше ${fmtF(R.params.lateLossShare)} месячного спроса.</li>
          <li>${esc(ch.valueIndexNote)}.</li>
          <li>${esc(R.kpi.moneyNote)}; ${esc(R.kpi.volumeNote)}.</li>
          <li>Выгрузка заказов неполная: часть приходов идёт без PO, поэтому доля поставки по сверке — верхняя оценка, по полю ERP — нижняя. Метод — параметр «Пересчитать».</li>
          <li>Названия позиций и поставщиков условные, коды — из данных. Агент — муляж с заготовленными ответами (фаза 2).</li>
        </ul>
      </section>
    </div>
    <section class="panel" aria-labelledby="run-traps"><h2 id="run-traps">Семь ловушек данных → правило → сколько задето</h2>
      <ol class="traps">${R.traps.map(t => `<li><span class="n">${t.id}</span><div><span class="t">${esc(t.title)}</span> <span class="w">· ${esc(t.where)}</span><p>${esc(t.text)}</p></div></li>`).join('')}</ol>
    </section></div>`;
  el.onclick = e => {
    if (e.target.closest('#run-recalc')) { openRecalc(); return; }
    if (e.target.closest('#run-snap')) { saveSnapshot(); return; }
    const k = e.target.closest('[data-sku]'); if (k) openSku(k.dataset.sku, k);
  };
}
function saveSnapshot() { download('data.js', Engine.snapshotJs(COMPACT), 'text/javascript;charset=utf-8'); toast('Снимок данных скачан: data.js — положить в dashboard/ вместо текущего'); }

/* ===== окна расчёта: что считаем → данные → параметры → запуск → шаги → результат ===== */
const SCENARIOS = {
  fill: {title: 'Заполнить сезон', about: ['Позиции сезонной категории: что уже в плане, что заблокировано, где останется разрыв', 'Разрыв — по той же дневной проекции, что и готовность к сезону'], data: () => `Прогон ${dmy(R.today)}: позиции категории, план «Сейчас», открытые PO × доля поставки.`},
  container: {title: 'Добить контейнер', about: ['Сколько весит заказ поставщика и сколько не хватает до целого контейнера', 'Чем добить: позиции следующего цикла этого поставщика по сроку'], data: () => `${R.kpi.volumeNote}. Вес штуки из sku_dim, пустой — медиана категории (≈).`},
  liq: {title: 'Ликвидация', about: ['Что заморожено сверх порога избытка и у мёртвых позиций', 'Рекомендация по каждой позиции из топа избытка'], data: () => `Избыток: прямая проекция остатка на ${R.params.overMonths} мес; мёртвые — нет продаж 12 полных месяцев.`},
  price: {title: 'Пересмотр цены', about: ['На сколько поднять цену, чтобы наценка дошла до порога', 'Что будет со спросом и заказом при допущении об эластичности'], data: () => 'Наценка avg_markup_pct_12m из sku_dim. Эластичность — допущение, не измерение: чеков в данных нет.'},
  supply: {title: 'Надёжность поставок', about: ['Поставщики с долей поставки ниже 0,7 или без отгрузок', 'Оба метода доли поставки и просроченные PO'], data: () => `Закрытые PO и приходы, окно сверки +${R.params.fillWindowDays} дн.`},
  assort: {title: 'Что ещё попробовать', about: ['Гипотезы по статистике категорий: тренд, новинки, продажи без себестоимости'], data: () => ASSORT_NOTE}
};
const SCEN_SECTION = {fill: 'seasons', liq: 'seasons', container: 'suppliers', supply: 'suppliers', price: 'assortment', assort: 'assortment'};
function scenParams(id, ctx) {
  if (id === 'fill') return [{k: 'cat', label: 'Категория', options: R.seasonReadiness.map(r => [r.cat, r.title]), value: ctx.cat || (R.seasonReadiness[0] || {}).cat}];
  if (id === 'container') return [{k: 'sup', label: 'Поставщик', options: supActive().filter(s => !s.blocked).map(s => [s.id, s.name]), value: ctx.sup}, {k: 'kg', label: 'Контейнер по весу, кг', type: 'number', min: Engine.PARAM_RANGES.containerKg[0], max: Engine.PARAM_RANGES.containerKg[1], value: R.params.containerKg}];
  if (id === 'liq') return [{k: 'scope', label: 'Что включить', options: [['over', 'избыток'], ['both', 'избыток и мёртвые с остатком']], value: 'both'}];
  if (id === 'price') return [{k: 'el', label: 'Эластичность спроса по цене (допущение)', type: 'number', min: -3, max: 0, step: 0.1, value: -1}];
  return [];
}
function scenCompute(id, p) {
  if (id === 'fill') {
    const r = R.seasonReadiness.find(x => x.cat === p.cat), gaps = seasonGaps()[p.cat] || [], gm = {}; gaps.forEach(g => { gm[g.s.id] = g.gap; });
    const list = R.skus.filter(s => s.cat === p.cat && (inPlan(s) || s.status === 'blocked' || (gm[s.id] || 0) > 0)).sort((a, b) => (gm[b.id] || 0) - (gm[a.id] || 0) || byPriority(a, b));
    return {cols: ['Позиция', 'Статус', 'Заказать, шт', 'Ожидаемо придёт', 'Приход', 'Разрыв в сезоне'], rows: list.slice(0, 30).map(s => [s, STATUS[s.status].label, inPlan(s) ? fmt(qtyOf(s)) : '—', inPlan(s) ? fmt(Math.round(qtyOf(s) * (s.sup ? s.fill : 1))) : '—', inPlan(s) ? dmy(s.arrival) : '—', fmt(gm[s.id] || 0)]),
      more: list.length > 30 ? list.length - 30 : 0,
      hint: `${r.title}, сезон ${r.season}: до заказа ${pctS(r.readiness.transitOnly)}, после плана 100 % — ${pctS(r.readiness.plan100)}, × доля поставки — ${pctS(r.readiness.planFill)}. Разрыв после плана ${fmt(r.gap.planFill)} шт${r.skusStartBeforeArrival ? `; у ${r.skusStartBeforeArrival} из ${r.skus} поз. новый заказ приходит после старта сезона — начало сезона закрывает только остаток и в пути` : ''}.`};
  }
  if (id === 'container') {
    const S = SP[p.sup], kg = +p.kg, to = R.skus.filter(s => s.sup === p.sup && inPlan(s)), cur = to.reduce((a, s) => a + qtyOf(s) * s.weightKg, 0);
    const full = Math.max(1, Math.ceil(cur / kg - 1e-9)), room = full * kg - cur;
    const cand = R.skus.filter(s => s.sup === p.sup && s.status === 'next' && s.qtyCalc > 0).sort((a, b) => (a.decisionBy || '9') < (b.decisionBy || '9') ? -1 : 1);
    let left = room; const add = [];
    cand.forEach(s => { const w = s.qtyCalc * s.weightKg; if (w <= left) { add.push(s); left -= w; } });
    const approx = to.concat(add).some(s => s.flags.weightImputed);
    return {cols: ['Позиция', 'В заказе, шт', 'Добавить, шт', 'Вес, кг', 'Основание'], rows: [...to.map(s => [s, fmt(qtyOf(s)), '—', fmt(Math.round(qtyOf(s) * s.weightKg)), s.ground]), ...add.map(s => [s, '—', fmt(s.qtyCalc), fmt(Math.round(s.qtyCalc * s.weightKg)), 'следующий цикл: ' + s.ground])],
      hint: `${S ? S.name : ''}: сейчас ${approx ? '≈' : ''}${fmtF(cur / 1000, 1)} т = ${fmtF(cur / kg, 2)} конт. по ${fmt(kg)} кг; до ${full} ${plural(full, 'целого', 'целых', 'целых')} — ${fmt(Math.round(room))} кг. ${add.length ? `Добиваем ${add.length} поз. следующего цикла: +${fmt(Math.round(room - left))} кг.` : 'Позиций следующего цикла, которые влезают по весу, нет.'} ${R.kpi.volumeNote}.`};
  }
  if (id === 'liq') {
    const over = R.skus.filter(s => s.status === 'over').sort((a, b) => b.overFrozen - a.overFrozen);
    const dead = p.scope === 'both' ? R.skus.filter(s => s.status === 'dead' && s.stock > 0).sort((a, b) => b.stock - a.stock) : [];
    const map = {};
    const rows = over.slice(0, 20).map(s => { const rec = s.flags.seasonal ? 'перераспределить и стоп заказа до сезона' : s.coverMonths > 2 * R.params.overMonths ? 'акция: остатка на годы вперёд' : 'стоп заказа, акция на часть'; map[s.id] = rec; return [s, fmt(s.stock), fmt(s.overFrozen), s.coverMonths == null ? '—' : fmt(s.coverMonths), rec]; })
      .concat(dead.slice(0, 10).map(s => [s, fmt(s.stock), fmt(s.stock), '—', 'списать или распродать: нет продаж с ' + mmyyyy(s.lastSale)]));
    return {cols: ['Позиция', 'Остаток', 'Заморожено, шт', 'Покрытие, мес', 'Рекомендация'], rows, map,
      hint: `Заморожено сверх ${R.params.overMonths} мес: ${fmt(R.excess.frozenQty)} шт у ${fmt(R.excess.count)} поз. (то же число, что во вкладке «Избыток»)${dead.length ? `; у мёртвых ${fmt(R.dead.stockQty)} шт у ${fmt(R.dead.withStock)} поз` : ''}.`};
  }
  if (id === 'price') {
    const el = +p.el;
    const rows = marginRows().slice(0, 30).map(s => { const d = priceNeed(s), k = Math.max(0, 1 + el * d), f = Math.round(s.f12 * k), q = s.qtyCalc ? Math.ceil(s.qtyCalc * k / s.batch) * s.batch : 0; return [s, s.markup + ' %', '+' + fmtF(d * 100, 1) + ' %', `${fmt(s.f12)} → ${fmt(f)}`, s.qtyCalc ? `${fmt(s.qtyCalc)} → ${fmt(q)}` : '—', seasonReach(s) || (s.flags.urgentPrice ? 'решить сейчас' : 'в плановом порядке')]; });
    return {cols: ['Позиция', 'Наценка', 'Цена', 'Прогноз 12 мес', 'Заказ по спросу', 'Срок'], rows,
      hint: `Цена поднимается ровно до наценки ${R.params.minMarkup} %. Спрос пересчитан при эластичности ${fmtF(el, 1)} — это допущение, не измерение. После решения по цене позиция уходит из «Низкой наценки» в обычный расчёт.`};
  }
  if (id === 'supply') {
    const list = supActive().filter(s => s.blocked || s.fill < 0.7).sort((a, b) => b.demandShare - a.demandShare);
    return {cols: ['Поставщик', 'Доля спроса', 'По приходам', 'По полю ERP', 'Плечо, дн', 'Просрочено PO', 'Вывод'], rows: list.map(S => [S, pctS(S.demandShare), fmtF(S.fillReceipts), fmtF(S.fillErp), `${S.leadMed} / p90 ${S.leadP90}`, `${S.overduePO} из ${S.openPO}`, S.blocked ? 'не отгружает — перенос позиций' : S.fillSource !== 'data' ? 'мало PO — доля сглажена, подтверждать объём' : 'подтверждать объём проформой']),
      hint: `По сверке с приходами средняя доля поставки ${fmtF(R.checks.globalFillReceipts)}, по полю ERP ${fmtF(R.checks.globalFillErp)}: ${R.traps[6].text}`};
  }
  if (id === 'assort') {
    const cats = Object.keys(CAT).map(k => CAT[k]).filter(c => c.trend).sort((a, b) => b.trend - a.trend);
    const nw = R.skus.filter(s => s.flags.new), nc = R.skus.filter(s => s.flags.noCost);
    const rows = [];
    if (cats[0]) rows.push(['Растущая категория', `${cats[0].name}: тренд год к году ×${fmtF(cats[0].trend)}`, 'расширить линейку в среднем сегменте']);
    if (cats.length > 1) rows.push(['Падающая категория', `${cats[cats.length - 1].name}: тренд ×${fmtF(cats[cats.length - 1].trend)}`, 'не расширять, проверить избыток']);
    if (nw.length) rows.push(['Новинки', `${nw.length} поз. продаются меньше ${R.params.newMonths} мес, прогноз ${fmt(nw.reduce((a, s) => a + s.f12, 0))} шт/год`, 'следить за первым сезоном, прогноз по аналогам']);
    if (nc.length) rows.push(['Продажи без себестоимости', `${nc.length} поз. продаются, а наценки в ERP нет`, 'заполнить себестоимость — иначе цена не проверяется']);
    return {cols: ['Гипотеза', 'Основание из данных', 'Что попробовать'], rows, hint: ASSORT_NOTE + ' Заготовка: формулировки «что попробовать» — заготовленные, числа — из прогона.'};
  }
  return {cols: [], rows: [], hint: ''};
}
function scenFormHtml(id, ctx) {
  const sc = SCENARIOS[id], ps = scenParams(id, ctx);
  return `<div class="scen"><h3 class="m-sec">Что считаем</h3><ul class="m-list">${sc.about.map(a => `<li>${a}</li>`).join('')}</ul>
    <h3 class="m-sec">На каких данных</h3><p class="m-data">${esc(sc.data())}</p>
    ${ps.length ? `<h3 class="m-sec">Параметры</h3><div class="m-params">${ps.map((p, i) => `<div class="m-field"><label for="sp-${i}">${p.label}</label>${p.options ? `<select id="sp-${i}" data-k="${p.k}">${p.options.map(([v, l]) => `<option value="${esc(v)}"${v === p.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` : `<input type="number" id="sp-${i}" data-k="${p.k}" value="${p.value}" min="${p.min}" max="${p.max}" step="${p.step || 1}"><span class="err" id="sp-${i}-err"></span>`}</div>`).join('')}</div>` : ''}</div>`;
}
function runScenario(id, {ctx = {}} = {}) {
  const sc = SCENARIOS[id]; if (!sc) return;
  openModal({title: sc.title, body: scenFormHtml(id, ctx), actions: [{label: 'Отмена'}, {label: 'Запустить', icon: 'play', primary: true, onClick: start}]});
  function start() {
    const p = {}; let bad = false;
    $$('#m-body [data-k]').forEach(i => { p[i.dataset.k] = i.value; if (i.type === 'number') { const v = +i.value, err = $('#' + i.id + '-err'); const ok = i.value !== '' && isFinite(v) && v >= +i.min && v <= +i.max; i.setAttribute('aria-invalid', String(!ok)); if (err) err.textContent = ok ? '' : `от ${fmtF(+i.min, 0)} до ${fmtF(+i.max, 0)}`; if (!ok) bad = true; } });
    if (bad) { const f = $('#m-body [aria-invalid="true"]'); if (f) f.focus(); return; }
    const t0 = performance.now(), res = scenCompute(id, p), ms = Math.round(performance.now() - t0);
    const ps = scenParams(id, ctx).map(q => `${q.label}: ${q.options ? (q.options.find(o => o[0] === p[q.k]) || ['', p[q.k]])[1] : p[q.k]}`);
    $('#m-body').innerHTML = `<div class="scen"><h3 class="m-sec">Ход выполнения</h3><ul class="steps">${[...ps.map(x => 'Параметры — ' + x), `Таблица собрана из прогона ${dmy(R.today)} за ${ms} мс: ${res.rows.length} ${plural(res.rows.length, 'строка', 'строки', 'строк')}`].map(s => `<li>${icon('check', 16)}<span>${esc(s)}</span></li>`).join('')}<li class="fin">${icon('check-check', 16)}<span>Готово</span></li></ul></div>`;
    say('Расчёт готов: ' + sc.title);
    setModalActions([{label: 'Показать результат', primary: true, onClick: () => {
      closeModal();
      state.runs[id] = {at: new Date(), ctx: {...ctx, ...p}, params: ps, ...res};
      agentScenarioDone(id, {ctx: {...ctx, ...p}});
      const sec = SCEN_SECTION[id];
      if (id === 'liq') go('seasons', {sub: 'over'});
      else if (id === 'fill') go('seasons', {sub: 'ready', query: {cat: p.cat}});
      else if (id === 'container') go('suppliers', {sub: p.sup});
      else if (state.section !== sec || state.route.sub) go(sec); else refreshSection();
      setTimeout(() => { const r = $('[data-result="' + id + '"]'); if (r) { r.scrollIntoView({block: 'start'}); r.focus({preventScroll: true}); say('Результат: ' + sc.title); } }, 30);
    }}]);
    $('#m-foot button').focus();
  }
}
function resultPanelHtml(id) {
  const r = state.runs[id], sc = SCENARIOS[id];
  if (!r || !sc || !r.cols) return '';
  const cell = c => c && c.id && c.name ? (SK[c.id] ? `<button class="link" type="button" data-sku="${c.id}">${esc(c.name)}</button><span class="sub">${c.id}</span>` : `<button class="link" type="button" data-supgo="${c.id}">${esc(c.name)}</button><span class="sub">${c.id}</span>`) : esc(c);
  return `<section class="panel result" data-result="${id}" tabindex="-1" aria-labelledby="res-${id}">
    <div class="panel-head"><h2 id="res-${id}">Результат: ${sc.title} · ${r.at.toTimeString().slice(0, 5)}</h2><button class="btn btn-quiet btn-sm" type="button" data-res-hide="${id}">Скрыть</button></div>
    <p class="res-params">${esc(r.params.join(' · '))}</p>
    <div class="tbl-wrap"><table class="res-tbl"><thead><tr>${r.cols.map((c, i) => `<th scope="col"${i ? ' class="num"' : ''}>${c}</th>`).join('')}<th scope="col"><span class="sr">Действие</span></th></tr></thead>
      <tbody>${r.rows.map((row, i) => `<tr>${row.map((c, j) => `<td${j && /^[+−\d≈—]/.test(String(c)) ? ' class="num"' : ''}>${cell(c)}</td>`).join('')}<td class="num"><button class="btn btn-quiet btn-sm" type="button" data-scen-audit="${id}:${i}">${icon('list-plus', 14)}В замечания</button></td></tr>`).join('')}</tbody></table></div>
    ${r.more ? `<p class="note">и ещё ${r.more} — в сводной таблице</p>` : ''}
    <div class="hint">${esc(r.hint)}</div>
    <div class="res-actions"><button class="btn btn-sm" type="button" data-scen-audit="${id}">${icon('list-plus', 14)}Всё в замечания</button></div></section>`;
}
document.addEventListener('click', e => {
  const hide = e.target.closest('[data-res-hide]');
  if (hide) { delete state.runs[hide.dataset.resHide]; refreshSection(); return; }
  const sg = e.target.closest('[data-supgo]');
  if (sg) { go('suppliers', {sub: sg.dataset.supgo}); return; }
  const b = e.target.closest('[data-scen-audit]');
  if (!b) return;
  const [id, i] = b.dataset.scenAudit.split(':'), r = state.runs[id], sc = SCENARIOS[id];
  const idx = i == null ? r.rows.map((x, k) => k) : [+i];
  const lab = c => c && c.name ? c.name : String(c);
  let added = 0;
  idx.forEach(k => { const row = r.rows[k]; if (auditAdd({kind: 'proposal', title: `${sc.title}: ${lab(row[0])}`, text: r.cols.slice(1).map((c, j) => `${c} — ${lab(row[j + 1])}`).join('; '), ref: row[0] && row[0].id ? {type: SK[row[0].id] ? 'sku' : 'supplier', id: row[0].id} : {type: 'scenario', id}, silent: true})) added++; });
  toast(added ? `В замечания: ${added}` : 'Уже в замечаниях');
});

/* ===== «Пересчитать» (B-18): параметры с проверкой, загрузка 6 CSV, снимок, «Что изменилось» ===== */
const RECALC_FIELDS = ['coverDays', 'cycleDays', 'minMarkup', 'overMonths', 'bufferDays', 'lateLossShare', 'tailCQtyYear', 'leadDefault'];
const SERVICE_FIELDS = ['serviceA', 'serviceB', 'serviceC'];
const CSV_NAMES = ['sku_dim', 'sales_monthly', 'stock_monthly', 'purchase_orders', 'receipts', 'supplier_dim'];
let upload = {};
function recalcFormHtml() {
  const P = {...Engine.defaults, ...state.params}, Rg = Engine.PARAM_RANGES;
  const num = k => `<div class="m-field"><label for="rp-${k}">${PARAM_LABELS[k]}</label><input type="number" id="rp-${k}" data-p="${k}" value="${P[k]}" min="${Rg[k][0]}" max="${Rg[k][1]}" step="${k === 'lateLossShare' ? 0.05 : 1}" aria-describedby="rp-${k}-err"><span class="err" id="rp-${k}-err"></span></div>`;
  const svc = k => `<div class="m-field"><label for="rp-${k}">${PARAM_LABELS[k]}, %</label><input type="number" id="rp-${k}" data-p="${k}" data-pct value="${Math.round(P[k] * 1000) / 10}" min="${Rg[k][0] * 100}" max="${Rg[k][1] * 100}" step="1" aria-describedby="rp-${k}-err"><span class="err" id="rp-${k}-err"></span></div>`;
  const files = CSV_NAMES.map(n => `<li class="${upload[n] ? 'ok' : ''}">${n}.csv<span>${upload[n] ? 'загружен' : SOURCE.kind === 'upload' ? 'из загрузки' : 'встроенный'}</span></li>`).join('');
  return `<div class="scen">
    <h3 class="m-sec">Что считаем</h3><ul class="m-list"><li>Весь план заново: Engine.run по ${fmt(R.skus.length)} позициям — прогноз, проекция остатка, даты, количество, статусы, агрегаты</li><li>«Что изменилось» — разница с текущим прогоном (Engine.diff)</li></ul>
    <h3 class="m-sec">На каких данных</h3>
    <p class="m-data">${SOURCE.kind === 'upload' ? `Загруженные CSV (${SOURCE.files.length})` : 'Встроенный снимок data.js'}. Можно загрузить свои шесть CSV той же схемы, что в share/.</p>
    <div class="dz" id="dz" tabindex="0" role="button" aria-describedby="dz-files">${icon('upload', 18)}<span><b>Перетащите шесть CSV сюда</b> или нажмите, чтобы выбрать</span></div>
    <input type="file" id="dz-in" multiple accept=".csv,text/csv" hidden>
    <ul class="files" id="dz-files" aria-live="polite">${files}</ul>
    <div id="dz-err"></div>
    <h3 class="m-sec">Параметры</h3>
    <div class="m-params">${RECALC_FIELDS.map(num).join('')}${SERVICE_FIELDS.map(svc).join('')}
      <div class="m-field" role="radiogroup" aria-labelledby="rp-fm-l"><span class="lbl" id="rp-fm-l">${PARAM_LABELS.fillMethod}</span><div class="radios"><label><input type="radio" name="fm" value="receipts"${P.fillMethod !== 'erp' ? ' checked' : ''}>по сверке с приходами</label><label><input type="radio" name="fm" value="erp"${P.fillMethod === 'erp' ? ' checked' : ''}>по полю ERP</label></div></div>
      <div class="m-field row"><input type="checkbox" id="rp-comp"${P.compensateFill ? ' checked' : ''}><label for="rp-comp">${PARAM_LABELS.compensateFill}</label></div>
    </div>
    <p class="note">Диапазоны проверяются здесь и в ядре; значение вне диапазона ядро зажимает к границе и сообщает.</p></div>`;
}
function readRecalcForm() {
  const p = {}, errs = [];
  $$('#m-body [data-p]').forEach(i => {
    const k = i.dataset.p, Rg = Engine.PARAM_RANGES[k], raw = i.value.trim().replace(',', '.'), v = +raw;
    const lo = i.hasAttribute('data-pct') ? Rg[0] * 100 : Rg[0], hi = i.hasAttribute('data-pct') ? Rg[1] * 100 : Rg[1];
    const ok = raw !== '' && isFinite(v) && v >= lo && v <= hi;
    i.setAttribute('aria-invalid', String(!ok));
    $('#' + i.id + '-err').textContent = ok ? '' : `нужно число от ${fmtF(lo, lo % 1 ? 2 : 0)} до ${fmtF(hi, hi % 1 ? 2 : 0)}`;
    if (!ok) errs.push(i); else p[k] = i.hasAttribute('data-pct') ? Math.round(v * 10) / 1000 : v;
  });
  p.fillMethod = ($('#m-body input[name=fm]:checked') || {}).value || 'receipts';
  p.compensateFill = $('#rp-comp').checked;
  return {p, errs};
}
function bindUpload() {
  const dz = $('#dz'), inp = $('#dz-in');
  const take = files => {
    const list = [...files].filter(f => /\.csv$/i.test(f.name));
    if (!list.length) { showUploadErr('Нужны файлы .csv'); return; }
    Promise.all(list.map(f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok([f.name, r.result]); r.onerror = () => no(new Error('Файл ' + f.name + ' не прочитан')); r.readAsText(f, 'utf-8'); })))
      .then(pairs => { pairs.forEach(([n, t]) => { upload[n.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '')] = t; }); $('#dz-files').innerHTML = CSV_NAMES.map(n => `<li class="${upload[n] ? 'ok' : ''}">${n}.csv<span>${upload[n] ? 'загружен' : 'нет'}</span></li>`).join(''); const unknown = pairs.map(p => p[0].replace(/\.csv$/i, '')).filter(n => !CSV_NAMES.includes(n)); showUploadErr(unknown.length ? `Не знаю файлы: ${unknown.join(', ')}.csv — нужны ${CSV_NAMES.map(n => n + '.csv').join(', ')}` : ''); say(`Загружено файлов: ${Object.keys(upload).length} из ${CSV_NAMES.length}`); })
      .catch(err => showUploadErr(err.message));
  };
  dz.onclick = () => inp.click();
  dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  inp.onchange = () => take(inp.files);
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); take(e.dataTransfer.files); };
  dz.setAttribute('aria-label', 'Загрузить шесть файлов CSV');
}
function showUploadErr(text) { const b = $('#dz-err'); if (b) b.innerHTML = text ? `<p class="alert" role="alert">${icon('triangle-alert', 16)}<span>${esc(text)}</span></p>` : ''; }
function openRecalc() {
  upload = {};
  openModal({title: 'Пересчитать план', body: recalcFormHtml(), actions: [{label: 'Отмена'}, {label: 'Параметры по умолчанию', onClick: () => { const keep = state.params; state.params = {}; $('#m-body').innerHTML = recalcFormHtml(); state.params = keep; bindUpload(); say('В форме — значения по умолчанию; применятся после «Запустить»'); }}, {label: 'Запустить', icon: 'play', primary: true, onClick: startRecalc}]});
  bindUpload();
}
function startRecalc() {
  const {p, errs} = readRecalcForm();
  if (errs.length) { errs[0].focus(); say('Исправьте параметры: ' + errs.length); return; }
  const names = Object.keys(upload);
  let compact = null;
  if (names.length) {
    const miss = CSV_NAMES.filter(n => !upload[n]);
    if (miss.length) { showUploadErr(`Нужны все шесть файлов. Нет: ${miss.map(n => n + '.csv').join(', ')}`); $('#dz').focus(); return; }
    try { compact = Engine.ingest(upload); } catch (err) { showUploadErr(err.message); $('#dz').focus(); return; }
  }
  modalBusy = true;
  setModalActions([{label: 'Считаю…', disabled: true}]);
  $('#m-body').innerHTML = '<div class="scen"><h3 class="m-sec">Ход выполнения</h3><ul class="steps" id="steps"><li>' + icon('refresh-cw', 16) + '<span>Считаю…</span></li></ul></div>';
  setTimeout(() => {
    const changed = Object.keys(p).filter(k => JSON.stringify(p[k]) !== JSON.stringify(Engine.defaults[k]));
    state.params = {}; changed.forEach(k => { state.params[k] = p[k]; });
    let same = null;
    if (compact) { COMPACT = compact; SOURCE = {kind: 'upload', files: names.map(n => n + '.csv'), at: new Date()}; }
    recompute();
    if (compact) { const ref = Engine.run(VELSA_DATA, currentParams()); same = Engine.stableJSON(ref) === Engine.stableJSON(R); }
    modalBusy = false;
    const d = LAST_DIFF, st = RUNLOG.selftest;
    const steps = [
      compact ? `Входы: загружено ${names.length} файлов, ${Object.entries(R.checks.rows).map(([k, v]) => k + ' ' + fmt(v)).join(', ')}` : `Входы: ${SOURCE.kind === 'upload' ? 'загруженные CSV' : 'встроенный снимок data.js'}, ${fmt(R.skus.length)} ${plural(R.skus.length, "позиция", "позиции", "позиций")}`,
      'Параметры: ' + ['coverDays', 'cycleDays', 'minMarkup', 'overMonths', 'fillMethod', 'compensateFill'].map(k => PARAM_LABELS[k].replace(/,.*$/, '').toLowerCase() + ' ' + paramVal(k, R.params[k])).join(', '),
      `Engine.run: ${fmtF(R.timing.total, 0)} мс в ядре, всего ${RUNLOG.ms} мс`,
      `Самопроверка: ${st.ok}/${st.all}`,
      R.checks.paramErrors.length ? `Ядро поправило параметры: ${R.checks.paramErrors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('; ')}` : null,
      same == null ? null : same ? 'Сверка со встроенным снимком: результат идентичен (stableJSON совпадает)' : 'Сверка со встроенным снимком: результат отличается — данные в файлах другие',
      `Что изменилось: ${fmt(d.count)} — статус ${d.summary.status}, срок «заказать до» ${d.summary.orderBy}, количество ${d.summary.qty}`
    ].filter(Boolean);
    $('#m-body').innerHTML = `<div class="scen"><h3 class="m-sec">Ход выполнения</h3><ul class="steps">${steps.map(s => `<li>${icon('check', 16)}<span>${esc(s)}</span></li>`).join('')}<li class="fin">${icon('check-check', 16)}<span>Готово: план «Сейчас» ${fmt(d.summary.planCount[0])} → ${fmt(d.summary.planCount[1])} поз., ${fmt(d.summary.planQty[0])} → ${fmt(d.summary.planQty[1])} шт</span></li></ul>
      <h3 class="m-sec">Что изменилось</h3>${d.count ? `<div class="tbl-wrap"><table class="res-tbl"><thead><tr><th scope="col">Позиция</th><th scope="col">Изменение</th></tr></thead><tbody>${d.items.slice(0, 60).map(x => `<tr><td><button class="link" type="button" data-sku="${x.id}">${esc(nameOf(x.id))}</button><span class="sub">${x.id}</span></td><td>${esc(x.text.replace(/^«[^»]*»:\s*/, ''))}</td></tr>`).join('')}</tbody></table></div>${d.count > 60 ? `<p class="note">Показаны 60 из ${fmt(d.count)} — полный список в CSV.</p>` : ''}` : '<p class="m-data">Изменений нет: параметры и данные дают тот же план.</p>'}</div>`;
    setModalActions([{label: 'Изменения в CSV', icon: 'download', disabled: !d.count, onClick: () => { exportCsv(`changes-${today()}.csv`, ['Код', 'Позиция', 'Что', 'Было', 'Стало', 'Текст'], d.items.map(x => [x.id, nameOf(x.id), x.kind, x.from == null ? '' : x.from, x.to == null ? '' : x.to, x.text])); toast('Файл changes-' + today() + '.csv скачан'); }},
      {label: 'Сохранить снимок данных (data.js)', icon: 'save', onClick: saveSnapshot}, {label: 'Закрыть', primary: true}]);
    $('#m-foot .btn-primary').focus();
    say(`Пересчитано: изменений ${d.count}`);
    agentScenarioDone('recalc', {diff: d});
    render();
  }, 30);
}

/* ===== агент (муляж, фаза 2): чат без ролей — шаблон ответа выбирает вопрос ===== */
let auditSeq = 0, feedSeq = 0;
const AUDIT_STATUS = [{id: 'open', label: 'Открыто'}, {id: 'work', label: 'В работе'}, {id: 'rejected', label: 'Отклонено'}, {id: 'done', label: 'Сделано'}];
const agentCtx = () => ({R, SK, SP, STATUS, fmt, fmtF, dmy, pctS, range, isoOf, todayD, nameOf, supNameOf, catName, inPlan, qtyOf, norm, planTotals: () => planTotals(planList())});
const auditOpenCount = () => state.agent.audit.filter(a => a.status === 'open').length;
const kindOf = k => AGENT.kinds[k] || AGENT.kinds.info;
const agentDelay = () => reduceMotion() ? 0 : 600;
const agentTimers = {};
const REF_ICON = {sku: 'package', supplier: 'factory', category: 'tag'};
const MOCK_NOTE = 'Ответы собраны шаблонами по данным прогона, без модели и сети. Живой агент — фаза 2.';
/* подсказки-запросы: вопрос сам выбирает шаблон (бывшие роли критика, аналитика, логиста и «простыми словами») */
function suggestions(ctx) {
  if (ctx && ctx.type === 'sku' && SK[ctx.id]) return [
    {id: 'why', label: 'Почему такое решение?', role: 'critic'}, {id: 'fc', label: 'Откуда прогноз?', role: 'analyst'},
    {id: 'sup', label: 'Что с поставкой?', role: 'logist'}, {id: 'plain', label: inPlan(SK[ctx.id]) ? 'Что будет, если не заказать?' : 'Объясни простыми словами', role: 'mentor'}];
  if (ctx && ctx.type === 'supplier') return [{id: 'why', label: 'Можно ли на него рассчитывать?', role: 'logist'}, {id: 'share', label: 'Какая доля в спросе?', role: 'analyst'}, {id: 'plain', label: 'Объясни простыми словами', role: 'mentor'}];
  if (ctx && ctx.type === 'category') return [{id: 'why', label: 'Успеваем к сезону?', role: 'critic'}, {id: 'plain', label: 'Объясни простыми словами', role: 'mentor'}];
  return [{id: 'total', label: 'Сколько заказываем сейчас?', q: 'итог'}, {id: 'late', label: 'Почему так много «Просрочено»?', q: 'просроч'}, {id: 'season', label: 'Готовы ли к сезонам?', q: 'сезон'}, {id: 'fill', label: 'Как считается доля поставки?', q: 'доля поставки'}];
}
const ctxKey = c => c ? c.type + ':' + c.id : '';
/* свободный вопрос о выбранном объекте: шаблон по словам вопроса */
function roleFor(q) {
  const n = norm(q);
  if (/прогноз|спрос|сезонн|тренд|индекс|упущ/.test(n)) return 'analyst';
  if (/постав|привез|плеч|впути|контейнер|письм|отгруз|fill/.test(n)) return 'logist';
  if (/простым|еслине|чтобудет|объясни|зачем/.test(n)) return 'mentor';
  return 'critic';
}
function refLabel(ref) {
  if (!ref) return '';
  if (ref.type === 'sku') return nameOf(ref.id);
  if (ref.type === 'supplier') return supNameOf(ref.id);
  if (ref.type === 'category') return catName(ref.id);
  if (ref.type === 'scenario') return SCENARIOS[ref.id] ? SCENARIOS[ref.id].title : ref.id === 'recalc' ? 'Пересчитать' : '';
  return '';
}
function refGo(ref) {
  if (!ref) return;
  if (ref.type === 'sku') openSku(ref.id);
  else if (ref.type === 'supplier') go('suppliers', {sub: ref.id});
  else if (ref.type === 'category') go('seasons', {sub: 'ready', query: {cat: ref.id}});
  else if (ref.type === 'scenario') go(SCEN_SECTION[ref.id] || 'plan');
}
const sameItem = (a, b) => a.title === b.title && JSON.stringify(a.ref || null) === JSON.stringify(b.ref || null);
function auditAdd({kind = 'proposal', title, text = '', ref = null, silent = false}) {
  const a = state.agent;
  if (a.audit.some(x => sameItem(x, {title, ref}))) { if (!silent) toast('Уже в замечаниях: ' + title); return null; }
  const item = {id: 'a' + (++auditSeq), kind, title, text, ref, status: 'open', date: dmy(today())};
  a.audit.push(item);
  updateAgentButton();
  if (a.open && a.tab === 'audit') renderAgentAudit();
  if (!silent) toast('Добавлено в замечания: ' + title, () => { a.audit = a.audit.filter(x => x.id !== item.id); a.feed.forEach(m => { if (m.audited === item.id) m.audited = null; }); updateAgentButton(); if (a.open) renderAgentPane(); });
  return item;
}
function feedPush(m) {
  const a = state.agent, item = {id: 'm' + (++feedSeq), ...m};
  a.feed.push(item); a.touched = true;
  if (a.open && a.tab === 'chat') appendFeed(item);
  return item;
}
function agentReply(build, key) {
  const a = state.agent;
  if (agentTimers[key]) { clearTimeout(agentTimers[key]); a.thinking = a.thinking.filter(x => x !== key); }
  a.thinking.push(key);
  renderThinking();
  agentTimers[key] = setTimeout(() => {
    delete agentTimers[key];
    a.thinking = a.thinking.filter(x => x !== key);
    const m = build();
    (Array.isArray(m) ? m : [m]).forEach(x => x && feedPush(x));
    renderThinking();
  }, agentDelay());
}
function agentAbout(ref, role) {
  const c = agentCtx();
  if (ref.type === 'sku' && SK[ref.id]) return AGENT.sku(role, SK[ref.id], c);
  if (ref.type === 'supplier' && SP[ref.id]) return AGENT.supplier(role, SP[ref.id], c);
  if (ref.type === 'category') return AGENT.category(role, ref.id, c);
  return null;
}
const aboutMsg = (ref, role) => { const m = agentAbout(ref, role); return m ? {...m, ref} : {kind: 'question', title: 'Готового ответа нет', text: 'Объект не найден в прогоне.', ref}; };
/* вопрос из поля ввода: названный объект → о нём; иначе выбранный контекст; иначе правила и общий ответ */
function agentAsk(text) {
  const a = state.agent, q = text.trim(), ctx = a.ctx;
  if (!q) return;
  feedPush({user: true, text: q, ctx});
  agentReply(() => {
    const role = roleFor(q), r = AGENT.question(role, q, agentCtx());
    if (r.ref && !(ctx && ctxKey(r.ref) === ctxKey(ctx))) return {...r.msg, ref: r.ref};
    if (ctx) return aboutMsg(ctx, role);
    const it = !r.found ? auditAdd({kind: 'question', title: 'Вопрос: ' + (q.length > 70 ? q.slice(0, 70) + '…' : q), text: q, silent: true}) : null;
    return {...r.msg, ref: r.ref, audited: it ? it.id : undefined};
  }, 'ask' + feedSeq);
}
function agentSuggest(id) {
  const a = state.agent, s = suggestions(a.ctx).find(x => x.id === id); if (!s) return;
  (a.used[ctxKey(a.ctx)] = a.used[ctxKey(a.ctx)] || new Set()).add(id);
  const ctx = a.ctx;
  feedPush({user: true, text: s.label, ctx});
  agentReply(() => ctx ? aboutMsg(ctx, s.role) : {...AGENT.question('critic', s.q, agentCtx()).msg}, 'sugg' + feedSeq);
}
function agentScenarioDone(id, info = {}) {
  const key = 'scen:' + id;
  state.agent.feed = state.agent.feed.filter(m => m.src !== key);
  agentReply(() => AGENT.scenario(id, info, agentCtx()).map(m => ({...m, ref: {type: 'scenario', id}, src: key})), key);
}
/* разметка панели строится один раз; дальше меняются отдельные узлы — фокус не теряется (B-55) */
function agentBuild() {
  $('#agent').innerHTML = `
    <div class="ag-head">
      <h2 id="ag-h">Агент</h2>
      <button type="button" class="ag-mock" id="ag-mock" data-tip="${MOCK_NOTE}" aria-describedby="ag-mock-d">Муляж${icon('info', 14)}</button><span id="ag-mock-d" hidden>${MOCK_NOTE}</span>
      <div class="ag-tabs" role="tablist" aria-label="Агент"><button type="button" role="tab" id="agt-chat" data-tab="chat" aria-controls="ag-chat">Разговор</button><button type="button" role="tab" id="agt-audit" data-tab="audit" aria-controls="ag-audit">Замечания<span class="cnt" id="ag-cnt"></span></button></div>
      <button class="btn btn-icon" type="button" id="ag-close" aria-label="Закрыть панель агента" data-tip="Закрыть · Esc">${icon('x', 18)}</button>
    </div>
    <section class="ag-pane" id="ag-chat" role="tabpanel" aria-labelledby="agt-chat">
      <div class="ag-scroll ag-feed" id="ag-feed" role="log" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Лента агента"></div>
      <p class="ag-think" id="ag-think" hidden>Агент думает…</p>
      <div class="ag-sugg" id="ag-sugg" role="group" aria-label="Подсказки-запросы"></div>
      <form class="ag-comp" id="ag-form"><div class="ag-box">
        <div class="ag-ctx" id="ag-ctx"></div>
        <label class="sr" for="ag-q">Вопрос агенту</label>
        <textarea id="ag-q" rows="1" placeholder="Спросите о плане, позиции или поставщике" aria-describedby="ag-q-d"></textarea><span id="ag-q-d" hidden>Enter — отправить, Shift+Enter — новая строка</span>
        <button class="ag-send" type="submit" id="ag-send" aria-label="Отправить" data-tip="Отправить · Enter" disabled>${icon('arrow-up', 16)}</button>
      </div></form>
    </section>
    <section class="ag-pane" id="ag-audit" role="tabpanel" aria-labelledby="agt-audit" hidden>
      <div class="ag-filter"><label class="sr" for="ag-flt">Тип замечаний</label><select id="ag-flt" class="ag-sel"><option value="">Все типы</option>${Object.entries(AGENT.kinds).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select><span class="spacer"></span><button class="btn btn-quiet btn-sm" type="button" id="ag-export">${icon('file-down', 14)}Отчёт .md</button></div>
      <div class="ag-scroll" id="ag-list" tabindex="0" aria-label="Список замечаний"></div>
    </section>`;
}
function renderAgentTabs() {
  const a = state.agent;
  $$('#agent [role=tab]').forEach(b => { const on = b.dataset.tab === a.tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  $('#ag-chat').hidden = a.tab !== 'chat'; $('#ag-audit').hidden = a.tab !== 'audit';
  updateAgentButton();
}
/* длинный ответ — по предложению в строке: сканируется, а не читается абзацем */
const paras = t => { const p = String(t).split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/); return (t.length > 140 && p.length > 1 ? p : [t]).map(x => `<p class="msg-text">${esc(x)}</p>`).join(''); };
const iconBtn = (attrs, ic, label) => `<button class="btn btn-icon btn-sm" type="button" ${attrs} aria-label="${esc(label)}" data-tip="${esc(label)}">${icon(ic, 16)}</button>`;
const auditedBtn = () => `<button class="btn btn-icon btn-sm is-done" type="button" aria-disabled="true" aria-label="Уже в замечаниях" data-tip="Уже в замечаниях">${icon('check', 16)}</button>`;
function msgHtml(m) {
  if (m.user) return `<article class="msg user" data-mid="${m.id}"><div class="bubble"><span class="sr">Вы: </span>${m.ctx ? `<span class="bub-ctx">${icon(REF_ICON[m.ctx.type] || 'tag', 12)}${esc(refLabel(m.ctx))}</span>` : ''}<p class="msg-text">${esc(m.text)}</p></div></article>`;
  const k = kindOf(m.kind), label = refLabel(m.ref), canAudit = m.kind !== 'info';
  return `<article class="msg" data-mid="${m.id}"><span class="ag-ic" style="color:var(${k.color})">${icon(k.icon, 18, k.label)}</span><div class="msg-body">
    <h3 class="msg-title">${esc(m.title)}</h3>${paras(m.text)}
    <div class="msg-acts">${label ? iconBtn(`data-ref="${m.id}"`, 'arrow-up-right', 'Открыть: ' + label) : ''}${canAudit ? (m.audited ? auditedBtn() : iconBtn(`data-toaudit="${m.id}"`, 'list-plus', 'В замечания')) : ''}${iconBtn(`data-copy="${m.id}"`, 'copy', 'Скопировать текст')}${iconBtn(`data-hide="${m.id}"`, 'x', 'Скрыть сообщение')}</div></div></article>`;
}
function renderAgentFeed() { const el = $('#ag-feed'); if (!el) return; el.innerHTML = state.agent.feed.map(msgHtml).join(''); el.scrollTop = el.scrollHeight; }
function appendFeed(m) { const el = $('#ag-feed'); if (!el) return; const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80; el.insertAdjacentHTML('beforeend', msgHtml(m)); if (stick || m.user) el.scrollTop = el.scrollHeight; }
function renderThinking() {
  const t = $('#ag-think'); if (!t) return;
  const busy = state.agent.thinking.length > 0; t.hidden = !busy;
  renderSugg();
  if (busy) { const f = $('#ag-feed'); if (f) f.scrollTop = f.scrollHeight; }
}
function renderSugg() {
  const a = state.agent, el = $('#ag-sugg'); if (!el) return;
  const used = a.used[ctxKey(a.ctx)] || new Set(), list = a.thinking.length ? [] : suggestions(a.ctx).filter(s => !used.has(s.id));
  const keep = el.contains(document.activeElement);
  el.innerHTML = list.map(s => `<button type="button" class="sugg" data-sugg="${s.id}">${esc(s.label)}</button>`).join('');
  el.hidden = !list.length;
  if (keep) $('#ag-q').focus();
}
function renderCtx() {
  const a = state.agent, el = $('#ag-ctx'); if (!el) return;
  const label = a.ctx ? refLabel(a.ctx) : '';
  el.innerHTML = a.ctx ? `<span class="ctx-chip">${icon(REF_ICON[a.ctx.type] || 'tag', 14)}<span class="ctx-l">${esc(label)}</span><button type="button" data-ctx-clear aria-label="Убрать контекст: ${esc(label)}" data-tip="Спросить обо всём плане">${icon('x', 14)}</button></span>` : '';
  el.hidden = !a.ctx;
  renderSugg();
}
function auditItemHtml(it) {
  const k = kindOf(it.kind), label = refLabel(it.ref);
  return `<article class="msg aitem st-${it.status}" data-aitem="${it.id}"><span class="ag-ic" style="color:var(${k.color})">${icon(k.icon, 18, k.label)}</span><div class="msg-body">
    <h3 class="msg-title">${esc(it.title)}</h3>${it.text ? paras(it.text) : ''}
    <div class="msg-acts"><label class="sr" for="ast-${it.id}">Статус: ${esc(it.title)}</label><select class="ag-sel st-sel" id="ast-${it.id}" data-ast="${it.id}">${AUDIT_STATUS.map(s => `<option value="${s.id}"${it.status === s.id ? ' selected' : ''}>${s.label}</option>`).join('')}</select>${label ? iconBtn(`data-aref="${it.id}"`, 'arrow-up-right', 'Открыть: ' + label) : ''}<span class="msg-date">${it.date}</span></div></div></article>`;
}
function renderAgentAudit() {
  const a = state.agent, el = $('#ag-list'); if (!el) return;
  $('#ag-flt').value = a.filter || '';
  const items = a.audit.filter(x => !a.filter || x.kind === a.filter);
  el.innerHTML = items.length ? items.map(auditItemHtml).join('') : '<p class="ag-empty">Замечаний такого типа нет.</p>';
}
function renderAgentPane() { renderAgentTabs(); if (state.agent.tab === 'chat') { renderAgentFeed(); renderCtx(); renderThinking(); } else renderAgentAudit(); }
function updateAgentButton() {
  const b = $('#btn-agent'), n = auditOpenCount();
  b.innerHTML = `${icon('bot')}Агент <span class="cnt">(${n})</span>`;
  b.setAttribute('aria-expanded', String(state.agent.open));
  b.setAttribute('aria-label', `Агент, открытых замечаний: ${n}`);
  const c = $('#ag-cnt'); if (c) { c.textContent = n || ''; c.hidden = !n; }
}
function auditReport() {
  const a = state.agent.audit, line = it => `### ${it.title}\n- Тип: ${kindOf(it.kind).label}\n${refLabel(it.ref) ? `- Объект: ${refLabel(it.ref)}\n` : ''}- Дата: ${it.date}\n\n${it.text || ''}\n`;
  return `# Замечания по плану закупок\n\nПрогон: ${dmy(today())}\nЗамечаний: ${a.length}, открыто: ${auditOpenCount()}\n\n` + AUDIT_STATUS.map(s => { const l = a.filter(x => x.status === s.id); return `## ${s.label} (${l.length})\n\n${l.length ? l.map(line).join('\n') : 'Нет.\n'}`; }).join('\n') + '\n' + MOCK_NOTE + '\n';
}
const growQ = () => { const q = $('#ag-q'); q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 160) + 'px'; $('#ag-send').disabled = !q.value.trim(); };
/* открыть панель; context — объект, о котором спрашивают: ставится чипом, первый вопрос задаётся сразу */
function agentOpen({context, tab} = {}) {
  const a = state.agent;
  if (!$('#drawer').hidden) closeDrawer(true);
  a.tab = tab || (context ? 'chat' : a.tab);
  a.open = true;
  $('#agent').hidden = false; document.body.classList.add('agent-open');
  if (context) a.ctx = {type: context.type, id: context.id};
  renderAgentPane();
  if (context) agentSuggest(suggestions(a.ctx)[0].id);
  if (a.tab === 'chat') $('#ag-q').focus(); else $('#agt-audit').focus();
}
function agentClose() {
  const inside = $('#agent').contains(document.activeElement);
  state.agent.open = false;
  $('#agent').hidden = true; document.body.classList.remove('agent-open');
  updateAgentButton();
  if (inside) $('#btn-agent').focus();
}
function agentInit() {
  const c = agentCtx(), a = state.agent;
  a.used = {}; a.ctx = null;
  a.audit = AGENT.preset(c).map(p => ({...p, id: 'a' + (++auditSeq), status: 'open', date: dmy(today())}));
  a.feed = [{id: 'm' + (++feedSeq), ...AGENT.greeting(c)}];
  agentBuild();
  const P = $('#agent');
  P.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'ag-close') return agentClose();
    if (t.id === 'ag-mock') { tipShow(t); return; }
    if (t.id === 'ag-export') { download(`zamechaniya-${today()}.md`, auditReport(), 'text/markdown;charset=utf-8'); toast(`Отчёт сохранён: zamechaniya-${today()}.md`); return; }
    if (t.dataset.tab) { a.tab = t.dataset.tab; renderAgentPane(); return; }
    if (t.dataset.sugg) { agentSuggest(t.dataset.sugg); $('#ag-q').focus(); return; }
    if (t.hasAttribute('data-ctx-clear')) { a.ctx = null; renderCtx(); $('#ag-q').focus(); say('Контекст снят: вопрос обо всём плане'); return; }
    if (t.dataset.hide) { a.feed = a.feed.filter(m => m.id !== t.dataset.hide); const art = t.closest('article'), next = art && (art.nextElementSibling || art.previousElementSibling); if (art) art.remove(); const f = next ? $('button', next) : $('#ag-q'); (f || $('#ag-q')).focus(); return; }
    if (t.dataset.copy) { const m = a.feed.find(x => x.id === t.dataset.copy); if (!m) return; const txt = m.title + '\n' + m.text; try { navigator.clipboard.writeText(txt).then(() => toast('Текст скопирован'), () => toast('Не удалось скопировать')); } catch (err) { toast('Не удалось скопировать'); } return; }
    if (t.dataset.ref) { refGo((a.feed.find(m => m.id === t.dataset.ref) || {}).ref); return; }
    if (t.dataset.aref) { refGo((a.audit.find(m => m.id === t.dataset.aref) || {}).ref); return; }
    if (t.dataset.toaudit) {
      const m = a.feed.find(x => x.id === t.dataset.toaudit); if (!m || m.audited) return;
      const it = auditAdd({kind: m.kind, title: m.title, text: m.text, ref: m.ref});
      if (it) { m.audited = it.id; t.outerHTML = auditedBtn(); const b = $(`[data-mid="${m.id}"] .is-done`); if (b) b.focus(); }
    }
  });
  P.addEventListener('change', e => {
    if (e.target.id === 'ag-flt') { a.filter = e.target.value; renderAgentAudit(); return; }
    const id = e.target.dataset.ast;
    if (id) { const it = a.audit.find(x => x.id === id); if (!it) return; it.status = e.target.value; const art = e.target.closest('article'); AUDIT_STATUS.forEach(s => art.classList.toggle('st-' + s.id, s.id === it.status)); updateAgentButton(); say('Статус: ' + AUDIT_STATUS.find(s => s.id === it.status).label); }
  });
  const q = $('#ag-q');
  q.addEventListener('input', growQ);
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#ag-form').requestSubmit(); } });
  $('#ag-form').addEventListener('submit', e => { e.preventDefault(); if (!q.value.trim()) return; agentAsk(q.value); q.value = ''; growQ(); q.focus(); });
  tabKeys(P, '[role=tab]', b => { a.tab = b.dataset.tab; renderAgentPane(); });
  updateAgentButton();
}

/* ===== маршрутизатор и каркас ===== */
const SECTIONS = {
  home: {title: 'Главная', render: renderHome},
  plan: {title: 'План закупок', render: renderPlan, badge: () => ({n: R.kpi.late, label: 'просрочено'})},
  table: {title: 'Сводная таблица', render: renderTable},
  seasons: {title: 'Сезоны и запасы', render: renderSeasons},
  suppliers: {title: 'Поставщики', render: renderSuppliers},
  assortment: {title: 'Ассортимент и цены', render: renderAssortment},
  run: {title: 'Данные и проверки', render: renderRun, hidden: true}
};
function renderNav() {
  $('#nav-links').innerHTML = Object.entries(SECTIONS).filter(([, s]) => !s.hidden).map(([k, s]) => { const b = s.badge && s.badge(); return `<a href="#${k}" data-s="${k}">${s.title}${b ? `<span class="cnt" title="${b.label}: ${b.n}" aria-label="${b.label}: ${b.n}">${fmt(b.n)}</span>` : ''}</a>`; }).join('');
  $$('#nav-links a').forEach(a => { if (a.dataset.s === state.section) a.setAttribute('aria-current', 'page'); });
}
function updateChrome() {
  renderNav();
  const p = R.params, t = RUNLOG.at ? RUNLOG.at.toTimeString().slice(0, 5) : '';
  const changed = Object.keys(state.params).length || Object.keys(state.overrides).length || SOURCE.kind === 'upload';
  const nOv = Object.keys(state.overrides).length;
  $('#top-run').innerHTML = `<a href="#run">Данные на ${dmy(R.today)}</a>${nOv ? ` · <button class="link" type="button" id="undo-move">отменить перенос (${nOv})</button>` : ''}<span class="sub">${changed ? 'Пересчитано' : 'Прогон'} ${t} · ${p.coverDays} дн / ${p.minMarkup} %${p.fillMethod === 'erp' ? ' / ERP' : ''} · проверки ${RUNLOG.selftest.ok}/${RUNLOG.selftest.all}</span>`;
  updateAgentButton();
}
function refreshSection() { killCharts(); const main = $('#main'); main.onclick = null; main.onchange = null; const s = SECTIONS[state.section]; const fresh = main.cloneNode(false); main.replaceWith(fresh); s.render(fresh); }
function render() {
  const r = parseHash(location.hash);
  if (!SECTIONS[r.sec]) { history.replaceState(null, '', '#home'); r.sec = 'home'; r.sub = null; r.query = {}; }
  const changed = r.sec !== state.section;
  state.route = r; state.section = r.sec;
  killCharts(); hideToast();
  if (renderTable.closePop && state.table.pop) state.table.pop = null;
  const s = SECTIONS[r.sec];
  renderNav();
  $('#title').textContent = s.title + (r.sec === 'suppliers' && r.sub && SP[r.sub] ? ' · ' + SP[r.sub].name : '');
  document.title = s.title + ' · Планирование закупок';
  const old = $('#main'), main = old.cloneNode(false);   // свежий узел: без старых обработчиков
  old.replaceWith(main);
  window.scrollTo(0, 0);
  s.render(main);
  if (changed) say('Раздел: ' + s.title);
}
window.addEventListener('hashchange', () => { if (!$('#drawer').hidden) closeDrawer(true); if (!$('#modal-wrap').hidden && !modalBusy) closeModal(); render(); $('#main').focus({preventScroll: true}); });
window.addEventListener('resize', () => { ['#plan-wrap', '#t-wrap', '#def-wrap', '#sup-wrap'].forEach(id => { const w = $(id); if (w) fitWrap(w, id === '#plan-wrap' ? 56 : id === '#def-wrap' ? 72 : 16); }); });
document.addEventListener('keydown', e => {
  const modalOpen = !$('#modal-wrap').hidden;
  if (e.key === 'Escape') {
    if (tipOpen()) { e.preventDefault(); tipHide(); return; }
    if (state.section === 'table' && state.table.pop && !modalOpen && $('#drawer').hidden) { e.preventDefault(); renderTable.closePop(true); return; }
    if (modalOpen) { e.preventDefault(); closeModal(); }
    else if (!$('#drawer').hidden) { e.preventDefault(); closeDrawer(); }
    else if (state.agent.open) { e.preventDefault(); agentClose(); }
    return;
  }
  const trap = modalOpen ? $('#modal') : !$('#drawer').hidden ? $('#drawer') : null;
  if (e.key === 'Tab' && trap) {
    const f = focusables(trap); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!trap.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ===== старт ===== */
setResult(runEngine({}));
$('#btn-recalc').innerHTML = `${icon('refresh-cw')}Пересчитать`;
$('#btn-recalc').onclick = openRecalc;
$('#btn-agent').onclick = () => state.agent.open ? agentClose() : agentOpen();
$('#d-close').innerHTML = icon('x', 18);
$('#d-close').onclick = () => closeDrawer();
$('#scrim').onclick = () => closeDrawer();
$('#m-close').innerHTML = icon('x', 18);
$('#m-close').onclick = closeModal;
$('#modal-wrap').addEventListener('mousedown', e => { if (e.target === e.currentTarget && !modalBusy) closeModal(); });
$('#m-body').addEventListener('click', e => { const k = e.target.closest('[data-sku]'); if (k) { closeModal(); openSku(k.dataset.sku); } });
$('#skip').onclick = e => { e.preventDefault(); $('#main').focus(); };
$('#top-run').addEventListener('click', e => { if (e.target.id === 'undo-move') { state.overrides = {}; recompute(); refreshSection(); toast('Перенос отменён, план пересчитан'); $('#btn-recalc').focus(); } });
agentInit();
updateChrome();
render();
