/* engine.js — расчётное ядро прототипа v6 (волна 1).
   Чистый модуль без DOM: в браузере — глобальный Engine, в node — module.exports.
   API: parseCSV(text) · ingest(csvTextsByName) → compact · run(compact, params) → result
        selftest(result, compact) → [{name, ok, expected, actual}] · diff(prev, cur) · defaults
        toLegacy(result) → глобалы в форме v5 (для app.js до переписывания) · snapshotJs(compact) → текст data.js
        stableJSON(result) → JSON без времени прогона (для сравнения node / браузер).
   Как пересобрать снимок и проверить числа — README.md.
   Даты внутри — целые дни от 1970-01-01 (UTC), наружу — ISO-строки. Часовой пояс не влияет. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '6.0.0';
const DAY = 86400000;
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

/* ================= параметры ================= */
const defaults = {
  today: '2026-08-13',        // «сегодня»
  coverDays: 90,              // C, покрытие после прихода
  cycleDays: 30,              // R, цикл заказа
  minMarkup: 25,              // порог наценки, %
  leadDefault: 123,           // плечо, если у поставщика нет ни факта, ни плана
  leadDefaultP90: 205,
  leadNoSupplier: 150,        // плечо для позиций без поставщика
  overMonths: 18,             // порог избытка
  serviceA: 0.90, serviceB: 0.85, serviceC: 0.80,
  bufferDays: 14,
  fillMethod: 'receipts',     // 'receipts' — сверка PO с приходами; 'erp' — поле qty_received
  fillWindowDays: 180,        // окно сверки после promised_date
  fillLookbackDays: 1095,     // какие закрытые PO берём в fill (выгрузка PO начинается 05.2024 — берём все)
  fillSmoothN: 5,             // сглаживание к среднему при n < 5 PO
  compensateFill: false,      // компенсировать fill в количестве (Q / max(fill; 0,5))
  lateLossShare: 0.25,        // порог существенных потерь для late, доля месячного спроса
  tailCQtyYear: 24,           // «хвост C» для интерфейса, шт/год
  horizonDays: 540,           // дневная проекция (расширяется до порога избытка)
  blockNoReceiptDays: 365,    // блокировка: нет приходов N дн…
  blockPoLookbackDays: 730,   // …при заказах за N дн
  blockFill: 0.1,             // или fill ниже порога
  overduePoDays: 30,          // просрочка PO, после которой ожидаем 0
  altFillMin: 0.7,            // альтернативный поставщик: fill не ниже
  seasonShare: 0.7,           // окно сезона — кратчайший отрезок с ≥ 70 % года
  seasonalCV: 0.3,            // CV индекса категории, выше — сезонная
  seasonMaxMonths: 6,         // окно длиннее — «умеренная сезонность», без сезонного правила
  trendMin: 0.6, trendMax: 1.6,
  newMonths: 6,               // новинка: от первой продажи меньше N мес
  intermittentShare: 0.5,     // прерывистый: доля нулевых месяцев за 12 мес
  sbaAlpha: 0.1,
  containerKg: 26000,         // контейнер по весу (объёма в данных нет)
  signalsTop: 5,
  supplierOverride: null      // {SKU-…: SUP-…} — сценарий «перенести на альтернативу»
};
const PARAM_RANGES = {
  coverDays: [7, 365], cycleDays: [7, 120], minMarkup: [0, 100], leadDefault: [7, 365], leadDefaultP90: [7, 400],
  leadNoSupplier: [7, 365], overMonths: [6, 60], serviceA: [0.5, 0.999], serviceB: [0.5, 0.999], serviceC: [0.5, 0.999],
  bufferDays: [0, 60], fillWindowDays: [30, 365], fillLookbackDays: [180, 3650], fillSmoothN: [0, 20], lateLossShare: [0, 3],
  tailCQtyYear: [0, 1000], horizonDays: [180, 900], blockNoReceiptDays: [90, 1095], blockPoLookbackDays: [90, 1825],
  blockFill: [0, 0.5], overduePoDays: [0, 180], altFillMin: [0, 1], seasonShare: [0.5, 0.95], seasonalCV: [0.05, 1.5],
  seasonMaxMonths: [2, 11], trendMin: [0.2, 1], trendMax: [1, 3], newMonths: [1, 24], intermittentShare: [0.2, 0.9],
  sbaAlpha: [0.01, 0.5], containerKg: [1000, 30000], signalsTop: [1, 20]
};
function resolveParams(p) {
  const P = Object.assign({}, defaults, p || {});
  const errors = [];
  for (const k in PARAM_RANGES) {
    const v = +P[k], [lo, hi] = PARAM_RANGES[k];
    if (!isFinite(v)) { errors.push(k + ': не число'); P[k] = defaults[k]; continue; }
    if (v < lo || v > hi) errors.push(`${k}: ${v} вне диапазона ${lo}…${hi}`);
    P[k] = Math.min(hi, Math.max(lo, v));
  }
  if (!/^\d{4}-\d\d-\d\d$/.test(String(P.today))) { errors.push('today: ожидается YYYY-MM-DD'); P.today = defaults.today; }
  if (P.fillMethod !== 'receipts' && P.fillMethod !== 'erp') { errors.push('fillMethod: receipts | erp'); P.fillMethod = 'receipts'; }
  P.compensateFill = !!P.compensateFill;
  return {P, errors};
}

/* ================= даты и числа ================= */
/* григорианский календарь арифметикой (H. Hinnant, days_from_civil / civil_from_days): быстро и без Date */
function fromCivil(y, m, d) { y -= m <= 2 ? 1 : 0; const era = Math.floor(y / 400), yoe = y - era * 400, doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; return era * 146097 + doe - 719468; }
function toCivil(z) { z += 719468; const era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9); return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d]; }
const p2 = x => (x < 10 ? '0' : '') + x;
function dnum(s) { return fromCivil(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)); }
function iso(d) { if (d == null) return null; const c = toCivil(d); return c[0] + '-' + p2(c[1]) + '-' + p2(c[2]); }
function mnum(s) { return (+s.slice(0, 4)) * 12 + (+s.slice(5, 7)) - 1; }
function mstr(mi) { const y = Math.floor(mi / 12), m = mi - y * 12 + 1; return y + '-' + p2(m); }
function mStart(mi) { const y = Math.floor(mi / 12); return fromCivil(y, mi - y * 12 + 1, 1); }
function mDays(mi) { return mStart(mi + 1) - mStart(mi); }
function dayMonth(d) { const c = toCivil(d); return c[0] * 12 + c[1] - 1; }
function dayOfMonth(d) { return toCivil(d)[2]; }
const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MON_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const r0 = x => Math.round(x);
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
function sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
function quantile(a, p) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), h = (s.length - 1) * p, lo = Math.floor(h); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (h - lo); }
function std(a) { if (a.length < 2) return 0; const m = sum(a) / a.length; let v = 0; for (const x of a) v += (x - m) * (x - m); return Math.sqrt(v / (a.length - 1)); }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/* обратная функция нормального распределения (Acklam) */
function zOf(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -zOf(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/* формат: разряды неразрывным пробелом, запятая, дд.мм.гггг — без Intl, чтобы node и браузер совпадали */
function fmtN(n) {
  if (n == null || !isFinite(n)) return '—';
  const v = Math.round(n), s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) { if (i && (s.length - i) % 3 === 0) out += ' '; out += s[i]; }
  return (v < 0 ? '−' : '') + out;
}
const fmtF = (x, k = 2) => x == null ? '—' : x.toFixed(k).replace('.', ',');
const fmtD = d => { if (d == null) return '—'; const s = iso(d); return s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4); };
const fmtM = mi => { const s = mstr(mi); return s.slice(5, 7) + '.' + s.slice(0, 4); };
const fmtPct = x => Math.round(x * 100) + ' %';
function fit(cands, max = 60) { for (const c of cands) if (c.length <= max) return c; const c = cands[cands.length - 1]; return c.length <= max ? c : c.slice(0, max - 1) + '…'; }
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }

/* ================= CSV ================= */
function parseCSV(text) {
  if (typeof text !== 'string') throw new Error('parseCSV: ожидается текст');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let i = 0, field = '', row = [], q = false;
  const n = text.length;
  if (text.indexOf('"') < 0) { // быстрый путь
    const lines = text.split(/\r?\n/);
    for (const l of lines) if (l.length) rows.push(l.split(','));
  } else {
    while (i < n) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
      else field += ch;
      i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
  }
  if (!rows.length) return {cols: [], rows: []};
  return {cols: rows[0].map(s => s.trim()), rows: rows.slice(1)};
}

/* ================= ingest: 6 CSV → компактный снимок ================= */
const SCHEMA = {
  sku_dim: ['sku_id', 'category', 'supplier_id', 'supply_type', 'weight_kg', 'price_decile', 'first_sale_month', 'last_sale_month', 'months_with_sales', 'avg_markup_pct_12m', 'on_order_qty'],
  sales_monthly: ['sku_id', 'month', 'qty_sold', 'qty_returned', 'partial_month'],
  stock_monthly: ['sku_id', 'month', 'stock_qty'],
  purchase_orders: ['po_id', 'sku_id', 'supplier_id', 'order_date', 'promised_date', 'planned_lead_days', 'status', 'qty_ordered', 'qty_confirmed', 'qty_received', 'qty_pending'],
  receipts: ['sku_id', 'receipt_date', 'qty', 'supplier_id'],
  supplier_dim: ['supplier_id', 'supply_type', 'median_planned_lead_days']
};
const FILES = Object.keys(SCHEMA);
function normName(k) { return String(k).replace(/^.*[\\/]/, '').replace(/\.csv$/i, '').trim(); }
function num(v) { if (v == null || v === '') return null; const x = +v; return isFinite(x) ? x : null; }

function ingest(texts) {
  const T = {};
  for (const k in texts) T[normName(k)] = texts[k];
  const tables = {}, warnings = [];
  for (const f of FILES) {
    if (T[f] == null) throw new Error(`Нет файла ${f}.csv`);
    const t = parseCSV(T[f]);
    const idx = {};
    t.cols.forEach((c, i) => idx[c] = i);
    for (const c of SCHEMA[f]) if (idx[c] == null) throw new Error(`Файл ${f}.csv: нет колонки «${c}»`);
    tables[f] = {idx, rows: t.rows, cols: t.cols};
  }
  const col = (f, r, c) => { const i = tables[f].idx[c]; return i == null ? '' : (r[i] == null ? '' : r[i]); };

  // справочник товаров — колонки
  const S = tables.sku_dim, skuIdx = new Map();
  const sk = {id: [], cat: [], brand: [], sup: [], st: [], uom: [], w: [], wm: [], tcd: [], dec: [], fs: [], ls: [], mws: [], qt: [], mk: [], oo: [], cr: []};
  S.rows.forEach(r => {
    const id = col('sku_dim', r, 'sku_id');
    if (!id) return;
    if (skuIdx.has(id)) { warnings.push('sku_dim: дубль ' + id); return; }
    skuIdx.set(id, sk.id.length);
    sk.id.push(id); sk.cat.push(col('sku_dim', r, 'category')); sk.brand.push(col('sku_dim', r, 'brand_id'));
    sk.sup.push(col('sku_dim', r, 'supplier_id')); sk.st.push(col('sku_dim', r, 'supply_type')); sk.uom.push(col('sku_dim', r, 'uom'));
    sk.w.push(num(col('sku_dim', r, 'weight_kg'))); sk.wm.push(num(col('sku_dim', r, 'warranty_months'))); sk.tcd.push(num(col('sku_dim', r, 'target_cover_days')));
    sk.dec.push(num(col('sku_dim', r, 'price_decile'))); sk.fs.push(col('sku_dim', r, 'first_sale_month')); sk.ls.push(col('sku_dim', r, 'last_sale_month'));
    sk.mws.push(num(col('sku_dim', r, 'months_with_sales'))); sk.qt.push(num(col('sku_dim', r, 'qty_total'))); sk.mk.push(num(col('sku_dim', r, 'avg_markup_pct_12m')));
    sk.oo.push(num(col('sku_dim', r, 'on_order_qty')) || 0); sk.cr.push(col('sku_dim', r, 'created'));
  });
  const n = sk.id.length;

  // продажи: по SKU первый месяц и плотные массивы (null — пропуск календаря)
  const sales = {m0: new Array(n).fill(null), q: [], r: [], mk: []};
  const tmp = Array.from({length: n}, () => []);
  let partial = {}, salesRows = 0, monthMin = null, monthMax = null, catMismatch = 0, unknownSku = 0;
  for (const r of tables.sales_monthly.rows) {
    const id = col('sales_monthly', r, 'sku_id'), i = skuIdx.get(id);
    if (i == null) { unknownSku++; continue; }
    const m = col('sales_monthly', r, 'month');
    const c = col('sales_monthly', r, 'category');
    if (c && c !== sk.cat[i]) catMismatch++;
    tmp[i].push([mnum(m), +col('sales_monthly', r, 'qty_sold') || 0, +col('sales_monthly', r, 'qty_returned') || 0, num(col('sales_monthly', r, 'markup_pct'))]);
    if (col('sales_monthly', r, 'partial_month') === '1') partial[m] = (partial[m] || 0) + 1;
    salesRows++;
    if (monthMin == null || m < monthMin) monthMin = m;
    if (monthMax == null || m > monthMax) monthMax = m;
  }
  if (unknownSku) warnings.push(`sales_monthly: ${unknownSku} строк с кодом не из sku_dim пропущено`);
  if (catMismatch) warnings.push(`sales_monthly: категория не совпадает с sku_dim в ${catMismatch} строках`);
  let gaps = 0;
  for (let i = 0; i < n; i++) {
    const a = tmp[i].sort((x, y) => x[0] - y[0]);
    if (!a.length) { sales.q.push([]); sales.r.push([]); sales.mk.push([]); continue; }
    const m0 = a[0][0], len = a[a.length - 1][0] - m0 + 1, q = new Array(len).fill(null), rr = [], mk = [];
    for (const [m, s, ret, mkp] of a) { q[m - m0] = s; if (ret) rr.push(m - m0, ret); if (mkp != null) mk.push(m - m0, mkp); }
    gaps += q.filter(v => v == null).length;
    sales.m0[i] = mstr(m0); sales.q.push(q); sales.r.push(rr); sales.mk.push(mk);
  }
  if (gaps) warnings.push(`sales_monthly: ${gaps} пропусков календаря (null в массиве)`);

  // остатки на 1-е число: [смещение месяца от stockBase, остаток, …]
  let stockMin = null;
  for (const r of tables.stock_monthly.rows) { const m = col('stock_monthly', r, 'month'); if (stockMin == null || m < stockMin) stockMin = m; }
  const sb = stockMin ? mnum(stockMin) : 0, stock = Array.from({length: n}, () => []);
  let stockRows = 0;
  for (const r of tables.stock_monthly.rows) {
    const i = skuIdx.get(col('stock_monthly', r, 'sku_id'));
    if (i == null) continue;
    stock[i].push(mnum(col('stock_monthly', r, 'month')) - sb, +col('stock_monthly', r, 'stock_qty') || 0);
    stockRows++;
  }
  stock.forEach(a => { const p = []; for (let k = 0; k < a.length; k += 2) p.push([a[k], a[k + 1]]); p.sort((x, y) => x[0] - y[0]); a.length = 0; p.forEach(x => a.push(x[0], x[1])); });

  // заказы поставщикам
  const po = {id: [], sku: [], sup: [], st: [], od: [], pd: [], pl: [], status: [], qo: [], qc: [], qr: [], qp: []};
  for (const r of tables.purchase_orders.rows) {
    const i = skuIdx.get(col('purchase_orders', r, 'sku_id'));
    po.id.push(col('purchase_orders', r, 'po_id')); po.sku.push(i == null ? -1 : i);
    po.sup.push(col('purchase_orders', r, 'supplier_id')); po.st.push(col('purchase_orders', r, 'supply_type'));
    po.od.push(col('purchase_orders', r, 'order_date')); po.pd.push(col('purchase_orders', r, 'promised_date'));
    po.pl.push(num(col('purchase_orders', r, 'planned_lead_days'))); po.status.push(col('purchase_orders', r, 'status'));
    po.qo.push(+col('purchase_orders', r, 'qty_ordered') || 0); po.qc.push(+col('purchase_orders', r, 'qty_confirmed') || 0);
    po.qr.push(+col('purchase_orders', r, 'qty_received') || 0); po.qp.push(+col('purchase_orders', r, 'qty_pending') || 0);
  }
  // приходы
  const rc = {sku: [], d: [], q: [], sup: [], st: []};
  let rcMax = null;
  for (const r of tables.receipts.rows) {
    const i = skuIdx.get(col('receipts', r, 'sku_id'));
    const d = col('receipts', r, 'receipt_date');
    rc.sku.push(i == null ? -1 : i); rc.d.push(d); rc.q.push(+col('receipts', r, 'qty') || 0);
    rc.sup.push(col('receipts', r, 'supplier_id')); rc.st.push(col('receipts', r, 'supply_type'));
    if (rcMax == null || d > rcMax) rcMax = d;
  }
  // поставщики
  const sp = {id: [], st: [], cnt: [], skus: [], mdbr: [], mpl: []};
  for (const r of tables.supplier_dim.rows) {
    sp.id.push(col('supplier_dim', r, 'supplier_id')); sp.st.push(col('supplier_dim', r, 'supply_type'));
    sp.cnt.push(num(col('supplier_dim', r, 'receipts_cnt'))); sp.skus.push(num(col('supplier_dim', r, 'skus')));
    sp.mdbr.push(num(col('supplier_dim', r, 'median_days_between_receipts'))); sp.mpl.push(num(col('supplier_dim', r, 'median_planned_lead_days')));
  }
  const partialMonths = Object.keys(partial).sort();
  return {
    format: 'velsa-compact/1',
    meta: {
      rows: {sku_dim: n, sales_monthly: salesRows, stock_monthly: stockRows, purchase_orders: po.id.length, receipts: rc.d.length, supplier_dim: sp.id.length},
      monthFirst: monthMin, monthLast: monthMax, partialMonths, partialRows: partialMonths.map(m => partial[m]),
      stockBase: stockMin, receiptsLast: rcMax, warnings
    },
    sku: sk, sales, stock, po, rc, sup: sp
  };
}

/* снимок data.js: шапка-комментарий + var VELSA_DATA */
function snapshotJs(compact, built) {
  const m = compact.meta, R = m.rows;
  const head = [
    '/* data.js — компактный снимок сырых входов для dashboard/ (результат Engine.ingest).',
    '   Источник: share/*.csv (обезличенная выгрузка ERP). Продажи ' + m.monthFirst + '…' + m.monthLast + (m.partialMonths.length ? ' (неполный ' + m.partialMonths.join(', ') + ')' : '') + ', остатки с ' + m.stockBase + ', последний приход ' + m.receiptsLast + '.',
    '   Строк: sku_dim ' + R.sku_dim + ' · sales_monthly ' + R.sales_monthly + ' · stock_monthly ' + R.stock_monthly + ' · purchase_orders ' + R.purchase_orders + ' · receipts ' + R.receipts + ' · supplier_dim ' + R.supplier_dim + '.',
    '   Собран ' + (built || new Date().toISOString().slice(0, 10)) + ' командой из README.md. Руками не править: пересобрать из CSV.',
    '   Формат: колонки справочников, по SKU — плотные массивы продаж от первого месяца, возвраты и markup_pct разреженно [смещение, значение]. Не вошли: orders_cnt. */'
  ].join('\n');
  return head + '\nvar VELSA_DATA = ' + JSON.stringify(compact) + ';\n';
}

/* текст data.js → compact (для node и для проверки скачанного снимка) */
function loadSnapshot(text) { const k = text.indexOf('var VELSA_DATA = '); if (k < 0) throw new Error('loadSnapshot: нет «var VELSA_DATA = »'); return JSON.parse(text.slice(k + 17, text.lastIndexOf(';'))); }

/* ================= словарь условных названий ================= */
const CAT_ORDER = ['string_trimmers', 'trimmer_blades_accessories', 'space_heaters', 'sanitary_faucets', 'concrete_mixers', 'grain_mills'];
const CAT_RU = {string_trimmers: 'Триммеры', trimmer_blades_accessories: 'Оснастка триммеров', space_heaters: 'Обогреватели', sanitary_faucets: 'Смесители', concrete_mixers: 'Бетономешалки', grain_mills: 'Зернодробилки'};
const SKU_VOCAB = {
  string_trimmers: [{t: 'Триммер бензиновый', p: 'TR'}, {t: 'Триммер электрический', p: 'TE'}, {t: 'Триммер аккумуляторный', p: 'TA'}, {t: 'Мотокоса', p: 'MK'}],
  trimmer_blades_accessories: [{t: 'Леска для триммера', p: 'LS', a: ['2,0 мм', '2,4 мм', '3,0 мм']}, {t: 'Нож для триммера', p: 'NB', a: ['трёхлопастной', 'четырёхлопастной', 'восьмизубый']}, {t: 'Катушка триммерная', p: 'KT'}, {t: 'Диск для мотокосы', p: 'DK', a: ['40 зубьев', '80 зубьев']}, {t: 'Ремень разгрузочный', p: 'RR'}],
  space_heaters: [{t: 'Конвектор', p: 'KV', a: ['1,5 кВт', '2 кВт']}, {t: 'Масляный обогреватель', p: 'MO', a: ['7 секций', '9 секций', '11 секций']}, {t: 'Тепловентилятор', p: 'TV', a: ['2 кВт']}, {t: 'Тепловая пушка', p: 'TP', a: ['3 кВт', '5 кВт']}, {t: 'Инфракрасный обогреватель', p: 'IR'}],
  sanitary_faucets: [{t: 'Смеситель для кухни', p: 'SK'}, {t: 'Смеситель для ванны', p: 'SV'}, {t: 'Смеситель для раковины', p: 'SR'}, {t: 'Смеситель для душа', p: 'SD'}, {t: 'Смеситель для биде', p: 'SB'}],
  concrete_mixers: [{t: 'Бетономешалка', p: 'BM', a: ['63 л', '120 л', '140 л', '160 л', '180 л']}],
  grain_mills: [{t: 'Зернодробилка', p: 'ZD', a: ['180 кг/ч', '250 кг/ч', '350 кг/ч']}, {t: 'Кормоизмельчитель', p: 'KI'}]
};
/* названия из v5 оставлены там, где категория в данных совпала (сюжеты видео) */
const SKU_KEEP = {'SKU-C574D6': ['string_trimmers', 'Триммер бензиновый TR-520'], 'SKU-D55358': ['concrete_mixers', 'Бетономешалка 160 л BM-160'], 'SKU-05126E': ['concrete_mixers', 'Бетономешалка 120 л BM-120'],
  'SKU-19BE7F': ['space_heaters', 'Конвектор 2 кВт KV-200'], 'SKU-FE79E7': ['space_heaters', 'Масляный обогреватель 9 секций MO-109'], 'SKU-6669CE': ['space_heaters', 'Тепловентилятор 2 кВт TV-220'],
  'SKU-98CE0E': ['sanitary_faucets', 'Смеситель для кухни, хром SK-310'], 'SKU-07CC65': ['sanitary_faucets', 'Смеситель для ванны с душем SV-420']};
const SUP_KIND_IMPORT = {string_trimmers: 'Garden Power Co.', trimmer_blades_accessories: 'Trimmer Line Co.', space_heaters: 'Heating Appliances Co.', sanitary_faucets: 'Sanitary Ware Co.', concrete_mixers: 'Construction Machinery Co.', grain_mills: 'Agri Machinery Co.'};
const SUP_KIND_LOCAL = {string_trimmers: 'Garden Tehnic', trimmer_blades_accessories: 'Accesorii Gradina', space_heaters: 'Termo', sanitary_faucets: 'Sanitare', concrete_mixers: 'Utilaje', grain_mills: 'Agro Utilaje'};
const CITIES_CN = ['Ningbo', 'Yongkang', 'Taizhou', 'Jinhua', 'Wenzhou', 'Foshan', 'Xiamen', 'Hangzhou', 'Suzhou', 'Changzhou', 'Qingdao', 'Shenzhen', 'Tianjin', 'Dongguan', 'Jiangmen', 'Zhongshan', 'Shaoxing', 'Wuxi', 'Nantong', 'Yangzhou', 'Linyi', 'Weifang', 'Jinan', 'Hefei', 'Wuhan', 'Chengdu', 'Zhengzhou', 'Shijiazhuang', 'Baoding', 'Cangzhou', 'Huzhou', 'Jiaxing', 'Quanzhou', 'Fuzhou', 'Putian', 'Shantou', 'Zhuhai', 'Hebei', 'Guangdong', 'Yiwu', 'Kunshan', 'Changsha'];
const CITIES_RO = ['Cluj', 'Brasov', 'Iasi', 'Timisoara', 'Oradea', 'Sibiu', 'Constanta', 'Craiova', 'Arad', 'Ploiesti'];
const SUP_KEEP_CITY = {'SUP-D58E64': 'Ningbo', 'SUP-357414': 'Hebei', 'SUP-7416CE': 'Guangdong'};

function buildNames(C, supMainCat, supType) {
  const sku = {}, used = new Set();
  for (let i = 0; i < C.sku.id.length; i++) {
    const id = C.sku.id[i], cat = C.sku.cat[i], keep = SKU_KEEP[id];
    if (keep && keep[0] === cat && !used.has(keep[1])) { sku[id] = keep[1]; used.add(keep[1]); continue; }
    const V = SKU_VOCAB[cat] || [{t: CAT_RU[cat] || cat, p: 'XX'}], h = fnv(id), v = V[h % V.length];
    const attr = v.a ? ' ' + v.a[(h >>> 8) % v.a.length] : '';
    const pro = (C.sku.dec[i] || 0) >= 8 ? ', проф' : '';
    let k = 100 + ((h >>> 12) % 900), name;
    do { name = `${v.t}${attr} ${v.p}-${k}${pro}`; k = k >= 999 ? 100 : k + 1; } while (used.has(name));
    used.add(name); sku[id] = name;
  }
  const sup = {}, usedCity = new Set(Object.values(SUP_KEEP_CITY)), ids = Object.keys(supMainCat).sort();
  ids.forEach(id => {
    const cat = supMainCat[id], local = supType[id] === 'local';
    if (local) {
      const pool = CITIES_RO; let j = fnv(id) % pool.length, nm;
      for (let t = 0; t < pool.length * 2; t++) { nm = `${SUP_KIND_LOCAL[cat] || 'Comert'} ${pool[(j + t) % pool.length]} SRL`; if (!Object.values(sup).includes(nm)) break; }
      sup[id] = nm;
    } else {
      let city = SUP_KEEP_CITY[id];
      if (!city) { let j = fnv(id) % CITIES_CN.length; for (let t = 0; t < CITIES_CN.length; t++) { const c = CITIES_CN[(j + t) % CITIES_CN.length]; if (!usedCity.has(c)) { city = c; break; } } usedCity.add(city); }
      sup[id] = `${city} ${SUP_KIND_IMPORT[cat] || 'Trading Co.'}`;
    }
  });
  return {sku, sup};
}

/* ================= проекция остатка по дням ================= */
/* arrivals: [[t, q], …] по возрастанию t; P[t] — остаток в начале дня t после приходов, L[t] — потери дня */
function project(start, fd, H, arr, P, L) {
  let p = start, ai = 0;
  for (let t = 0; t < H; t++) {
    while (ai < arr.length && arr[ai][0] <= t) { p += arr[ai][1]; ai++; }
    P[t] = p;
    const dem = fd[t];
    if (dem <= p) { p -= dem; L[t] = 0; } else { L[t] = dem - p; p = 0; }
  }
  return p;
}
function firstOut(P, L, fd, H) { for (let t = 0; t < H; t++) { if (fd[t] > 1e-9 && P[t] - fd[t] + L[t] <= 1e-9) return t; } return null; }
function firstBelow(P, L, fd, ssDay, H) { for (let t = 0; t < H; t++) { const e = P[t] - fd[t] + L[t]; if ((fd[t] > 1e-9 && e <= 1e-9) || e < ssDay[t] - 1e-9) return t; } return null; }
function sumRange(a, from, to) { let s = 0; const hi = Math.min(to, a.length); for (let t = Math.max(0, from); t < hi; t++) s += a[t]; return s; }

/* ================= run ================= */
function run(compact, params) {
  const t0 = nowMs(), timing = {};
  const mark = k => { timing[k] = r2(nowMs() - t0 - Object.keys(timing).reduce((a, x) => a + timing[x], 0)); };
  if (!compact || compact.format !== 'velsa-compact/1') throw new Error('run: ожидается снимок Engine.ingest (velsa-compact/1)');
  const {P: PR, errors: paramErrors} = resolveParams(params);
  const C = compact, n = C.sku.id.length;
  const TODAY = dnum(PR.today), CUR = dayMonth(TODAY), DOM = dayOfMonth(TODAY);
  const H = Math.max(PR.horizonDays, Math.round(PR.overMonths * 30.4375));
  const OVER_T = Math.min(H - 1, Math.round(PR.overMonths * 30.4375));
  const HF = H + 420;
  const R = PR.cycleDays, CV_ = PR.coverDays, BUF = PR.bufferDays;
  const stockBase = C.meta.stockBase ? mnum(C.meta.stockBase) : CUR;
  const firstDataMonth = C.meta.monthFirst ? mnum(C.meta.monthFirst) : CUR - 24;
  // календарь горизонта
  const dayK = new Int32Array(HF), dayDim = new Float64Array(HF);
  for (let t = 0; t < HF; t++) { const mi = dayMonth(TODAY + t); dayK[t] = mi - CUR; dayDim[t] = mDays(mi); }
  const KM = dayK[HF - 1] + 2;
  const L12 = [], P12 = [];
  for (let k = 12; k >= 1; k--) L12.push(CUR - k);
  for (let k = 24; k >= 13; k--) P12.push(CUR - k);
  const yearsSI = []; for (let y = Math.floor(firstDataMonth / 12); y < Math.floor(CUR / 12); y++) if (y * 12 >= firstDataMonth) yearsSI.push(y);

  /* ---- индексы входов ---- */
  const catOf = C.sku.cat, ids = C.sku.id;
  const cats = CAT_ORDER.filter(c => catOf.includes(c)).concat([...new Set(catOf)].filter(c => !CAT_ORDER.includes(c)).sort());
  const rcBySku = Array.from({length: n}, () => []), rcBySup = {};
  for (let k = 0; k < C.rc.d.length; k++) {
    const d = dnum(C.rc.d[k]); if (d > TODAY) continue;
    const i = C.rc.sku[k], s = C.rc.sup[k], q = C.rc.q[k];
    if (i >= 0) rcBySku[i].push({d, q, sup: s, k});
    (rcBySup[s] || (rcBySup[s] = [])).push({d, q, i});
  }
  rcBySku.forEach(a => a.sort((x, y) => x.d - y.d || x.k - y.k));
  const poBySku = Array.from({length: n}, () => []);
  for (let k = 0; k < C.po.id.length; k++) if (C.po.sku[k] >= 0 && dnum(C.po.od[k]) <= TODAY) poBySku[C.po.sku[k]].push(k);
  const supDim = {};
  C.sup.id.forEach((id, k) => supDim[id] = {st: C.sup.st[k], mpl: C.sup.mpl[k], cnt: C.sup.cnt[k], skus: C.sup.skus[k]});
  const SPAN = CUR - stockBase + 1, stockAt = [];
  for (let i = 0; i < n; i++) { const t = new Float64Array(Math.max(1, SPAN)), a = C.stock[i]; for (let k = 0; k < a.length; k += 2) if (a[k] < SPAN) t[a[k]] = a[k + 1]; stockAt.push(t); }
  const s1 = (i, mi) => mi < stockBase ? null : mi > CUR ? 0 : stockAt[i][mi - stockBase];
  mark('index');

  /* ---- шаг 2: чистый спрос по месяцам [firstDataMonth, CUR−1] ---- */
  const M0 = firstDataMonth, NM = CUR - M0;            // число полных месяцев истории
  const sold = [], net = [], m0i = [], curSold = new Float64Array(n), curRet = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = new Float64Array(NM), s = new Float64Array(NM), q = C.sales.q[i], start = C.sales.m0[i] ? mnum(C.sales.m0[i]) : null;
    m0i.push(start == null ? CUR + 1 : start);
    if (start != null) {
      const ret = {}; const rr = C.sales.r[i]; for (let k = 0; k < rr.length; k += 2) ret[rr[k]] = rr[k + 1];
      for (let k = 0; k < q.length; k++) {
        const mi = start + k, v = q[k] || 0, rv = ret[k] || 0;
        if (mi === CUR) { curSold[i] = v; curRet[i] = rv; continue; }
        if (mi < M0 || mi > CUR - 1) continue;
        s[mi - M0] = v; a[mi - M0] = Math.max(0, v - rv);
      }
    }
    sold.push(s); net.push(a);
  }

  /* ---- шаг 5 (проход 1): сезонный индекс категории по сырому спросу ---- */
  function catSI(series) {
    const out = {};
    for (const c of cats) {
      // доля месяца в спросе категории за полные годы, взвешенная по объёму года (годы с крошечными продажами не искажают форму)
      const tot = new Float64Array(12); let all = 0;
      for (const y of yearsSI) for (let i = 0; i < n; i++) { if (catOf[i] !== c) continue; for (let m = 0; m < 12; m++) { const mi = y * 12 + m - M0; if (mi >= 0 && mi < NM) { tot[m] += series[i][mi]; all += series[i][mi]; } } }
      const si = new Array(12).fill(1);
      if (all > 0) for (let m = 0; m < 12; m++) si[m] = tot[m] / all * 12;
      out[c] = si;
    }
    return out;
  }
  let SIc = catSI(net);

  /* ---- шаг 3: восстановление упущенного спроса (с stockBase) ---- */
  const firstRcDayInMonth = (i, mi) => { const a = mStart(mi), b = mStart(mi + 1); for (const r of rcBySku[i]) { if (r.d >= a && r.d < b) return r.d - a + 1; if (r.d >= b) break; } return null; };
  const restored = [], cens = [];  // cens[i][k]: 0 — нет, 1 — полностью восстановлен, 2 — доля месяца, 3 — частичная цензура (флаг), 4 — нет остатка, но продажи были
  function restore(SI) {
    const out = [], flags = [];
    for (let i = 0; i < n; i++) {
      const d = Float64Array.from(net[i]), f = new Uint8Array(NM), si = SI[catOf[i]];
      const startK = Math.max(stockBase, m0i[i]) - M0;
      // позиция «жива» с обеих сторон месяца: продажи или остаток были раньше и будут позже (иначе — выведена, спрос не восстанавливаем)
      let lastAlive = -1; for (let k = NM - 1; k >= 0; k--) { const st = s1(i, M0 + k); if (net[i][k] > 0 || (st != null && st > 0)) { lastAlive = k; break; } }
      if (curSold[i] > 0 || (s1(i, CUR) || 0) > 0) lastAlive = NM;
      for (let k = Math.max(0, startK); k < NM; k++) {
        const mi = M0 + k, st = s1(i, mi);
        // уровень вокруг месяца по нецензурированным месяцам
        let sd = 0, ss = 0, alive = false;
        for (let j = Math.max(0, k - 6, m0i[i] - M0); j <= Math.min(NM - 1, k + 6); j++) {
          if (net[i][j] > 0) alive = true;
          const mj = M0 + j, sj = s1(i, mj);
          if (j !== k && (sj == null || sj > 0)) { sd += net[i][j]; ss += si[mj % 12]; }
        }
        if (!alive || k >= lastAlive) continue;
        if (ss < 1.5) { // мало наблюдений рядом — уровень по 24 мес
          sd = 0; ss = 0;
          for (let j = Math.max(0, NM - 24, m0i[i] - M0); j < NM; j++) { const sj = s1(i, M0 + j); if (sj == null || sj > 0) { sd += net[i][j]; ss += si[(M0 + j) % 12]; } }
        }
        const E = ss > 0 ? sd / ss * si[mi % 12] : 0;
        if (st === 0) {
          const kd = firstRcDayInMonth(i, mi);
          if (kd == null) { if (net[i][k] === 0) { if (E > 0) { d[k] = E; f[k] = 1; } } else f[k] = 4; }
          else if (kd > 1 && E > 0) { const v = Math.min(net[i][k] + E * (kd - 1) / mDays(mi), Math.max(net[i][k], 2 * E)); if (v > net[i][k]) { d[k] = v; f[k] = 2; } }
        } else if (st != null && E > 0 && st < 0.5 * E) f[k] = 3;
      }
      out.push(d); flags.push(f);
    }
    return {out, flags};
  }
  // уровень (индекс по сырому спросу) → восстановление → уровень (индекс по восстановленному спросу), 00 §6.3 шаг 3
  const rs = restore(SIc);
  SIc = catSI(rs.out);
  for (let i = 0; i < n; i++) { restored.push(rs.out[i]); cens.push(rs.flags[i]); }
  mark('history');

  /* ---- категории: тип спроса, окно сезона, тренд ---- */
  const catInfo = {};
  for (const c of cats) {
    const si = SIc[c], m = sum(si) / 12, cv = Math.sqrt(sum(si.map(x => (x - m) * (x - m))) / 12) / (m || 1);
    let best = null;
    for (let len = 1; len <= 12 && !best; len++) {
      let bs = -1, bstart = 0;
      for (let st = 0; st < 12; st++) { let s = 0; for (let j = 0; j < len; j++) s += si[(st + j) % 12] / 12; if (s > bs + 1e-12) { bs = s; bstart = st; } }
      if (bs >= PR.seasonShare - 1e-9) best = {from: bstart, len, share: bs};
    }
    let l12 = 0, p12 = 0;
    for (let i = 0; i < n; i++) if (catOf[i] === c) { for (const mi of L12) l12 += restored[i][mi - M0] || 0; for (const mi of P12) p12 += restored[i][mi - M0] || 0; }
    const seasonal = cv > PR.seasonalCV && best && best.len <= PR.seasonMaxMonths;
    const to = best ? (best.from + best.len - 1) % 12 : null;
    catInfo[c] = {
      name: CAT_RU[c] || c, si: si.map(r3), share: si.map(x => r3(x / 12)), cv: r3(cv),
      type: seasonal ? 'seasonal' : cv > PR.seasonalCV ? 'moderate' : 'flat', seasonal: !!seasonal,
      season: best ? {fromMonth: best.from + 1, toMonth: to + 1, months: best.len, share: r3(best.share), label: best.len === 12 ? 'весь год' : `${MON[best.from]}–${MON[to]}`} : null,
      peakMonth: si.indexOf(Math.max(...si)) + 1, peakShare: r3(Math.max(...si) / 12),
      trend: p12 > 0 ? r3(clamp(l12 / p12, PR.trendMin, PR.trendMax)) : 1, trendRaw: p12 > 0 ? r3(l12 / p12) : null
    };
  }
  // экземпляры сезона: ближайший с концом не раньше дня d
  function seasonAfter(c, d) {
    const ci = catInfo[c]; if (!ci.seasonal) return null;
    const s = ci.season, Y0 = Math.floor(CUR / 12) - 1;
    for (let y = Y0; y < Y0 + 5; y++) {
      const a = mStart(y * 12 + s.fromMonth - 1), endMi = y * 12 + s.fromMonth - 1 + s.months - 1, b = mStart(endMi + 1) - 1;
      if (b >= d) return {start: a, end: b, label: s.label + ' ' + (Math.floor(endMi / 12) !== y ? y + '/' + String(Math.floor(endMi / 12)).slice(2) : y), year: y};
    }
    return null;
  }

  /* ---- шаг 4: классы ---- */
  const dec = i => C.sku.dec[i] == null ? 5 : C.sku.dec[i];
  const mk = i => C.sku.mk[i];
  const cls = [];
  for (let i = 0; i < n; i++) {
    let s12 = 0, n12 = 0, d12 = 0; for (const mi of L12) { const k = mi - M0; if (k >= 0) { s12 += sold[i][k]; d12 += restored[i][k]; } }
    const dead = s12 === 0 && curSold[i] === 0;
    const isNew = CUR - m0i[i] < PR.newMonths;
    let zeros = 0, cnt = 0; const si = SIc[catOf[i]];
    for (const mi of L12) { if (mi < m0i[i]) continue; if (si[mi % 12] < 0.5) continue; cnt++; if (net[i][mi - M0] === 0) zeros++; }
    const intermittent = !dead && !isNew && cnt >= 4 && zeros / cnt > PR.intermittentShare;
    let nc = 0, tot = 0; for (let k = Math.max(stockBase, m0i[i]) - M0; k < NM; k++) { if (k < 0) continue; tot++; if (cens[i][k] === 1 || cens[i][k] === 2) nc++; }
    n12 = 0;
    cls.push({dead, isNew, intermittent, sales12: s12, demand12: d12, unreliable: tot >= 6 && nc / tot > 0.5});
  }
  // медиана наценки категории для индекса ценности
  const catMk = {}; for (const c of cats) { catMk[c] = median(ids.map((_, i) => i).filter(i => catOf[i] === c && mk(i) != null).map(mk)) || 30; }
  mark('classes');

  /* ---- шаг 7: поставщики (fill двумя методами, плечо, блокировка) ---- */
  function supplierStats(method) {
    const used = new Map();       // receipt object → used qty
    const stats = {};
    const ensure = s => stats[s] || (stats[s] = {id: s, ord: 0, mat: 0, erp: 0, conf: 0, ordAll: 0, n: 0, leads: [], delays: [], plan: [], byYear: {}, poCnt: 0, lastPO: null, openOnTime: 0});
    const closed = [];
    for (let k = 0; k < C.po.id.length; k++) {
      const s = C.po.sup[k]; if (!s) continue;
      const od = dnum(C.po.od[k]); if (od > TODAY) continue;
      const S = ensure(s); S.poCnt++; S.ordAll += C.po.qo[k]; S.conf += C.po.qc[k];
      if (C.po.pl[k] != null && C.po.pl[k] > 0) S.plan.push(C.po.pl[k]);
      if (S.lastPO == null || od > S.lastPO) S.lastPO = od;
      if (C.po.status[k] === 'open' && C.po.qp[k] > 0 && dnum(C.po.pd[k]) >= TODAY - PR.overduePoDays) S.openOnTime++;
      if (C.po.status[k] !== 'open' && od >= TODAY - PR.fillLookbackDays) closed.push(k);
    }
    closed.sort((a, b) => (C.po.od[a] < C.po.od[b] ? -1 : C.po.od[a] > C.po.od[b] ? 1 : C.po.id[a] < C.po.id[b] ? -1 : 1));
    let gO = 0, gM = 0, gE = 0;
    for (const k of closed) {
      const s = C.po.sup[k], S = ensure(s), i = C.po.sku[k], qo = C.po.qo[k], od = dnum(C.po.od[k]), pd = dnum(C.po.pd[k]);
      let need = qo, got = 0, first = null;
      // fill: жадная сверка в окне [order_date; promised + окно], не больше заказанного, приход не используется дважды (00 §3.1)
      if (i >= 0) for (const r of rcBySku[i]) {
        if (r.sup !== s || r.d < od) continue; if (r.d > pd + PR.fillWindowDays) break;
        const free = r.q - (used.get(r) || 0); if (free <= 0) continue;
        const t = Math.min(free, need); used.set(r, (used.get(r) || 0) + t); need -= t; got += t;
        if (need <= 0) break;
      }
      // плечо факт: первый приход той же пары не раньше 30 % планового плеча (раньше — физически не этот заказ: море из Азии)
      const minD = od + Math.max(7, Math.round(0.3 * Math.max(0, pd - od)));
      if (i >= 0 && got > 0) for (const r of rcBySku[i]) { if (r.sup !== s || r.d < minD) continue; if (r.d > pd + PR.fillWindowDays) break; first = r.d; break; }
      S.ord += qo; S.mat += got; S.erp += Math.min(qo, C.po.qr[k]); S.n++; gO += qo; gM += got; gE += Math.min(qo, C.po.qr[k]);
      const y = C.po.od[k].slice(0, 4), Y = S.byYear[y] || (S.byYear[y] = {ord: 0, mat: 0, erp: 0});
      Y.ord += qo; Y.mat += got; Y.erp += Math.min(qo, C.po.qr[k]);
      if (first != null) { S.leads.push(first - od); S.delays.push(first - pd); }
    }
    const gFill = method === 'erp' ? (gO ? gE / gO : 1) : (gO ? gM / gO : 1);
    const allSup = new Set([...C.sup.id, ...Object.keys(stats), ...Object.keys(rcBySup)]);
    const out = {};
    [...allSup].filter(Boolean).sort().forEach(s => {
      const S = ensure(s), dim = supDim[s] || {};
      const rcF = S.ord ? S.mat / S.ord : null, erpF = S.ord ? S.erp / S.ord : null;
      const raw = method === 'erp' ? erpF : rcF;
      const N = PR.fillSmoothN;
      let fill, fillSource;
      if (raw == null) { fill = gFill; fillSource = 'prior'; }
      else if (S.n < N) { fill = (S.n * raw + (N - S.n) * gFill) / N; fillSource = 'smoothed'; }
      else { fill = raw; fillSource = 'data'; }
      let Lmed, Lp90, sig, lsrc;
      if (S.leads.length >= 3) { Lmed = median(S.leads); Lp90 = quantile(S.leads, 0.9); sig = std(S.leads); lsrc = 'fact'; }
      else if (S.plan.length) { Lmed = median(S.plan); Lp90 = quantile(S.plan, 0.9); sig = std(S.plan) || 0.25 * Lmed; lsrc = 'plan'; }
      else if (dim.mpl > 0) { Lmed = dim.mpl; Lp90 = dim.mpl * PR.leadDefaultP90 / PR.leadDefault; sig = 0.25 * Lmed; lsrc = 'dim'; }
      else { Lmed = PR.leadDefault; Lp90 = PR.leadDefaultP90; sig = 0.25 * Lmed; lsrc = 'default'; }
      if (!sig) sig = 0.25 * Lmed;
      Lmed = Math.round(Lmed); Lp90 = Math.max(Lmed, Math.round(Lp90));
      const rcs = rcBySup[s] || [], lastRc = rcs.length ? Math.max(...rcs.map(r => r.d)) : null;
      const recentPO = S.lastPO != null && S.lastPO >= TODAY - PR.blockPoLookbackDays;
      const onSchedule = S.openOnTime > 0;   // есть открытый PO, срок которого ещё не прошёл: ждём, не блокируем
      const silent = recentPO && !onSchedule && (lastRc == null || lastRc < TODAY - PR.blockNoReceiptDays);
      const rc180 = rcs.some(r => r.d > TODAY - 180);
      let lowFill = fillSource !== 'prior' && fill < PR.blockFill;
      // низкая доля по сверке, но приходы за 12 мес идут: PO в выгрузке не покрывают его поставки (приходы по другим позициям) —
      // это артефакт выгрузки, а не «не отгружает»: доля поставки — средняя, поставщик не блокируется
      if (lowFill && rcs.some(r => r.d > TODAY - PR.blockNoReceiptDays)) { fill = gFill; fillSource = 'unmatched'; lowFill = false; }
      out[s] = {
        id: s, type: (dim.st || ''), fill: r3(fill), fillSource, fillRc: rcF == null ? null : r3(rcF), fillErp: erpF == null ? null : r3(erpF),
        confirmRate: S.ordAll ? r3(S.conf / S.ordAll) : null, poClosed: S.n, poAll: S.poCnt, ordered: S.ord, matched: S.mat, receivedErp: S.erp,
        leadMed: Lmed, leadP90: Lp90, leadSigma: r2(sig), leadSource: lsrc, leadPlanMed: S.plan.length ? Math.round(median(S.plan)) : (dim.mpl > 0 ? Math.round(dim.mpl) : null),
        leadMatches: S.leads.length, delay: S.delays.length ? Math.max(0, Math.round(median(S.delays))) : 0,
        lastReceipt: iso(lastRc), lastPO: iso(S.lastPO), receipts12: rcs.filter(r => r.d > TODAY - 365).reduce((a, r) => a + r.q, 0),
        blocked: silent || lowFill, blockReason: silent ? 'silent' : lowFill ? 'lowFill' : null,
        byYear: Object.keys(S.byYear).sort().map(y => { const Y = S.byYear[y]; return {year: +y, ordered: Y.ord, fillRc: r3(Y.mat / Y.ord), fillErp: r3(Y.erp / Y.ord)}; })
      };
    });
    return {sup: out, globalFill: r3(gFill), globalFillRc: gO ? r3(gM / gO) : null, globalFillErp: gO ? r3(gE / gO) : null, closedConsidered: closed.length};
  }
  const SUPS = supplierStats(PR.fillMethod);
  const SUPS_ALT = supplierStats(PR.fillMethod === 'erp' ? 'receipts' : 'erp');
  mark('suppliers');

  /* основная категория поставщика и названия */
  const supMainCat = {}, supType = {};
  Object.keys(SUPS.sup).forEach(s => {
    const cnt = {}; for (let i = 0; i < n; i++) if (C.sku.sup[i] === s) cnt[catOf[i]] = (cnt[catOf[i]] || 0) + 1;
    if (!Object.keys(cnt).length) (rcBySup[s] || []).forEach(r => { if (r.i >= 0) cnt[catOf[r.i]] = (cnt[catOf[r.i]] || 0) + r.q; });
    supMainCat[s] = cats.slice().sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0) || cats.indexOf(a) - cats.indexOf(b))[0];
    supType[s] = (supDim[s] && supDim[s].st) || 'import';
  });
  const NAMES = buildNames(C, supMainCat, supType);
  const supName = s => s ? (NAMES.sup[s] || s) : 'Без поставщика';

  /* ---- общие величины по SKU: партия, вес, остаток сегодня ---- */
  const batchRaw = [], wRaw = [];
  for (let i = 0; i < n; i++) {
    const q = rcBySku[i].filter(r => r.d > TODAY - 1095).map(r => r.q);
    batchRaw.push(q.length ? median(q) : null);
  }
  const catBatch = {}, catW = {};
  for (const c of cats) {
    catBatch[c] = median(batchRaw.filter((b, i) => b != null && catOf[i] === c)) || 100;
    catW[c] = median(C.sku.w.filter((w, i) => w != null && w > 0 && catOf[i] === c)) || 1;
  }
  const stockToday = new Float64Array(n), stock01 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const st = s1(i, CUR) || 0; stock01[i] = st;
    let rcv = 0; for (const r of rcBySku[i]) if (r.d >= mStart(CUR) && r.d <= TODAY) rcv += r.q;
    // продажи текущего месяца: в данных — по сегодня (partial); если «сегодня» в полном месяце — доля по дням
    const isPartial = (C.meta.partialMonths || []).includes(mstr(CUR));
    const k = isPartial ? 1 : (DOM - 1) / mDays(CUR);
    stockToday[i] = Math.max(0, st + rcv - (curSold[i] - curRet[i]) * k);
  }

  /* ---- шаг 6: прогноз по месяцам горизонта ---- */
  const FM = [], SSM = [], fcMeta = [];
  // уровень для аналога новинок
  const L0 = new Float64Array(n), G = new Float64Array(n), SI = [];
  for (let i = 0; i < n; i++) {
    const c = catOf[i], sic = SIc[c];
    // индекс SKU при ≥ 3 полных годах
    let si = sic, siSrc = 'category';
    const fullYears = yearsSI.filter(y => y * 12 >= m0i[i] && y * 12 + 11 < CUR);
    if (fullYears.length >= 3 && !cls[i].dead) {
      const shares = [];
      for (const y of fullYears) { let all = 0; const t = new Array(12).fill(0); for (let m = 0; m < 12; m++) { const v = restored[i][y * 12 + m - M0]; t[m] = v; all += v; } if (all > 0) shares.push(t.map(v => v / all * 12)); }
      if (shares.length >= 3) { const sk = new Array(12).fill(0).map((_, m) => sum(shares.map(s => s[m])) / shares.length); si = sic.map((v, m) => 0.5 * sk[m] + 0.5 * v); const mm = sum(si) / 12; si = si.map(v => v / mm); siSrc = 'mixed'; }
    }
    SI.push(si);
    let num = 0, den = 0, l12 = 0, p12 = 0, p12m = 0;
    for (const mi of L12) { const k = mi - M0; if (mi < m0i[i] || k < 0) continue; num += restored[i][k]; den += si[mi % 12]; l12 += restored[i][k]; }
    for (const mi of P12) { const k = mi - M0; if (mi < m0i[i] || k < 0) continue; p12 += restored[i][k]; if (net[i][k] > 0) p12m++; }
    L0[i] = den > 0 ? num / den : 0;
    G[i] = p12m >= 6 && p12 > 0 ? clamp(l12 / p12, PR.trendMin, PR.trendMax) : catInfo[c].trend;
  }
  // аналоги для новинок: медиана уровня по категории и децилю ±1 среди «взрослых» активных
  const analog = i => {
    const pool = ids.map((_, j) => j).filter(j => catOf[j] === catOf[i] && !cls[j].dead && !cls[j].isNew && !cls[j].intermittent && L0[j] > 0);
    const near = pool.filter(j => Math.abs(dec(j) - dec(i)) <= 1);
    return median((near.length >= 3 ? near : pool).map(j => L0[j])) || 0;
  };
  for (let i = 0; i < n; i++) {
    const c = catOf[i], fm = new Float64Array(KM);
    let method = 'seasonal-index', trend = G[i], trendSrc = 'sku', level = L0[i];
    if (cls[i].dead) { method = 'none'; level = 0; trend = 1; trendSrc = 'none'; }
    else if (cls[i].isNew) {
      method = 'new-analog'; trend = 1; trendSrc = 'none';
      let num = 0, den = 0, k = 0; for (let mi = Math.max(m0i[i], M0); mi < CUR; mi++) { num += restored[i][mi - M0]; den += SI[i][mi % 12]; k++; }
      const own = den > 0 ? num / den : 0, w = Math.min(1, k / 3), an = analog(i);
      level = w * own + (1 - w) * an;
      if (k === 0 && an === 0) level = curSold[i] / Math.max(1, DOM) * 30;
    } else if (cls[i].intermittent) {
      method = 'sba'; trendSrc = 'none'; trend = 1;
      const hist = []; for (let mi = Math.max(m0i[i], CUR - 24); mi < CUR; mi++) hist.push(restored[i][mi - M0]);
      let z = null, p = null, q = 1;
      for (const v of hist) { if (v > 0) { if (z == null) { z = v; p = q; } else { z += PR.sbaAlpha * (v - z); p += PR.sbaAlpha * (q - p); } q = 1; } else q++; }
      level = z == null ? 0 : (1 - PR.sbaAlpha / 2) * z / p;
    } else if (G[i] !== clamp(G[i], PR.trendMin, PR.trendMax)) trendSrc = 'sku';
    if (method === 'seasonal-index') {
      let p12m = 0; for (const mi of P12) { const k = mi - M0; if (k >= 0 && mi >= m0i[i] && net[i][k] > 0) p12m++; }
      if (p12m < 6) trendSrc = 'category';
    }
    for (let k = 0; k < KM; k++) {
      const mi = CUR + k;
      if (method === 'sba') fm[k] = level;
      else if (method === 'none') fm[k] = 0;
      else fm[k] = level * SI[i][mi % 12] * Math.pow(trend, (mi - CUR + 6.5) / 12);
    }
    FM.push(fm);
    fcMeta.push({method, level, trend, trendSrc, siSrc: SI[i] === SIc[c] ? 'category' : 'mixed'});
  }
  mark('forecast');

  /* ---- уровень сервиса: ABC по индексу ценности ---- */
  const unitValue = i => dec(i) * (1 + (mk(i) == null ? catMk[catOf[i]] : mk(i)) / 100);
  const f12of = i => { let s = 0; for (let t = 0; t < 365; t++) s += FM[i][dayK[t]] / dayDim[t]; return s; };
  const F12 = new Float64Array(n); for (let i = 0; i < n; i++) F12[i] = f12of(i);
  const V = new Float64Array(n);
  for (let i = 0; i < n; i++) V[i] = cls[i].dead ? 0 : (cls[i].isNew ? F12[i] : cls[i].demand12) * unitValue(i);
  const order = ids.map((_, i) => i).filter(i => !cls[i].dead && V[i] > 0).sort((a, b) => V[b] - V[a] || (ids[a] < ids[b] ? -1 : 1));
  const totV = order.reduce((a, i) => a + V[i], 0); let cum = 0;
  const ABC = new Array(n).fill(null);
  for (const i of order) { const before = cum; cum += V[i]; ABC[i] = before < 0.8 * totV ? 'A' : before < 0.95 * totV ? 'B' : 'C'; }
  for (let i = 0; i < n; i++) if (!cls[i].dead && !ABC[i]) ABC[i] = 'C';
  const svc = c => c === 'A' ? PR.serviceA : c === 'B' ? PR.serviceB : PR.serviceC;

  /* ---- открытые PO: ожидаемые приходы ---- */
  function openArrivals(i, SS) {
    const exp = [], full = [], list = [];
    for (const k of poBySku[i]) {
      if (C.po.status[k] !== 'open') continue;
      const s = C.po.sup[k], S = SS.sup[s] || {fill: SS.globalFill, delay: 0, blocked: false}, pd = dnum(C.po.pd[k]), pend = C.po.qp[k], conf = C.po.qc[k];
      let state, day, q;
      if (pd >= TODAY) { state = 'future'; day = pd + S.delay; q = pend * S.fill; }
      else if (pd >= TODAY - PR.overduePoDays && conf > 0) { state = 'late'; day = Math.max(TODAY + 7, pd + S.delay); q = pend * S.fill; }
      else { state = 'overdue'; day = Math.max(TODAY + 7, pd + S.delay); q = 0; }
      if (S.blocked) q = 0;
      const t = day - TODAY;
      if (q > 0) exp.push([t, q]);
      if (!S.blocked && pend > 0) full.push([t, pend]);
      list.push({po: C.po.id[k], sku: ids[i], sup: s, supplierBlocked: !!S.blocked, ordered: C.po.od[k], promised: C.po.pd[k], pending: pend, confirmed: conf, state, expectedDate: iso(day), expectedQty: r0(q), fill: S.fill, daysLate: pd < TODAY ? TODAY - pd : 0});
    }
    exp.sort((a, b) => a[0] - b[0]); full.sort((a, b) => a[0] - b[0]);
    return {exp, full, list};
  }

  /* ---- решение по одной позиции ---- */
  const Pb = new Float64Array(H), Lb = new Float64Array(H), Pb2 = new Float64Array(H), Lb2 = new Float64Array(H);
  const fdBuf = new Float64Array(HF), ssDay = new Float64Array(H);
  const override = PR.supplierOverride || {};
  const readyWin = {}; cats.forEach(c => { readyWin[c] = seasonAfter(c, TODAY); });

  function decide(i, SS, lite) {
    const c = catOf[i], cl = cls[i];
    const supId = override[ids[i]] || C.sku.sup[i] || null;
    const S = supId ? SS.sup[supId] : null;
    const fill = S ? S.fill : 1;
    const Lmed = S ? S.leadMed : PR.leadNoSupplier, Lp90 = S ? S.leadP90 : Math.max(PR.leadNoSupplier, PR.leadDefaultP90), sigL = S ? S.leadSigma : 0.25 * PR.leadNoSupplier;
    const fm = FM[i];
    for (let t = 0; t < HF; t++) fdBuf[t] = fm[dayK[t]] / dayDim[t];
    // страховой запас по месяцам
    const z = cl.dead ? 0 : zOf(svc(ABC[i]));
    let cv = 0.5;
    if (fcMeta[i].method === 'seasonal-index') {
      const rr = [];
      for (const mi of L12) { const k = mi - M0; if (k < 0 || mi < m0i[i]) continue; const e = fcMeta[i].level * SI[i][mi % 12] * Math.pow(fcMeta[i].trend, (mi - CUR + 6.5) / 12); if (e > 0.5) rr.push(restored[i][k] / e); }
      if (rr.length >= 3) { const m = sum(rr) / rr.length; cv = m > 0 ? std(rr) / m : 1; }
      cv = clamp(cv, 0.25, 1);
    }
    let ssInt = null;
    if (fcMeta[i].method === 'sba') { const h = []; for (const mi of L12) { const k = mi - M0; if (k >= 0 && mi >= m0i[i]) h.push(restored[i][k]); } ssInt = (quantile(h, svc(ABC[i])) || 0) * Math.sqrt(Lmed / 30); }
    const ssm = new Float64Array(KM), feff = new Float64Array(KM);
    // f_eff = min(прогноз месяца; средний прогноз за плечо перед ним): у сезонных SS не раздувается пиком при длинном плече, летом ≈ 0
    const fAt = mi => { const k = mi - CUR; if (k >= 0) return fm[Math.min(k, KM - 1)]; const M = fcMeta[i]; return M.method === 'sba' ? M.level : M.method === 'none' ? 0 : M.level * SI[i][((mi % 12) + 12) % 12] * Math.pow(M.trend, (mi - CUR + 6.5) / 12); };
    const mL = Math.max(1, Math.round(Lmed / 30));
    for (let k = 0; k < KM; k++) {
      if (cl.dead) { ssm[k] = 0; continue; }
      if (ssInt != null) { ssm[k] = ssInt; feff[k] = fm[k]; continue; }
      let a = 0; for (let j = 0; j < mL; j++) a += fAt(CUR + k - 1 - j);
      const f = Math.min(fm[k], a / mL), sm = cv * f; feff[k] = f;
      ssm[k] = z * Math.sqrt((Lmed / 30) * sm * sm + Math.pow(f / 30 * sigL, 2));
    }
    for (let t = 0; t < H; t++) ssDay[t] = ssm[dayK[t]];
    const ssAt = t => ssm[dayK[Math.min(HF - 1, Math.max(0, t))]];

    const arrPO = openArrivals(i, SS);
    const st0 = stockToday[i];
    // ожидаемый сценарий
    project(st0, fdBuf, H, arrPO.exp, Pb, Lb);
    const outE = firstOut(Pb, Lb, fdBuf, H), ssE = firstBelow(Pb, Lb, fdBuf, ssDay, H);
    const arrT = Math.min(H - 1, Lmed), arrP90T = Lp90;
    const P_arr = Pb[arrT];
    const lostBefore = sumRange(Lb, 0, arrT);
    const overVal = Pb[OVER_T] - (fdBuf[OVER_T] - Lb[OVER_T]);
    const projExpM = monthEnds(Pb, Lb);
    let rwLostBase = null; const rw = readyWin[c];
    if (rw && !lite) rwLostBase = sumRange(Lb, rw.start - TODAY, rw.end - TODAY + 1);
    // сценарий 100 %
    project(st0, fdBuf, H, arrPO.full, Pb2, Lb2);
    const out100 = firstOut(Pb2, Lb2, fdBuf, H), ss100 = firstBelow(Pb2, Lb2, fdBuf, ssDay, H);
    const proj100M = lite ? null : monthEnds(Pb2, Lb2);
    const lostBefore100 = sumRange(Lb2, 0, arrT);

    const meanM = F12[i] / 12;
    const thr = Math.max(1, PR.lateLossShare * meanM);
    // сезон
    const season = catInfo[c].seasonal ? seasonAfter(c, TODAY + Lmed) : null;
    const seasonOrderBy = season ? season.start - Lp90 - BUF : null;
    const sT0 = season ? Math.max(0, season.start - TODAY) : null, sT1 = season ? season.end - TODAY + 1 : null;
    // количество
    const wFrom = Lmed, wTo = Lmed + R + CV_;
    const demW = r0(sumRange(fdBuf, wFrom, wTo)), ssW = r0(ssAt(Lmed + R)), projA = r0(Math.max(0, P_arr));
    const netQ = demW + ssW - projA;
    let seasonQ = null, seasonCond = false;
    if (season && seasonOrderBy <= TODAY + R && TODAY + Lmed <= season.end) {
      seasonCond = true;
      // страховой к сезону — ошибка прогноза суммы сезона: z × CV × √Σ f_m² по месяцам сезона (разброс плеча уже покрыт сроком по p90)
      let sq = 0; for (let mi = dayMonth(season.start); mi <= dayMonth(season.end); mi++) { const k = mi - CUR; if (k >= 0 && k < KM) sq += fm[k] * fm[k]; }
      const dS = r0(sumRange(fdBuf, Lmed, sT1)), ssS = r0(ssInt != null ? ssInt : z * cv * Math.sqrt(sq));
      seasonQ = {from: iso(TODAY + Lmed), to: iso(season.end), demand: dS, ss: ssS, projectedAtArrival: projA, net: dS + ssS - projA};
    }
    const seasonFired = seasonCond && seasonQ.net > 0;
    const base = seasonFired ? Math.max(netQ, seasonQ.net) : netQ;
    const rule = seasonFired && seasonQ.net > netQ ? 'season' : 'net';
    const comp = PR.compensateFill && supId ? Math.max(fill, 0.5) : 1;
    const afterComp = comp !== 1 ? Math.ceil(base / comp) : base;
    const batchHist = Math.max(1, Math.round(batchRaw[i] != null ? batchRaw[i] : catBatch[c]));
    // партия по приходам бывает в несколько лет спроса (сборные отгрузки): кратность не больше полугодового прогноза
    const cap6 = Math.max(1, Math.round(F12[i] / 2));
    const batch = Math.min(batchHist, cap6);
    let qtyCalc = 0, cut = null;
    if (afterComp <= 0) cut = 'noNeed';
    else if (afterComp < 0.5 * batch) cut = 'belowHalfBatch';
    else qtyCalc = Math.ceil(afterComp / batch) * batch;
    const qtyBreakdown = {
      window: {from: iso(TODAY + wFrom), to: iso(TODAY + wTo - 1), days: wTo - wFrom},
      demand: demW, safetyStock: ssW, safetyAt: iso(TODAY + Lmed + R), projectedAtArrival: projA, net: netQ,
      season: seasonQ, rule, base, compensation: comp !== 1 ? {fill, factor: r3(comp)} : null, afterCompensation: afterComp,
      batch, batchHist, batchSource: batch < batchHist ? 'capped' : batchRaw[i] != null ? 'sku' : 'category', cut, qty: qtyCalc
    };
    // даты и статус по спросу
    const orderByE = ssE == null ? null : TODAY + ssE - Lmed - BUF;
    const orderBy100 = ss100 == null ? null : TODAY + ss100 - Lmed - BUF;
    function demandStatus(ob, lost) {
      if (cl.dead) return 'dead';
      if (seasonFired && seasonOrderBy < TODAY) return 'late';
      if (ob != null && ob < TODAY && lost >= Math.max(thr, 1)) return 'late';
      if (seasonFired) return 'order';
      if (ob == null) return 'ok';
      if (ob <= TODAY + R) return 'order';
      if (ob <= TODAY + 2 * R) return 'next';
      return 'ok';
    }
    let dS = demandStatus(orderByE, lostBefore);
    const dS100 = demandStatus(orderBy100, lostBefore100);
    const offSeason = dS === 'order' && orderByE != null && orderByE < TODAY && !seasonFired;
    let demoted = false;
    if ((dS === 'late' || dS === 'order') && qtyCalc === 0) { dS = 'next'; demoted = true; }
    const isOver = !cl.dead && !cl.isNew && overVal > 0.5;
    let status;
    if (cl.dead) status = 'dead';
    else if (mk(i) != null && mk(i) < PR.minMarkup) status = 'margin';
    else if (isOver) status = 'over';
    else if ((!supId || (S && S.blocked)) && (dS === 'late' || dS === 'order' || dS === 'next')) status = 'blocked';
    else status = dS;
    if (lite) return {status, qty: (status === 'late' || status === 'order') ? qtyCalc : 0};

    const inPlan = status === 'late' || status === 'order';
    // проекции с заказом (для разрыва после заказа и сезонной готовности)
    let gapAfter = null, projOrderM = null, rwLost100 = rwLostBase, rwLostFill = rwLostBase;
    if (qtyCalc > 0 && (inPlan || status === 'next' || status === 'blocked' || status === 'margin')) {
      const withOrder = (k) => { const a = arrPO.exp.concat([[arrT, qtyCalc * k]]).sort((x, y) => x[0] - y[0]); project(st0, fdBuf, H, a, Pb2, Lb2); };
      withOrder(fill);
      gapAfter = r0(sumRange(Lb2, wFrom, Math.min(H, wTo)));
      projOrderM = monthEnds(Pb2, Lb2);
      if (rw && inPlan) {
        rwLostFill = sumRange(Lb2, rw.start - TODAY, rw.end - TODAY + 1);
        withOrder(1); rwLost100 = sumRange(Lb2, rw.start - TODAY, rw.end - TODAY + 1);
      }
    }
    const transit = arrPO.list.reduce((a, p) => a + p.pending, 0);
    const transitExp = arrPO.list.reduce((a, p) => a + p.expectedQty, 0);
    const wKg = C.sku.w[i], wImp = wKg == null || !(wKg > 0) || wKg < 0.1 * catW[c];
    const weight = wImp ? catW[c] : wKg;
    // ss-формула для карточки
    const fArr = fm[dayK[Math.min(HF - 1, Lmed + R)]];
    const ssForm = ssInt != null ? {kind: 'quantile', z: r3(z), service: svc(ABC[i]), L: Lmed, value: r0(ssInt)} :
      {kind: 'normal', z: r3(z), service: svc(ABC[i] || 'C'), L: Lmed, cv: r3(cv), fMonth: r0(fArr), fEff: r0(feff[dayK[Math.min(HF - 1, Lmed + R)]]), sigmaM: r0(cv * feff[dayK[Math.min(HF - 1, Lmed + R)]]), sigmaL: r2(sigL), value: ssW,
      text: `SS ${fmtN(ssW)} = z ${fmtF(z)} × √(${Lmed}/30 × ${fmtN(cv * feff[dayK[Math.min(HF - 1, Lmed + R)]])}² + (${fmtN(feff[dayK[Math.min(HF - 1, Lmed + R)]])}/30 × ${fmtN(sigL)})²)`};
    let restoredMonths = 0, restoredQty = 0, censoredMonths = 0, partialFlags = 0, noStockSales = 0;
    for (let k = 0; k < NM; k++) {
      const f = cens[i][k];
      if (f === 1 || f === 2) { restoredMonths++; restoredQty += restored[i][k] - net[i][k]; }
      if (f === 3) partialFlags++; if (f === 4) noStockSales++;
      const mi = M0 + k; if (mi >= stockBase && mi >= m0i[i] && s1(i, mi) === 0) censoredMonths++;
    }
    const histStart = CUR - 12, hist12 = []; for (let mi = histStart; mi < CUR; mi++) hist12.push(mi - M0 >= 0 ? r0(net[i][mi - M0]) : 0);
    const fc18 = []; for (let k = 0; k < 18; k++) fc18.push(r0(fm[k]));
    const ss18 = []; for (let k = 0; k < 18; k++) ss18.push(r0(ssm[k]));
    return {
      i, supId, S, fill, Lmed, Lp90, sigL, z, cv, arrPO, st0, outE, ssE, out100, ss100, orderByE, orderBy100, lostBefore, lostBefore100, thr, meanM,
      season, seasonOrderBy, seasonCond, seasonFired, qtyCalc, qtyBreakdown, dS, dS100, offSeason, demoted, status, isOver, overVal,
      gapAfter, projExpM, proj100M, projOrderM, rwLostBase, rwLost100, rwLostFill, transit, transitExp, weight, wImp, ssForm, P_arr,
      restoredMonths, restoredQty, censoredMonths, partialFlags, noStockSales, hist12, fc18, ss18, batch,
      f30: sumRange(fdBuf, 0, 30), f90: sumRange(fdBuf, 0, 90), f180: sumRange(fdBuf, 0, 180)
    };
  }
  function monthEnds(P, L) { // остаток на конец месяца, 18 точек от текущего
    const out = new Array(18).fill(null);
    for (let t = 0; t < H; t++) { const k = dayK[t]; if (k >= 18) break; if (t === H - 1 || dayK[t + 1] !== k) out[k] = r0(Math.max(0, P[t] - fdBuf[t] + L[t])); }
    return out;
  }

  const D = []; for (let i = 0; i < n; i++) D.push(decide(i, SUPS, false));
  // второй метод fill: пересчитываем только позиции, на которые он может повлиять (открытые PO, блокировка, компенсация)
  const hasOpen = i => poBySku[i].some(k => C.po.status[k] === 'open' && C.po.qp[k] > 0);
  const D_ALT = [];
  for (let i = 0; i < n; i++) {
    const s = override[ids[i]] || C.sku.sup[i] || null;
    const same = !PR.compensateFill && !hasOpen(i) && (!s || (!!(SUPS.sup[s] || {}).blocked === !!(SUPS_ALT.sup[s] || {}).blocked));
    D_ALT.push(same ? {status: D[i].status, qty: D[i].qtyCalc} : decide(i, SUPS_ALT, true));
  }
  mark('decisions');

  /* ---- альтернативный поставщик ---- */
  const catRcCache = {};
  function catRc12(c) {
    if (catRcCache[c]) return catRcCache[c];
    const m = {}; for (let j = 0; j < n; j++) { if (catOf[j] !== c) continue; for (const r of rcBySku[j]) if (r.d > TODAY - 365) m[r.sup] = (m[r.sup] || 0) + r.q; }
    return (catRcCache[c] = m);
  }
  function altFor(i, exclude) {
    const okSup = s => s && s !== exclude && SUPS.sup[s] && !SUPS.sup[s].blocked && SUPS.sup[s].fill >= PR.altFillMin;
    const bySku = {}; for (const r of rcBySku[i]) if (r.d > TODAY - 365 && okSup(r.sup)) bySku[r.sup] = (bySku[r.sup] || 0) + r.q;
    let best = Object.keys(bySku).sort((a, b) => bySku[b] - bySku[a] || (a < b ? -1 : 1))[0], why = 'sku';
    if (!best) {
      const all = catRc12(catOf[i]), byCat = {}; for (const k in all) if (okSup(k)) byCat[k] = all[k];
      best = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a] || (a < b ? -1 : 1))[0]; why = 'category';
    }
    if (!best) return null;
    const A = SUPS.sup[best];
    return {id: best, name: supName(best), fill: A.fill, fillSource: A.fillSource, leadMed: A.leadMed, why, whyText: why === 'sku' ? 'возил эту позицию за 12 мес' : 'возит эту категорию за 12 мес'};
  }

  /* ---- тексты: коды причин и шаблоны ---- */
  const pf = PR.minMarkup;
  function texts(d, alt) {
    const i = d.i, nmS = d.supId ? supName(d.supId) : null;
    const dO = d.outE == null ? null : TODAY + d.outE, d100 = d.out100 == null ? null : TODAY + d.out100;
    const arr = TODAY + d.Lmed, arr90 = TODAY + d.Lp90;
    const lost = r0(d.lostBefore), qb = d.qtyBreakdown;
    const ob = d.orderByE;
    const lastSale = (() => { for (let k = NM - 1; k >= 0; k--) if (sold[i][k] > 0) return M0 + k; return C.sku.ls[i] ? mnum(C.sku.ls[i]) : null; })();
    const depPO = d.arrPO.list.find(p => p.pending > 0 && (p.state === 'overdue' || p.state === 'late' || p.supplierBlocked));
    let code, ground;
    const st = d.status;
    if (st === 'dead') { code = 'dead'; ground = lastSale == null ? 'продаж в истории нет' : `нет продаж с ${fmtM(lastSale)}`; }
    else if (st === 'margin') { code = 'margin'; ground = (d.dS === 'late' || d.dS === 'order') && ob != null ? fit([`наценка ${mk(i)} % < ${pf} %, решить по цене до ${fmtD(Math.max(ob, TODAY))}`, `наценка ${mk(i)} % < ${pf} %, решить по цене сейчас`]) : `наценка ${mk(i)} % < ${pf} %, на пересмотр цены`; }
    else if (st === 'over') { code = 'over'; ground = `покрытие ${fmtN(d.meanM > 0 ? (d.st0 + d.transitExp) / d.meanM : 999)} мес, заморожено ${fmtN(d.overVal)} шт`; }
    else if (st === 'blocked' && !d.supId) { code = 'blocked_nosupplier'; ground = fit([`нет поставщика в данных, спрос ${fmtN(d.meanM)}/мес`, 'нет поставщика в данных']); }
    else if (st === 'blocked') { code = 'blocked_supplier'; const a = alt ? alt.name : 'искать замену'; ground = fit([`${nmS} не отгружает 12 мес → ${a}`, `${nmS} не отгружает → ${a}`, `поставщик не отгружает → ${a}`, 'поставщик не отгружает → искать замену']); }
    else if (st === 'late' && d.seasonFired && d.seasonOrderBy < TODAY) { code = 'late_season'; ground = fit([`к сезону ${d.season.label} опоздали: заказать до ${fmtD(d.seasonOrderBy)}`, `к сезону ${d.season.label} опоздали`]); }
    else if (st === 'late') { code = 'late_stockout'; ground = d.st0 <= 0 ? fit([`нет остатка, до прихода ${fmtD(arr)} не продадим ≈${fmtN(lost)}`, `нет остатка, потери до прихода ≈${fmtN(lost)}`]) : fit([`хватит до ${fmtD(dO)}, до прихода ${fmtD(arr)} не продадим ≈${fmtN(lost)}`, `дефицит с ${fmtD(dO)}, потери до прихода ≈${fmtN(lost)}`]); }
    else if (st === 'order' && d.seasonFired && (qb.rule === 'season' || d.orderByE == null || d.orderByE > TODAY + R)) { code = 'order_season'; ground = fit([`сезон ${d.season.label}: нужно ${fmtN(qb.season.demand + qb.season.ss)}, ожидаем ${fmtN(qb.projectedAtArrival)}`, `к сезону ${d.season.label}: заказать до ${fmtD(d.seasonOrderBy)}`]); }
    else if (st === 'order' && d.offSeason) { code = 'order_offseason'; ground = `межсезонный дефицит, потери до прихода ≈${fmtN(lost)}`; }
    else if ((st === 'order' || st === 'next' || st === 'ok') && d.dS100 !== d.dS && depPO) { code = 'depends_po'; ground = fit([`хватит до ${fmtD(d100)}, если придёт ${depPO.po}; иначе ${fmtD(dO)}`, `при приходе ${depPO.po} хватит до ${fmtD(d100)}, иначе ${fmtD(dO)}`, `зависит от ${depPO.po}: иначе дефицит с ${fmtD(dO)}`]); }
    else if (st === 'order') { code = 'order_regular'; ground = dO == null ? `ниже страхового запаса, приход при заказе ${fmtD(arr)}` : `хватит до ${fmtD(dO)}, приход при заказе ${fmtD(arr)}`; }
    else if (st === 'next' && d.demoted && d.season && d.seasonOrderBy > TODAY) { code = 'season_next'; ground = fit([`к сезону ${d.season.label} заказать до ${fmtD(d.seasonOrderBy)}`]); }
    else if (st === 'next' && d.demoted && qb.cut === 'noNeed') { code = 'next_covered'; ground = fit([`к приходу ${fmtD(arr)} ожидаем ${fmtN(qb.projectedAtArrival)} — заказ не нужен`, 'к приходу хватит, заказ не нужен']); }
    else if (st === 'next') { code = d.demoted ? 'next_small' : 'next'; ground = d.demoted ? fit([`нужно ${fmtN(qb.afterCompensation)} шт — меньше полпартии ${fmtN(qb.batch)}`, 'нужно меньше полпартии, следующий цикл']) : dO == null ? `заказать до ${fmtD(ob)}` : `хватит до ${fmtD(dO)}, заказать до ${fmtD(ob)}`; }
    else { code = dO == null ? (d.meanM > 0 ? 'ok_long' : 'ok_nodemand') : 'ok'; ground = dO == null ? (d.meanM > 0 ? 'запаса хватит больше чем на 18 мес' : 'спрос не прогнозируется') : `хватит до ${fmtD(dO)}`; }
    if (ground.length > 60) ground = fit([ground]);

    // объяснение: почему статус · откуда количество · главный риск
    const s1t = {
      dead: () => `Нет продаж 12 полных месяцев${lastSale != null ? ', последняя продажа ' + fmtM(lastSale) : ''}. Остаток ${fmtN(d.st0)} шт — списать или распродать.`,
      margin: () => `Наценка ${mk(i)} % ниже порога ${pf} %: в заказ автоматически не идёт, решение по цене.` + ((d.dS === 'late' || d.dS === 'order') ? ` По спросу было бы «${d.dS === 'late' ? 'Просрочено' : 'Заказать'}» ${fmtN(d.qtyCalc)} шт.` : ''),
      over: () => `Остаток ${fmtN(d.st0)} шт и ожидаемые ${fmtN(d.transitExp)} шт в пути при прогнозе ${fmtN(d.meanM)} шт/мес: через ${PR.overMonths} мес останется ${fmtN(d.overVal)} шт. В заказ не включать.`,
      blocked_supplier: () => `${nmS} не отгружает: ${d.S.blockReason === 'silent' ? 'приходов нет с ' + fmtD(d.S.lastReceipt ? dnum(d.S.lastReceipt) : null) + ' при заказах' : 'fill ' + fmtF(d.S.fill)}. Ожидаемый приход по его PO — 0.`,
      blocked_nosupplier: () => `Поставщика в данных нет (нет истории приходов), позиция продаётся: ${fmtN(d.meanM)} шт/мес.`,
      late_season: () => `Сезон ${d.season.label}: заказ к началу сезона нужно было разместить до ${fmtD(d.seasonOrderBy)} (старт − плечо p90 ${d.Lp90} дн − ${BUF} дн).`,
      late_stockout: () => `${d.st0 <= 0 ? 'Остатка нет' : 'Остатка хватит до ' + fmtD(dO)}, «заказать до» ${fmtD(ob)} прошло; до прихода ${fmtD(arr)} не продадим ≈${fmtN(lost)} шт.`,
      order_season: () => `Сезон ${d.season.label}: заказать до ${fmtD(d.seasonOrderBy)} (старт − плечо p90 ${d.Lp90} дн − ${BUF} дн), это в текущем цикле.`,
      order_offseason: () => `«Заказать до» ${fmtD(ob)} прошло, но до прихода ${fmtD(arr)} потери малы: ≈${fmtN(lost)} шт при пороге ${fmtN(d.thr)}.`,
      order_regular: () => `${dO == null ? 'Остаток опустится ниже страхового запаса' : 'Остатка хватит до ' + fmtD(dO)}; заказать до ${fmtD(ob)} — в этом цикле.`,
      depends_po: () => `При приходе ${depPO.po} (${fmtN(depPO.pending)} шт, обещан ${fmtD(dnum(depPO.promised))}) хватит до ${fmtD(d100)}, без него — до ${fmtD(dO)}.`,
      next: () => `Хватит до ${fmtD(dO)}; заказать до ${fmtD(ob)} — в следующем цикле.`,
      next_small: () => `По сроку пора заказывать, но к окну ${fmtD(arr)}–${fmtD(TODAY + d.Lmed + R + CV_ - 1)} нужно ${fmtN(qb.afterCompensation)} шт — меньше половины партии ${fmtN(qb.batch)} шт, перенос в следующий цикл.`,
      next_covered: () => `Остаток опустится ниже страхового запаса до ${fmtD(arr)}, но к приходу заказа ожидаем ${fmtN(qb.projectedAtArrival)} шт при потребности окна ${fmtN(qb.demand + qb.safetyStock)}: заказ в этом цикле не нужен.`,
      season_next: () => `Заказ сегодня придёт ${fmtD(arr)}, вне сезона: на окно нужно ${fmtN(Math.max(0, qb.afterCompensation))} шт. Сезон ${d.season.label} — заказать до ${fmtD(d.seasonOrderBy)} (старт − плечо p90 ${d.Lp90} дн − ${BUF} дн).`,
      ok: () => `Хватит до ${fmtD(dO)}, следующий заказ — до ${fmtD(ob)}.`,
      ok_long: () => `Запаса и того, что в пути, хватит больше чем на ${PR.overMonths} мес${cls[i].isNew ? ' (новинка: избыток не считаем)' : ''}.`,
      ok_nodemand: () => `Спрос по позиции не прогнозируется.`
    }[code]();
    let s2t = '';
    if (d.qtyCalc > 0 && st !== 'dead' && st !== 'over') {
      s2t = qb.rule === 'season'
        ? ` Количество: спрос с прихода ${fmtD(arr)} до конца сезона ${fmtN(qb.season.demand)} + страховой ${fmtN(qb.season.ss)} − ожидаемый остаток ${fmtN(qb.projectedAtArrival)} = ${fmtN(qb.season.net)}, кратно партии ${fmtN(qb.batch)} → ${fmtN(d.qtyCalc)} шт.`
        : ` Количество: спрос ${fmtD(arr)}–${fmtD(TODAY + d.Lmed + R + CV_ - 1)} ${fmtN(qb.demand)} + страховой ${fmtN(qb.safetyStock)} − ожидаемый остаток ${fmtN(qb.projectedAtArrival)} = ${fmtN(qb.net)}, кратно партии ${fmtN(qb.batch)} → ${fmtN(d.qtyCalc)} шт.`;
      if (qb.compensation) s2t += ` С компенсацией fill ${fmtF(qb.compensation.fill)}.`;
    }
    let s3t = '';
    if (st === 'blocked') s3t = alt ? ` Альтернатива: ${alt.name} (fill ${fmtF(alt.fill)}, плечо ${alt.leadMed} дн, ${alt.whyText}).` : ' Альтернативы в данных нет — искать поставщика.';
    else if (st !== 'dead' && st !== 'over') {
      if (depPO && code !== 'depends_po') s3t = ` Риск: ${depPO.po} просрочен на ${depPO.daysLate} дн${depPO.state === 'overdue' ? ', в ожидаемом приходе 0' : ''}.`;
      else if (d.season && d.season.start < arr && st !== 'margin') s3t = ` Приход ${fmtD(arr)} позже начала сезона ${fmtD(d.season.start)}: начало сезона закрывает только то, что есть и в пути.`;
      else if (d.qtyCalc > 0 && d.supId && d.fill < 0.7) s3t = ` Fill ${fmtF(d.fill)}: ожидаемо придёт ≈${fmtN(d.qtyCalc * d.fill)} шт, подтвердить объём.`;
      else if (d.qtyCalc > 0 && d.supId) s3t = ` Приход ${fmtD(arr)}–${fmtD(arr90)} (медиана–p90 плеча).`;
    }
    const explain = (s1t + s2t + s3t).replace(/[ \t\r\n]+/g, ' ').trim();   // \s съел бы неразрывные пробелы в разрядах
    return {code, ground, explain, lastSale};
  }

  /* ---- сборка позиций ---- */
  const skus = [], openPOs = [];
  for (let i = 0; i < n; i++) {
    const d = D[i], c = catOf[i], S = d.S;
    const alt = (d.status === 'blocked') ? altFor(i, d.supId) : null;
    const tx = texts(d, alt);
    const transitDates = d.arrPO.list.map(p => p.expectedDate).sort();
    const overdue = d.arrPO.list.some(p => p.pending > 0 && (p.state === 'overdue' || p.state === 'late' || p.supplierBlocked));
    d.arrPO.list.forEach(p => openPOs.push(p));
    const statusAlt = D_ALT[i].status;
    const inPlan = d.status === 'late' || d.status === 'order';
    const flags = {
      new: cls[i].isNew, noCost: !cls[i].dead && mk(i) == null, intermittent: cls[i].intermittent, seasonal: catInfo[c].seasonal,
      offSeason: d.offSeason, urgentPrice: d.status === 'margin' && (d.dS === 'late' || d.dS === 'order'),
      dependsOnPO: !cls[i].dead && d.dS100 !== d.dS && d.arrPO.list.length > 0, fillSensitive: statusAlt !== d.status,
      seasonBeforeArrival: !!(d.season && d.season.start < TODAY + d.Lmed), weightImputed: d.wImp,
      forecastUnreliable: cls[i].unreliable, belowHalfBatch: d.demoted, tailC: F12[i] < PR.tailCQtyYear && !cls[i].dead
    };
    const priority = r0(unitValue(i) * (d.lostBefore + 0.1 * (inPlan ? d.qtyCalc : 0)));
    const qty = inPlan ? d.qtyCalc : 0;
    skus.push({
      id: ids[i], name: NAMES.sku[ids[i]], cat: c, catName: CAT_RU[c] || c, brand: C.sku.brand[i] || null,
      sup: d.supId, supName: d.supId ? supName(d.supId) : null, supMain: C.sku.sup[i] || null, supplyType: C.sku.st[i] || null,
      status: d.status, demandStatus: d.dS, status100: d.dS100, statusAltFill: statusAlt, reason: tx.code,
      ground: tx.ground, explain: tx.explain, signal: `${NAMES.sku[ids[i]]}: ${tx.ground}`,
      flags, cls: ABC[i], service: cls[i].dead ? null : svc(ABC[i]),
      markup: mk(i), priceDecile: C.sku.dec[i], unitValue: r2(unitValue(i)), valueIndex: r0(V[i]),
      firstSale: C.sales.m0[i], lastSale: tx.lastSale == null ? null : mstr(tx.lastSale),
      stock01: stock01[i], stock: r0(d.st0), transit: d.transit, transitExpected: d.transitExp, transitDate: transitDates[0] || null, transitOverdue: overdue,
      pos: d.arrPO.list.filter(p => p.pending > 0).map(p => p.po),
      sales12: r0(cls[i].sales12), demand12: r0(cls[i].demand12), restoredMonths: d.restoredMonths, restoredQty: r0(d.restoredQty), monthsNoStock: d.censoredMonths,
      forecast: {method: fcMeta[i].method, level: r2(fcMeta[i].level), trend: r3(fcMeta[i].trend), trendSource: fcMeta[i].trendSrc, si: fcMeta[i].siSrc},
      f30: r0(d.f30), f90: r0(d.f90), f180: r0(d.f180), f12: r0(F12[i]), perMonth: r0(F12[i] / 12),
      lead: {med: d.Lmed, p90: d.Lp90, sigma: r2(d.sigL), delay: S ? S.delay : 0, source: S ? S.leadSource : 'noSupplier'},
      fill: S ? S.fill : null, fillRc: S ? S.fillRc : null, fillErp: S ? S.fillErp : null,
      arrival: iso(TODAY + d.Lmed), arrivalP90: iso(TODAY + d.Lp90),
      lastsUntil: d.outE == null ? null : iso(TODAY + d.outE), lastsUntil100: d.out100 == null ? null : iso(TODAY + d.out100),
      stockoutSS: d.ssE == null ? null : iso(TODAY + d.ssE), orderBy: iso(d.orderByE), orderBy100: iso(d.orderBy100),
      decisionBy: /season/.test(tx.code) && d.seasonOrderBy != null ? iso(d.seasonOrderBy) : iso(d.orderByE),
      season: d.season ? {label: d.season.label, start: iso(d.season.start), end: iso(d.season.end), orderBy: iso(d.seasonOrderBy), startsBeforeArrival: d.season.start < TODAY + d.Lmed, rule: d.seasonCond, fired: d.seasonFired} : null,
      lostBeforeArrival: r0(d.lostBefore), lostThreshold: r0(d.thr),
      ss: {now: d.ss18[0], atWindow: d.qtyBreakdown.safetyStock, formula: d.ssForm},
      batch: d.batch, weightKg: r3(d.weight),
      qty, qtyCalc: d.qtyCalc, qtyBreakdown: d.qtyBreakdown,
      expectedArrivalQty: r0(d.qtyCalc * (d.supId ? d.fill : 1)), gapAfterOrder: d.gapAfter,
      coverMonths: d.meanM > 0 ? r2((d.st0 + d.transitExp) / d.meanM) : null, overFrozen: d.status === 'over' ? r0(d.overVal) : 0,
      priority, alt,
      monthly: {from: mstr(CUR), hist: d.hist12, histFrom: mstr(CUR - 12), fcst: d.fc18, projExp: d.projExpM, proj100: d.proj100M, projOrder: d.projOrderM, ss: d.ss18}
    });
  }
  mark('texts');

  /* ---- поставщики: итоговая таблица ---- */
  const totF = skus.reduce((a, s) => a + s.f12, 0) || 1;
  const suppliers = Object.keys(SUPS.sup).filter(s => supDim[s] || skus.some(x => x.sup === s) || rcBySup[s]).map(s => {
    const A = SUPS.sup[s], B = SUPS_ALT.sup[s], mine = skus.filter(x => x.sup === s);
    const catsCnt = {}; mine.forEach(x => catsCnt[x.cat] = (catsCnt[x.cat] || 0) + 1);
    const po = openPOs.filter(p => p.sup === s);
    const fillRc = PR.fillMethod === 'erp' ? B.fill : A.fill, fillErp = PR.fillMethod === 'erp' ? A.fill : B.fill;
    return {
      id: s, name: supName(s), type: supType[s] === 'local' ? 'local' : 'import', mainCat: supMainCat[s],
      skus: mine.length, active: mine.filter(x => x.status !== 'dead').length, cats: catsCnt,
      fill: A.fill, fillMethod: PR.fillMethod, fillSource: A.fillSource, fillReceipts: fillRc, fillErp, fillReceiptsRaw: A.fillRc, fillErpRaw: A.fillErp, confirmRate: A.confirmRate,
      poClosed: A.poClosed, poAll: A.poAll, ordered: A.ordered, matched: A.matched, receivedErp: A.receivedErp,
      leadMed: A.leadMed, leadP90: A.leadP90, leadSigma: A.leadSigma, leadSource: A.leadSource, leadPlanMed: A.leadPlanMed, leadMatches: A.leadMatches, delay: A.delay,
      lastReceipt: A.lastReceipt, lastPO: A.lastPO, receipts12: A.receipts12, blocked: A.blocked, blockReason: A.blockReason,
      inTransit: po.reduce((a, p) => a + p.pending, 0), expected: po.reduce((a, p) => a + p.expectedQty, 0), openPO: po.filter(p => p.pending > 0).length,
      overduePO: po.filter(p => p.state === 'overdue' && p.pending > 0).length,   // строки, по которым ещё есть что ждать
      demandShare: r3(mine.reduce((a, x) => a + x.f12, 0) / totF), byYear: A.byYear,
      plan: {late: mine.filter(x => x.status === 'late').length, order: mine.filter(x => x.status === 'order').length, next: mine.filter(x => x.status === 'next').length, blocked: mine.filter(x => x.status === 'blocked').length,
        qty: mine.reduce((a, x) => a + x.qty, 0)}
    };
  }).sort((a, b) => b.demandShare - a.demandShare || (a.id < b.id ? -1 : 1));
  suppliers.forEach(s => {
    s.note = `${s.skus} поз., активных ${s.active}. Fill ${fmtF(s.fillReceipts)} по приходам · ${fmtF(s.fillErp)} по полю ERP${s.fillSource === 'unmatched' ? ' (PO не сопоставились с приходами — взята средняя)' : s.fillSource !== 'data' ? ' (мало PO, сглажено)' : ''}. ` +
      (s.blocked ? (s.blockReason === 'silent' ? `Не отгружает: последний приход ${s.lastReceipt ? fmtD(dnum(s.lastReceipt)) : 'не было'}, заказы были.` : `Fill ниже ${fmtF(PR.blockFill)}.`) :
        s.plan.late + s.plan.order ? `К заказу сейчас ${s.plan.late + s.plan.order} поз., ${fmtN(s.plan.qty)} шт.` : 'Заказов в этом цикле нет.');
  });
  const supById = {}; suppliers.forEach(s => supById[s.id] = s);

  /* ---- план: группы поставщиков ---- */
  const tonsOf = list => { let kg = 0, approx = false; for (const s of list) { kg += s.qty * s.weightKg; if (s.flags.weightImputed && s.qty) approx = true; } return {kg: r0(kg), tons: r2(kg / 1000), tonsApprox: approx, containers: r2(kg / PR.containerKg)}; };
  const planList = skus.filter(s => s.status === 'late' || s.status === 'order');
  const groups = {};
  planList.forEach(s => { const k = s.sup || ''; (groups[k] || (groups[k] = [])).push(s); });
  const planGroups = Object.keys(groups).map(k => {
    const rs = groups[k].slice().sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
    const A = k ? supById[k] : null, w = tonsOf(rs);
    return {sup: k || null, name: k ? A.name : 'Без поставщика', fill: A ? A.fill : null, leadMed: A ? A.leadMed : PR.leadNoSupplier,
      arrival: iso(TODAY + (A ? A.leadMed : PR.leadNoSupplier)), count: rs.length, late: rs.filter(s => s.status === 'late').length,
      qty: rs.reduce((a, s) => a + s.qty, 0), expected: rs.reduce((a, s) => a + s.expectedArrivalQty, 0), ...w,
      containersCeil: Math.ceil(w.kg / PR.containerKg - 1e-9), priority: rs.reduce((a, s) => a + s.priority, 0),
      orderByMin: rs.map(s => s.orderBy).filter(Boolean).sort()[0] || null, skus: rs.map(s => s.id)};
  }).sort((a, b) => b.priority - a.priority || b.qty - a.qty || ((a.sup || '') < (b.sup || '') ? -1 : 1));
  const sumPlan = list => ({count: list.length, qty: list.reduce((a, s) => a + s.qty, 0), expected: list.reduce((a, s) => a + s.expectedArrivalQty, 0), ...tonsOf(list)});
  const nextList = skus.filter(s => s.status === 'next');

  /* ---- статусы ---- */
  const STATUS_ORDER = ['dead', 'margin', 'over', 'blocked', 'late', 'order', 'next', 'ok'];
  const statusCounts = {}; STATUS_ORDER.forEach(k => statusCounts[k] = 0); skus.forEach(s => statusCounts[s.status]++);

  /* ---- сезонная готовность ---- */
  const seasonReadiness = cats.filter(c => catInfo[c].seasonal && readyWin[c]).map(c => {
    const rw = readyWin[c], idx = skus.map((s, i) => i).filter(i => catOf[i] === c && !cls[i].dead);
    let need = 0, lostB = 0, lost100 = 0, lostF = 0, stockNow = 0, transit = 0, transitExp = 0, planQty = 0, planCnt = 0;
    const a0 = Math.max(0, rw.start - TODAY), a1 = rw.end - TODAY + 1;
    for (const i of idx) {
      for (let t = a0; t < a1; t++) need += FM[i][dayK[t]] / dayDim[t];
      lostB += D[i].rwLostBase || 0; lost100 += D[i].rwLost100 || 0; lostF += D[i].rwLostFill || 0;
      stockNow += skus[i].stock; transit += skus[i].transit; transitExp += skus[i].transitExpected;
      if (skus[i].qty > 0) { planQty += skus[i].qty; planCnt++; }
    }
    const pct = x => need > 0 ? r3((need - x) / need) : 1;
    const arrivals = idx.filter(i => skus[i].qty > 0).map(i => skus[i].arrival).sort();
    const sob = idx.map(i => skus[i].season && skus[i].season.start === iso(rw.start) ? dnum(skus[i].season.orderBy) : rw.start - (D[i].Lp90) - BUF);
    const orderBy = sob.length ? Math.min(...sob) : null;
    const startsBefore = idx.length ? idx.filter(i => rw.start < TODAY + D[i].Lmed).length : 0;
    return {
      cat: c, title: CAT_RU[c] || c, season: rw.label, start: iso(rw.start), end: iso(rw.end), started: rw.start <= TODAY,
      share: catInfo[c].season.share, peakMonth: catInfo[c].peakMonth, peakShare: catInfo[c].peakShare,
      need: r0(need), stock: stockNow, transit, transitExpected: transitExp,
      covered: {transitOnly: r0(need - lostB), plan100: r0(need - lost100), planFill: r0(need - lostF)},
      readiness: {transitOnly: pct(lostB), plan100: pct(lost100), planFill: pct(lostF)},
      gap: {transitOnly: r0(lostB), plan100: r0(lost100), planFill: r0(lostF)},
      planCount: planCnt, planQty, firstArrival: arrivals[0] || null, orderBy: iso(orderBy), orderByPassed: orderBy != null && orderBy < TODAY,
      skusStartBeforeArrival: startsBefore, skus: idx.length,
      formula: 'готовность = (нужно − потери в окне сезона по проекции) / нужно; нужно = Σ прогноза по дням сезона'
    };
  });

  /* ---- избыток, мёртвые, упущенный спрос ---- */
  const overList = skus.filter(s => s.status === 'over');
  const excess = {count: overList.length, frozenQty: overList.reduce((a, s) => a + s.overFrozen, 0), stockQty: overList.reduce((a, s) => a + s.stock, 0),
    byCat: cats.map(c => ({cat: c, count: overList.filter(s => s.cat === c).length, frozenQty: overList.filter(s => s.cat === c).reduce((a, s) => a + s.overFrozen, 0)})).filter(x => x.count),
    top: overList.slice().sort((a, b) => b.overFrozen - a.overFrozen).slice(0, 10).map(s => s.id)};
  const deadList = skus.filter(s => s.status === 'dead');
  const emptyMk = C.sku.mk.filter(v => v == null).length;
  const noCostAlive = skus.filter(s => s.flags.noCost).length;
  const dead = {count: deadList.length, readme: emptyMk, noCostAlive, stockQty: deadList.reduce((a, s) => a + s.stock, 0), withStock: deadList.filter(s => s.stock > 0).length,
    byCat: cats.map(c => ({cat: c, count: deadList.filter(s => s.cat === c).length, stockQty: deadList.filter(s => s.cat === c).reduce((a, s) => a + s.stock, 0)})),
    note: `README: ${emptyMk} (пустая наценка) · по продажам: ${deadList.length} · разница ${emptyMk - deadList.length} — продажи без себестоимости в ERP (флаг no_cost: ${noCostAlive})`};
  let mNo = 0, mNoZero = 0, mNoActive = 0, mNoZeroActive = 0, rMonths = 0, rQty = 0;
  const lostByCat = {}; cats.forEach(c => lostByCat[c] = {months: 0, qty: 0});
  for (let i = 0; i < n; i++) {
    const active = C.sku.mk[i] != null;
    for (let k = Math.max(0, stockBase - M0); k < NM; k++) {
      const mi = M0 + k; if (mi < m0i[i]) continue;
      if (s1(i, mi) === 0) { mNo++; if (sold[i][k] === 0) mNoZero++; if (active) { mNoActive++; if (sold[i][k] === 0) mNoZeroActive++; } }
      const f = cens[i][k]; if (f === 1 || f === 2) { rMonths++; rQty += restored[i][k] - net[i][k]; lostByCat[catOf[i]].months++; lostByCat[catOf[i]].qty += restored[i][k] - net[i][k]; }
    }
  }
  const lostDemand = {
    monthsNoStock: mNo, monthsNoStockZeroSales: mNoZero, monthsNoStockActive: mNoActive, monthsNoStockZeroSalesActive: mNoZeroActive,
    restoredMonths: rMonths, restoredQty: r0(rQty), byCat: cats.map(c => ({cat: c, months: lostByCat[c].months, qty: r0(lostByCat[c].qty)})),
    top: skus.slice().sort((a, b) => b.restoredQty - a.restoredQty || (a.id < b.id ? -1 : 1)).slice(0, 10).map(s => ({id: s.id, months: s.restoredMonths, qty: s.restoredQty})),
    period: `${mstr(stockBase)}…${mstr(CUR - 1)}`,
    method: 'Месяц без остатка на 1-е и без прихода и продаж — спрос = уровень × индекс месяца; приход в день k — добавляется доля (k−1)/дней, не больше 2× ожидания. Уровень — по месяцам с остатком ±6 мес. До ' + fmtM(stockBase) + ' остатков нет, восстановления нет.'
  };

  /* ---- KPI ---- */
  const deficit90 = skus.filter(s => s.status !== 'dead' && s.status !== 'over' && s.lastsUntil && dnum(s.lastsUntil) <= TODAY + 90).length;
  const kpi = {
    orderNow: sumPlan(planList), late: statusCounts.late, order: statusCounts.order, next: sumPlan(nextList),
    deficit90, notInPlan: {margin: statusCounts.margin, blocked: statusCounts.blocked, over: statusCounts.over, dead: statusCounts.dead},
    blockedDemandQty: skus.filter(s => s.status === 'blocked').reduce((a, s) => a + s.qtyCalc, 0),
    lateShareOfPlan: planList.length ? r3(statusCounts.late / planList.length) : 0,
    shortThanLead: skus.filter(s => s.status !== 'dead' && s.lastsUntil && dnum(s.lastsUntil) < dnum(s.arrival)).length,
    moneyNote: 'в деньгах — закупочных цен в выгрузке нет, подключается прайсом (фаза 2)', volumeNote: 'контейнеры — по весу, объёма в данных нет'
  };

  /* ---- просроченные PO ---- */
  openPOs.sort((a, b) => (a.promised < b.promised ? -1 : a.promised > b.promised ? 1 : a.po < b.po ? -1 : 1));
  const overduePOs = openPOs.filter(p => p.state === 'overdue');

  /* ---- сигналы (риск → срок → проверить → цена), топ-N ---- */
  const signals = [];
  suppliers.filter(s => s.blocked && s.plan.blocked).forEach(s => {
    const list = skus.filter(x => x.sup === s.id && x.status === 'blocked'), q = list.reduce((a, x) => a + x.qtyCalc, 0);
    const alts = [...new Set(list.map(x => x.alt && x.alt.name).filter(Boolean))];
    signals.push({kind: 'risk', code: 'blocked_supplier', rank: 0, score: q, go: 'plan', ref: {type: 'supplier', id: s.id},
      text: `${s.name} не отгружает: ${list.length} поз., ${fmtN(q)} шт по спросу — ${alts.length ? 'перенести на ' + alts.slice(0, 2).join(', ') : 'искать поставщика'}`});
  });
  const noSup = skus.filter(s => s.status === 'blocked' && !s.sup);
  if (noSup.length) signals.push({kind: 'risk', code: 'blocked_nosupplier', rank: 0, score: noSup.reduce((a, s) => a + s.qtyCalc, 0), go: 'plan', ref: null,
    text: `Без поставщика в данных: ${noSup.length} активных поз., ${fmtN(noSup.reduce((a, s) => a + s.qtyCalc, 0))} шт по спросу — найти поставщика`});
  const lateTop = skus.filter(s => s.status === 'late').sort((a, b) => b.priority - a.priority)[0];
  if (lateTop) signals.push({kind: 'risk', code: 'late_top', rank: 0, score: lateTop.lostBeforeArrival, go: 'plan', ref: {type: 'sku', id: lateTop.id},
    text: `Просрочено ${statusCounts.late} поз.; сильнее всего теряем на «${lateTop.name}»: ${lateTop.ground}`});
  seasonReadiness.forEach(r => {
    const inCycle = skus.filter(s => s.cat === r.cat && s.season && s.season.fired && (s.status === 'order' || s.status === 'late'));
    if (inCycle.length) signals.push({kind: 'deadline', code: 'season_in_cycle', rank: 1, score: inCycle.reduce((a, s) => a + s.qty, 0), go: 'plan', ref: {type: 'category', id: r.cat},
      text: `${r.title}, сезон ${r.season}: к сезону заказать в этом цикле ${inCycle.length} поз. по сезонному правилу, ${fmtN(inCycle.reduce((a, s) => a + s.qty, 0))} шт; готовность ${Math.round(r.readiness.transitOnly * 100)} % → ${Math.round(r.readiness.planFill * 100)} % после плана`});
    else if (r.started || r.skusStartBeforeArrival === r.skus) signals.push({kind: 'deadline', code: 'season_transit_only', rank: 1, score: r.need, go: 'seasons', ref: {type: 'category', id: r.cat},
      text: `${r.title}, сезон ${r.season} начинается до прихода нового заказа: закрываем тем, что есть и в пути, готовность ${Math.round(r.readiness.transitOnly * 100)} %`});
  });
  if (overduePOs.length) {
    const bySup = {}; overduePOs.forEach(p => bySup[p.sup] = (bySup[p.sup] || 0) + p.pending);
    const top = Object.keys(bySup).sort((a, b) => bySup[b] - bySup[a])[0];
    signals.push({kind: 'check', code: 'overdue_po', rank: 2, score: overduePOs.reduce((a, p) => a + p.pending, 0), go: 'suppliers', goOpts: {supplier: top}, ref: {type: 'supplier', id: top},
      text: `Просроченные PO без подтверждения: ${overduePOs.length} шт. на ${fmtN(overduePOs.reduce((a, p) => a + p.pending, 0))} шт, больше всего у ${supName(top)} — в ожидаемом приходе 0, подтвердить`});
  }
  const dep = skus.filter(s => s.flags.dependsOnPO && s.status !== 'dead');
  if (dep.length) signals.push({kind: 'check', code: 'depends_po', rank: 2, score: dep.length, go: 'seasons', goOpts: {tab: 'deficit'}, ref: null,
    text: `Статус ${dep.length} поз. зависит от прихода открытых PO: при 100 % лучше, при ожидаемом — хуже`});
  const urg = skus.filter(s => s.flags.urgentPrice).sort((a, b) => b.qtyCalc - a.qtyCalc);
  if (urg.length) signals.push({kind: 'question', code: 'urgent_price', rank: 3, score: urg.length, go: 'assortment', ref: {type: 'sku', id: urg[0].id},
    text: `Наценка ниже ${pf} % при спросе к заказу: ${urg.length} поз. — решить по цене до заказа, первая «${urg[0].name}»`});
  signals.sort((a, b) => a.rank - b.rank || b.score - a.score);
  const signalsTop = signals.slice(0, PR.signalsTop);

  /* ---- 7 ловушек ---- */
  const poPlan = C.po.pl.filter(v => v != null);   // как в README: все 660 строк, включая нулевые и отрицательные
  const openAll = []; for (let k = 0; k < C.po.id.length; k++) if (C.po.status[k] === 'open') openAll.push(k);
  const pendOpen = openAll.reduce((a, k) => a + C.po.qp[k], 0), futOpen = openAll.filter(k => dnum(C.po.pd[k]) >= TODAY);
  const closedAll = []; for (let k = 0; k < C.po.id.length; k++) if (C.po.status[k] === 'closed') closedAll.push(k);
  const closedZero = closedAll.filter(k => C.po.qr[k] === 0).length;
  const traps = [
    {id: 1, title: 'Плечо поставки', where: 'дата прихода, «заказать до», окно количества',
      numbers: {planMedian: r0(median(poPlan)), planP25: r0(quantile(poPlan, 0.25)), planP90: r0(quantile(poPlan, 0.9)), shortThanLead: kpi.shortThanLead},
      text: `Плановое плечо по PO: медиана ${r0(median(poPlan))} дн, p25 ${r0(quantile(poPlan, 0.25))}, p90 ${r0(quantile(poPlan, 0.9))}. Заказ считается против спроса на окне [приход; приход + ${R + CV_} дн], а не текущих продаж. У ${kpi.shortThanLead} позиций остаток кончится раньше прихода заказа сегодня — это свойство ассортимента, а не ошибка расчёта.`},
    {id: 2, title: 'Сезонность по категориям', where: 'индекс категории, окно сезона, предсезонный срок',
      numbers: Object.fromEntries(cats.map(c => [c, {cv: catInfo[c].cv, type: catInfo[c].type, season: catInfo[c].season && catInfo[c].season.label, share: catInfo[c].season && catInfo[c].season.share}])),
      text: 'Тип спроса определён по данным (CV индекса > ' + fmtF(PR.seasonalCV) + '): ' + cats.map(c => `${CAT_RU[c]} — ${catInfo[c].type === 'seasonal' ? 'сезонная, ' + catInfo[c].season.label + ' ' + fmtPct(catInfo[c].season.share) : catInfo[c].type === 'moderate' ? 'умеренно сезонная (CV ' + fmtF(catInfo[c].cv) + ')' : 'ровная (CV ' + fmtF(catInfo[c].cv) + ')'}`).join('; ') + '.'},
    {id: 3, title: 'Открытые заказы', where: 'ожидаемые приходы в проекции, список просроченных PO',
      numbers: {open: openAll.length, pending: pendOpen, future: futOpen.length, futurePending: futOpen.reduce((a, k) => a + C.po.qp[k], 0), expected: openPOs.reduce((a, p) => a + p.expectedQty, 0), overdue: overduePOs.length, overduePending: overduePOs.reduce((a, p) => a + p.pending, 0)},
      text: `Открытых PO ${openAll.length} на ${fmtN(pendOpen)} шт; с датой в будущем ${futOpen.length} на ${fmtN(futOpen.reduce((a, k) => a + C.po.qp[k], 0))} шт. В проекции ожидаем ${fmtN(openPOs.reduce((a, p) => a + p.expectedQty, 0))} шт (pending × fill). ${overduePOs.length} строк PO просрочены (> ${PR.overduePoDays} дн или без подтверждения), с недопоставкой из них ${overduePOs.filter(p => p.pending > 0).length} на ${fmtN(overduePOs.reduce((a, p) => a + p.pending, 0))} шт — ожидаем 0.` + (openPOs.some(p => p.supplierBlocked && p.pending) ? ` У заблокированных поставщиков в пути ${fmtN(openPOs.filter(p => p.supplierBlocked).reduce((a, p) => a + p.pending, 0))} шт — тоже 0.` : '')},
    {id: 4, title: 'Наценка ниже порога', where: 'статус margin, флаг «срочно по цене»',
      numbers: {below: C.sku.mk.filter(v => v != null && v < PR.minMarkup).length, withMarkup: C.sku.mk.filter(v => v != null).length, margin: statusCounts.margin, urgent: urg.length},
      text: `Наценка ниже ${pf} %: ${C.sku.mk.filter(v => v != null && v < PR.minMarkup).length} из ${C.sku.mk.filter(v => v != null).length} продававшихся; в статусе «Низкая наценка» ${statusCounts.margin}, из них ${urg.length} со спросом к заказу — решить по цене.`},
    {id: 5, title: 'Мёртвый ассортимент', where: 'статус dead по продажам за 12 мес', numbers: {dead: deadList.length, readme: emptyMk, noCost: noCostAlive, stock: dead.stockQty},
      text: `Нет продаж 12 полных месяцев: ${deadList.length} позиций (README считает по пустой наценке ${emptyMk}; ${noCostAlive} продаются без себестоимости — флаг no_cost). Остаток у мёртвых ${fmtN(dead.stockQty)} шт.`},
    {id: 6, title: 'Упущенный спрос', where: 'восстановление истории перед прогнозом', numbers: {monthsNoStock: mNo, zeroSales: mNoZero, restoredMonths: rMonths, restoredQty: r0(rQty)},
      text: `С ${fmtM(stockBase)} месяцев без остатка ${fmtN(mNo)} (из них без продаж ${fmtN(mNoZero)}); восстановлено ${fmtN(rMonths)} мес, +${fmtN(rQty)} шт спроса. Больше всего: ${lostDemand.byCat.slice().sort((a, b) => b.qty - a.qty).slice(0, 2).map(x => CAT_RU[x.cat] + ' ' + fmtN(x.qty)).join(', ')}.`},
    {id: 7, title: 'Fill rate по полю ERP занижен', where: 'метод fill rate, ожидаемые приходы, блокировка',
      numbers: {closed: closedAll.length, closedZeroReceived: closedZero, fillErp: SUPS.globalFillErp, fillReceipts: SUPS.globalFillRc},
      text: `${closedZero} из ${closedAll.length} закрытых заказов без проставленного прихода (qty_received = 0), хотя в receipts.csv приходы есть; по сверке с приходами ${fmtF(SUPS.globalFillRc)} вместо ${fmtF(SUPS.globalFillErp)}. Метод — параметр, оба числа в карточке поставщика.`}
  ];

  /* ---- проверки критика ---- */
  const critic = [];
  skus.forEach(s => {
    if (s.qty > 0 && s.qty > 2 * s.f12) critic.push({code: 'qty_gt_2y', sku: s.id, text: `«${s.name}»: заказ ${fmtN(s.qty)} шт больше двух годовых прогнозов (${fmtN(s.f12)})`});
    if (s.qty > 0 && s.coverMonths != null && s.coverMonths > PR.overMonths) critic.push({code: 'order_over', sku: s.id, text: `«${s.name}»: заказ при покрытии ${fmtN(s.coverMonths)} мес`});
    if (s.qty > 0 && s.season && s.season.startsBeforeArrival && s.qtyBreakdown.rule === 'net' && s.status !== 'late') critic.push({code: 'season_after_start', sku: s.id, text: `«${s.name}»: приход ${fmtD(dnum(s.arrival))} после начала сезона ${s.season.label} — заказ работает на хвост сезона`});
    if (s.qty > 0 && (s.status === 'margin' || s.status === 'blocked')) critic.push({code: 'bad_in_plan', sku: s.id, text: `«${s.name}»: ${s.status} в заказе`});
    if (s.orderBy && s.stockoutSS && dnum(s.orderBy) !== dnum(s.stockoutSS) - s.lead.med - BUF) critic.push({code: 'order_by_formula', sku: s.id, text: `«${s.name}»: заказать до ≠ дефицит − плечо − буфер`});
  });
  const fs = skus.filter(s => s.flags.fillSensitive);
  if (fs.length) critic.push({code: 'fill_sensitive', sku: null, text: `Статус ${fs.length} поз. меняется при другом методе fill rate (${PR.fillMethod === 'erp' ? 'по приходам' : 'по полю ERP'})`});
  seasonReadiness.forEach(r => {
    if (r.planQty > 0 && r.gap.transitOnly > 0) critic.push({code: 'season_gap_vs_plan', sku: null, cat: r.cat, text: `${r.title}: разрыв сезона до заказа ${fmtN(r.gap.transitOnly)} шт, в плане ${fmtN(r.planQty)} шт; после плана × fill разрыв ${fmtN(r.gap.planFill)}`});
  });

  /* ---- проверки данных (сверка с README) ---- */
  const m = C.meta.rows;
  const checks = {
    rows: m, open: openAll.length, openFuture: futOpen.length, openFuturePending: futOpen.reduce((a, k) => a + C.po.qp[k], 0),
    pendingOpen: pendOpen, onOrderQty: sum(C.sku.oo), emptyMarkup: emptyMk, withMarkup: C.sku.mk.filter(v => v != null).length,
    belowMinMarkup: C.sku.mk.filter(v => v != null && v < PR.minMarkup).length, firstSale2026: C.sku.fs.filter(v => v && v >= mstr(Math.floor(CUR / 12) * 12)).length,
    newSkus: skus.filter(s => s.flags.new).length, intermittent: skus.filter(s => s.flags.intermittent && s.status !== 'dead').length,
    noSupplier: C.sku.sup.filter(v => !v).length, noSupplierActive: skus.filter(s => !s.sup && s.status !== 'dead').length,
    partialMonths: C.meta.partialMonths, partialRows: C.meta.partialRows, warnings: C.meta.warnings, paramErrors,
    abc: {A: ABC.filter(x => x === 'A').length, B: ABC.filter(x => x === 'B').length, C: ABC.filter(x => x === 'C').length},
    closedPO: closedAll.length, closedZeroReceived: closedZero, globalFillReceipts: SUPS.globalFillRc, globalFillErp: SUPS.globalFillErp,
    valueIndexNote: 'индекс ценности = Σ спроса за 12 мес × дециль цены × (1 + наценка/100); деньгами не подписывается, только для ABC и приоритета'
  };
  mark('aggregates');
  const res = {
    engine: 'velsa-engine', version: VERSION, params: PR, today: PR.today,
    calendar: {today: PR.today, month: mstr(CUR), histFrom: mstr(M0), histTo: mstr(CUR - 1), stockFrom: mstr(stockBase), horizonDays: H, overDay: OVER_T},
    categories: catInfo, statusOrder: STATUS_ORDER, statusCounts,
    skus, suppliers, openPOs, overduePOs,
    plan: {groups: planGroups, now: sumPlan(planList), next: sumPlan(nextList)},
    kpi, signals: signalsTop, signalsAll: signals, seasonReadiness, excess, dead, lostDemand, traps, checks, critic,
    names: NAMES, timing: null
  };
  timing.total = r2(nowMs() - t0);
  res.timing = timing;
  /* trace(id): дневной ряд одной позиции для графиков карточки (B-39, B-40). Тот же decide и та же проекция,
     что и в прогоне; в JSON результата не входит (неперечисляемое свойство), stableJSON и selftest не меняются */
  const idIdx = {}; ids.forEach((id, k) => idIdx[id] = k);
  function trace(id) {
    const i = idIdx[id]; if (i == null) return null;
    const d = decide(i, SUPS, false);
    const r1 = x => Math.round(x * 10) / 10;
    const take = arr => { const P = new Float64Array(H), L = new Float64Array(H); project(d.st0, fdBuf, H, arr, P, L); const end = [], lost = []; for (let t = 0; t < H; t++) { const e = P[t] - fdBuf[t] + L[t]; end.push(e <= 1e-9 ? 0 : Math.round(e * 1e4) / 1e4); lost.push(Math.round(L[t] * 1e4) / 1e4); } return {end, lost}; };
    const withOrder = k => take(d.arrPO.exp.concat([[d.Lmed, d.qtyCalc * k]]).sort((x, y) => x[0] - y[0]));
    const demand = [], ss = []; for (let t = 0; t < H; t++) { demand.push(Math.round(fdBuf[t] * 1e6) / 1e6); ss.push(r1(ssDay[t])); }
    const hist = {from: mstr(CUR - 12), net: [], restored: [], flag: []};
    for (let mi = CUR - 12; mi < CUR; mi++) { const k = mi - M0; hist.net.push(k >= 0 ? r0(net[i][k]) : 0); hist.restored.push(k >= 0 ? r0(restored[i][k]) : 0); hist.flag.push(k >= 0 ? cens[i][k] || 0 : 0); }
    return {id, today: PR.today, days: H, demand, ss, exp: take(d.arrPO.exp), full: take(d.arrPO.full),
      order: d.qtyCalc > 0 ? withOrder(d.supId ? d.fill : 1) : null, order100: d.qtyCalc > 0 ? withOrder(1) : null,
      arrivals: d.arrPO.list.map(p => ({po: p.po, t: dnum(p.expectedDate) - TODAY, pending: p.pending, expected: p.expectedQty, state: p.state})),
      arrT: d.Lmed, arrP90T: d.Lp90, qty: d.qtyCalc, fill: d.supId ? d.fill : null, hist};
  }
  Object.defineProperty(res, 'trace', {value: trace, enumerable: false});
  return res;
}

/* ================= дифф двух прогонов ================= */
function diff(prev, cur) {
  if (!prev || !cur) return {count: 0, items: [], summary: {}};
  const P = {}; prev.skus.forEach(s => P[s.id] = s);
  const items = [];
  const label = {late: 'Просрочено', order: 'Заказать', next: 'Следующий цикл', ok: 'Ок', over: 'Избыток', margin: 'Низкая наценка', dead: 'Мёртвый', blocked: 'Сменить поставщика'};
  cur.skus.forEach(s => {
    const p = P[s.id]; if (!p) { items.push({id: s.id, kind: 'new', text: `«${s.name}»: новая позиция`}); return; }
    if (p.status !== s.status) items.push({id: s.id, kind: 'status', from: p.status, to: s.status, text: `«${s.name}»: ${label[p.status]} → ${label[s.status]}`});
    if (p.orderBy && s.orderBy && Math.abs(dnum(p.orderBy) - dnum(s.orderBy)) > 7) items.push({id: s.id, kind: 'orderBy', from: p.orderBy, to: s.orderBy, text: `«${s.name}»: заказать до ${fmtD(dnum(p.orderBy))} → ${fmtD(dnum(s.orderBy))}`});
    const a = p.qty, b = s.qty;
    if ((a || b) && Math.abs(b - a) > 0.2 * Math.max(a, b)) items.push({id: s.id, kind: 'qty', from: a, to: b, text: `«${s.name}»: количество ${fmtN(a)} → ${fmtN(b)} шт`});
  });
  const summary = {status: items.filter(x => x.kind === 'status').length, orderBy: items.filter(x => x.kind === 'orderBy').length, qty: items.filter(x => x.kind === 'qty').length,
    planQty: [prev.plan.now.qty, cur.plan.now.qty], planCount: [prev.plan.now.count, cur.plan.now.count]};
  return {count: items.length, items, summary};
}

/* ================= стабильный JSON (без времени прогона) ================= */
function stableJSON(result) { return JSON.stringify(result, (k, v) => k === 'timing' ? undefined : v); }

/* ================= самопроверка ================= */
function selftest(result, compact) {
  const T = [], add = (name, expected, actual, ok) => T.push({name, ok: ok == null ? expected === actual : !!ok, expected, actual});
  const c = result.checks, R = c.rows;
  add('sku_dim: 791 позиция (README)', 791, R.sku_dim);
  add('sales_monthly: 37 414 строк (README)', 37414, R.sales_monthly);
  add('stock_monthly: 9 627 строк (README)', 9627, R.stock_monthly);
  add('purchase_orders: 660 строк (README)', 660, R.purchase_orders);
  add('receipts: 2 394 строки (README)', 2394, R.receipts);
  add('supplier_dim: 39 строк (README)', 39, R.supplier_dim);
  add('открытых PO 57 (README)', 57, c.open);
  add('из них с датой в будущем 22 (README)', 22, c.openFuture);
  add('в пути по ним 17 127 шт (README)', 17127, c.openFuturePending);
  add('Σ pending открытых = Σ on_order_qty (20 039 по 00 §2)', c.onOrderQty, c.pendingOpen, c.onOrderQty === c.pendingOpen && c.pendingOpen === 20039);
  add('ниже MIN_MARKUP_PCT 25: 68 SKU (README)', 68, result.params.minMarkup === 25 ? c.belowMinMarkup : 68);
  add('продававшихся за 12 мес (наценка не пустая): 413 (README)', 413, c.withMarkup);
  add('пустая наценка: 378 (README, «мёртвый ассортимент»)', 378, c.emptyMarkup);
  add('первая продажа в 2026: 116 (00 §2, 03 §4; в README нет)', 116, c.firstSale2026);
  add('неполный месяц 2026-08 у всех 791 позиции (README)', '2026-08 × 791', (c.partialMonths || []).join(',') + ' × ' + (c.partialRows || []).join(','));
  add('статус margin = 68 при пороге 25 % (B-13)', 68, result.params.minMarkup === 25 ? result.statusCounts.margin : 68);
  // арифметика количества
  let bad = [];
  result.skus.forEach(s => {
    const b = s.qtyBreakdown, net = b.demand + b.safetyStock - b.projectedAtArrival;
    let ok = net === b.net;
    if (b.season) ok = ok && b.season.demand + b.season.ss - b.season.projectedAtArrival === b.season.net;
    const base = b.rule === 'season' ? b.season.net : b.net;
    ok = ok && base === b.base && (b.season && b.season.net > 0 && b.rule === 'net' ? b.base === Math.max(b.net, b.season.net) : true);
    const ac = b.compensation ? Math.ceil(b.base / b.compensation.factor) : b.base;
    ok = ok && ac === b.afterCompensation;
    const q = ac <= 0 || ac < 0.5 * b.batch ? 0 : Math.ceil(ac / b.batch) * b.batch;
    ok = ok && q === b.qty && b.qty === s.qtyCalc && s.qty === ((s.status === 'late' || s.status === 'order') ? s.qtyCalc : 0) && b.qty % b.batch === 0;
    if (!ok) bad.push(s.id);
  });
  add('qtyBreakdown сходится арифметически у всех позиций', 0, bad.length);
  add('в плане нет margin / blocked / dead / over', 0, result.skus.filter(s => s.qty > 0 && !(s.status === 'late' || s.status === 'order')).length);
  add('просроченные PO: 35 строк / 2 912 шт (B-08)', '35 / 2912', result.overduePOs.length + ' / ' + result.overduePOs.reduce((a, p) => a + p.pending, 0));
  add('основание ≤ 60 знаков у всех позиций', 0, result.skus.filter(s => s.ground.length > 60).length);
  const C574 = result.skus.find(s => s.id === 'SKU-C574D6');
  add('SKU-C574D6: поставщик SUP-4E171A, остаток 4 на 01.08.2026', 'SUP-4E171A / 4', C574 ? C574.supMain + ' / ' + C574.stock01 : null);
  const H6 = result.skus.find(s => s.id === 'SKU-6669CE');
  add('SKU-6669CE: наценка 26 % — не margin', '26 / не margin', H6 ? H6.markup + ' / ' + (H6.status === 'margin' ? 'margin' : 'не margin') : null);
  const S357 = result.suppliers.find(s => s.id === 'SUP-357414');
  add('SUP-357414: fill по сверке ≈ 0,2, ERP 0,00, заблокирован', '≈0,2 / 0 / blocked', S357 ? `${S357.fillReceiptsRaw} / ${S357.fillErpRaw} / ${S357.blocked ? 'blocked' : '—'}` : null,
    S357 && Math.abs(S357.fillReceiptsRaw - 0.22) <= 0.05 && S357.fillErpRaw === 0 && S357.blocked);
  const SD5 = result.suppliers.find(s => s.id === 'SUP-D58E64');
  add('SUP-D58E64: fill по сверке ≫ 0,23 (ERP)', '≫ 0,23', SD5 ? `${SD5.fillReceiptsRaw} / ERP ${SD5.fillErpRaw}` : null, SD5 && SD5.fillReceiptsRaw > 0.5 && Math.abs(SD5.fillErpRaw - 0.23) < 0.01);
  // даты: сегодня ≤ дефицит по SS ≤ «хватит до»; «заказать до» = дефицит по SS − плечо − буфер; без остатка — «хватит до» = сегодня
  const T0d = dnum(result.today), BUFd = result.params.bufferDays;
  const incons = result.skus.filter(s => {
    if (s.lastsUntil && dnum(s.lastsUntil) < T0d) return true;
    if (s.stockoutSS && s.lastsUntil && dnum(s.stockoutSS) > dnum(s.lastsUntil)) return true;
    if (s.stockoutSS && (!s.orderBy || dnum(s.orderBy) !== dnum(s.stockoutSS) - s.lead.med - BUFd)) return true;
    if (s.lastsUntil && s.stock === 0 && s.status !== 'dead' && s.perMonth > 0 && dnum(s.lastsUntil) !== T0d) return true;
    return false;
  }).length;
  add('даты согласованы: сегодня ≤ дефицит по SS ≤ «хватит до», заказать до = дефицит по SS − плечо − буфер', 0, incons);
  const LD = result.lostDemand;
  add('месяцы без остатка у активных 01.2024–07.2026: 1 860 / 1 345 без продаж (00 §2)', '1860 / 1345', LD.monthsNoStockActive + ' / ' + LD.monthsNoStockZeroSalesActive);
  const t1 = result.traps[0].numbers;
  add('плановое плечо по PO: медиана 123, p25 52, p90 205 (README)', '123 / 52 / 205', t1.planMedian + ' / ' + t1.planP25 + ' / ' + t1.planP90);
  add('мёртвые по продажам 12 мес и сверка с 378 (B-13)', 'dead + no_cost = 378', result.dead.count + ' + ' + result.dead.noCostAlive + ' = ' + (result.dead.count + result.dead.noCostAlive), result.dead.count + result.dead.noCostAlive === result.dead.readme);
  add('прогноз 30 ≤ 90 ≤ 180 из одного дневного ряда', 0, result.skus.filter(s => !(s.f30 <= s.f90 + 0.5 && s.f90 <= s.f180 + 0.5)).length);
  const rdBad = result.seasonReadiness.filter(r => r.need > 0 && Math.abs(r.readiness.transitOnly - (r.need - r.gap.transitOnly) / r.need) > 0.002).length;
  add('сезонная готовность = (нужно − разрыв) / нужно у всех категорий', 0, rdBad);
  if (compact) {
    const again = run(compact, result.params);
    add('детерминизм: повторный прогон даёт тот же JSON', true, stableJSON(again) === stableJSON(result));
  }
  return T;
}

/* ================= адаптер к интерфейсу v5 (до волны 2) ================= */
function toLegacy(result) {
  const TODAY = result.today;
  const CATS = {}, PROFILE = {}, SEASON = {}, FLAT = [];
  Object.keys(result.categories).forEach(c => {
    const ci = result.categories[c]; CATS[c] = ci.name; PROFILE[c] = ci.share.map(x => Math.round(x * 100) / 100);
    if (ci.seasonal) { const a = ci.season.fromMonth, b = ci.season.toMonth; SEASON[c] = b >= a ? [a, b] : [a, 12]; } else FLAT.push(c);
  });
  const typeRu = t => t === 'local' ? 'локальный' : 'импорт';
  const SUP = {}, SUPX = {};
  result.suppliers.forEach(s => {
    if (!s.skus) return;
    SUP[s.id] = {type: s.blocked ? typeRu(s.type) + ', не отгружает' : typeRu(s.type), skus: s.skus, fill: s.fill, leadPlan: s.leadPlanMed || s.leadMed, leadFact: s.leadMed, inTransit: s.inTransit, overdue: s.overduePO, blocked: s.blocked};
    const fy = [2022, 2023, 2024, 2025, 2026].map(y => { const r = s.byYear.find(x => x.year === y); return r ? (s.fillMethod === 'erp' ? r.fillErp : r.fillRc) : null; });
    SUPX[s.id] = {fillByYear: fy, share: Math.round(s.demandShare * 100), cats: s.cats, note: s.note};
  });
  const noSup = result.skus.filter(s => !s.sup);
  if (noSup.length) {
    const cats = {}; noSup.forEach(s => cats[s.cat] = (cats[s.cat] || 0) + 1);
    SUP['—'] = {type: 'нет поставщика', skus: noSup.length, fill: 1, leadPlan: result.params.leadNoSupplier, leadFact: result.params.leadNoSupplier, inTransit: noSup.reduce((a, s) => a + s.transit, 0), overdue: 0, blocked: true};
    SUPX['—'] = {fillByYear: [null, null, null, null, null], share: Math.round(noSup.reduce((a, s) => a + s.f12, 0) / (result.skus.reduce((a, s) => a + s.f12, 0) || 1) * 100), cats, note: `Позиции без истории приходов: поставщик не определён, плечо ${result.params.leadNoSupplier} дн для дат, в заказ не идут.`};
  }
  const kindOf = s => s.status === 'dead' ? 'мёртвый' : (s.flags.new ? 'новинка' : s.flags.intermittent ? 'прерывистый' : s.flags.seasonal ? 'сезонный' : result.categories[s.cat].type === 'moderate' ? 'умеренно сезонный' : 'стабильный') +
    (s.forecast.trend >= 1.15 ? ', рост' : s.forecast.trend <= 0.85 ? ', спад' : '');
  const SKUS = result.skus.map(s => ({
    id: s.id, cat: s.cat, cls: s.cls || '—', kind: kindOf(s), sup: s.sup || '—',
    annual: s.forecast.trend ? Math.round(s.f12 / s.forecast.trend) : s.f12, growth: s.forecast.trend || 1,
    stock: s.stock, transit: s.transit, transitDate: s.transitDate || undefined, transitOverdue: s.transitOverdue || undefined,
    f30: s.f30, f90: s.f90, f180: s.f180,
    lastsUntil: s.lastsUntil || '—', orderBy: s.decisionBy || '—',
    qty: (s.status === 'late' || s.status === 'order') ? s.qty : s.status === 'next' ? s.qtyCalc : 0,
    markup: s.markup, status: s.status, w: s.weightKg, batch: s.batch, ground: s.ground, explain: s.explain, _r: s
  }));
  const NAMES = Object.assign({}, result.names.sku), SNAMES = Object.assign({'—': 'Без поставщика'}, result.names.sup);
  const SIGNALS = result.signals.map(x => ({kind: x.kind, text: x.text, go: x.go || 'plan', goOpts: x.goOpts}));
  const fmtNs = n => fmtN(n);
  const SEASON_READINESS = result.seasonReadiness.map(r => ({
    cat: r.cat, title: r.title, season: r.season,
    phrase: `Сезон ${r.season}: ${Math.round(r.share * 100)} % годовых продаж, пик — ${MON_FULL[r.peakMonth - 1]} (${Math.round(r.peakShare * 100)} %).`,
    need: r.need, needBy: r.start, have: r.stock, transit: r.transit, transitNote: r.transitExpected !== r.transit ? `ожидаем ${fmtNs(r.transitExpected)}` : '',
    gap: r.gap.transitOnly, gapNote: r.planQty ? `после плана × fill ${fmtNs(r.gap.planFill)}` : '',
    orderBy: r.started || r.skusStartBeforeArrival === r.skus ? null : r.orderBy, orderByLate: r.orderByPassed,
    orderByNote: r.started ? 'поздно: сезон уже идёт' : r.skusStartBeforeArrival === r.skus ? `поздно: приход ${fmtD(dnum(r.firstArrival || result.today))} после начала сезона` : undefined,
    readiness: Math.round(r.readiness.transitOnly * 100),
    readinessNote: r.planQty ? `после плана ${Math.round(r.readiness.planFill * 100)} % (× fill), ${Math.round(r.readiness.plan100 * 100)} % при 100 %` : 'заказов в цикле нет',
    todo: r.planQty ? `В плане ${r.planCount} поз., ${fmtNs(r.planQty)} шт. Разрыв до заказа ${fmtNs(r.gap.transitOnly)} шт, после плана × fill ${fmtNs(r.gap.planFill)}.` : `Новых заказов к сезону в цикле нет. Разрыв ${fmtNs(r.gap.transitOnly)} шт.`
  }));
  const STATUS = {
    late: {label: 'Просрочено', icon: 'clock-alert', color: 'var(--late)', order: 0},
    order: {label: 'Заказать', icon: 'shopping-cart', color: 'var(--order)', order: 1},
    next: {label: 'Следующий цикл', icon: 'calendar-clock', color: 'var(--next)', order: 2},
    blocked: {label: 'Сменить поставщика', icon: 'ban', color: 'var(--late)', order: 3},
    ok: {label: 'Ок', icon: 'circle-check', color: 'var(--ok)', order: 4},
    over: {label: 'Избыток', icon: 'layers', color: 'var(--over)', order: 5},
    margin: {label: 'Низкая наценка', icon: 'percent', color: 'var(--margin)', order: 6},
    dead: {label: 'Мёртвый', icon: 'archive', color: 'var(--dead)', order: 7}
  };
  const CHANGES = [{tag: 'данные', text: `Первый прогон в сессии: ${result.skus.length} позиций из выгрузки, сравнивать не с чем. «Что изменилось» появится после «Пересчитать» (волна 2).`}];
  return {TODAY, CATS, PROFILE, SEASON, FLAT_CATS: FLAT, SUP, SUPX, STATUS, SKUS, NAMES, SNAMES, SIGNALS, SEASON_READINESS, CHANGES, LOST: result.lostDemand, DEAD: result.dead};
}

return {VERSION, defaults, PARAM_RANGES, parseCSV, ingest, run, selftest, diff, toLegacy, snapshotJs, loadSnapshot, stableJSON,
  util: {dnum, iso, fmtN, fmtF, fmtD, zOf}};
}));
