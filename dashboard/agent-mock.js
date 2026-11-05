/* Муляж агента v6: ни одного вызова модели или сети — фаза 2.
   Ответы собираются шаблонами по коду причины (result.skus[].reason) из полей прогона Engine.run().
   Чисел предметных данных здесь нет: всё подставляется из ctx.R. Сообщение: {kind, title, text}; kind — ключ AGENT.kinds. */
const AGENT = (function () {
  /* шаблоны ответов по типу вопроса (в интерфейсе ролей нет: шаблон выбирает вопрос или подсказка) */
  const roles = ['critic', 'analyst', 'logist', 'mentor'];
  /* «предложение» — цвет --next: фиолетовый акцент запрещён брифом */
  const kinds = {
    risk: {icon: 'octagon-alert', color: '--late', label: 'Риск'},
    remark: {icon: 'triangle-alert', color: '--order', label: 'Замечание'},
    confirm: {icon: 'circle-check', color: '--ok', label: 'Подтверждение'},
    question: {icon: 'circle-help', color: '--ink-2', label: 'Вопрос'},
    proposal: {icon: 'lightbulb', color: '--next', label: 'Предложение'},
    info: {icon: 'info', color: '--ink-3', label: 'Справка'}
  };
  const KIND_BY_STATUS = {late: 'risk', blocked: 'risk', order: 'remark', margin: 'proposal', over: 'remark', next: 'info', ok: 'confirm', dead: 'info'};
  const TITLE_BY_REASON = {
    late_season: 'К сезону опоздали', late_stockout: 'Дефицит до прихода', order_season: 'Сезонный заказ в этом цикле', order_offseason: 'Межсезонный дефицит, потери малы',
    order_regular: 'Заказ в этом цикле', depends_po: 'Зависит от открытого PO', blocked_supplier: 'Поставщик не отгружает', blocked_nosupplier: 'Нет поставщика в данных',
    margin: 'Сначала решение по цене', over: 'Избыток', dead: 'Мёртвая позиция', next: 'Следующий цикл', next_small: 'Меньше половины партии', next_covered: 'Заказ не нужен',
    season_next: 'К сезону — в следующем цикле', ok: 'Запаса хватает', ok_long: 'Запаса на полтора года', ok_nodemand: 'Спрос не прогнозируется'
  };

  function greeting(c) {
    const R = c.R, f = c.fmt;
    return {kind: 'info', title: `Проверил план на ${c.dmy(R.today)}`, text: `Сверил объёмы со спросом, сезон — со сроком прихода, план — с открытыми заказами. Проверок прогона: ${f(R.critic.length)}, первые — во вкладке «Замечания».`};
  }

  function sku(role, s, c) {
    const R = c.R, f = c.fmt, ff = c.fmtF, d = c.dmy;
    const sup = s.sup ? c.supNameOf(s.sup) : null;
    if (role === 'critic') {
      const extra = [];
      R.critic.filter(x => x.sku === s.id).forEach(x => extra.push('Проверка критика: ' + x.text.replace(/^«[^»]*»:\s*/, '') + '.'));
      if (s.flags.fillSensitive) extra.push(`При другом методе доли поставки статус — «${c.STATUS[s.statusAltFill].label}».`);
      if (s.flags.dependsOnPO) extra.push(`При приходе 100 % статус по спросу — «${c.STATUS[s.status100] ? c.STATUS[s.status100].label : s.status100}».`);
      if (s.flags.weightImputed && c.inPlan(s)) extra.push('Вес штуки в данных пустой или аномальный — тоннаж приблизительный.');
      return {kind: KIND_BY_STATUS[s.status] || 'info', title: TITLE_BY_REASON[s.reason] || c.STATUS[s.status].label, text: [s.explain, ...extra].join(' ')};
    }
    if (role === 'analyst') {
      const m = s.forecast.method === 'seasonal-index' ? `по сезонному индексу (${s.forecast.si === 'mixed' ? 'смесь индекса позиции и категории' : 'индекс категории'})` : s.forecast.method === 'sba' ? 'методом SBA для прерывистого спроса, без сезонности' : s.forecast.method === 'new-analog' ? 'как новинки: свои месяцы и аналоги категории' : 'не строится';
      return {kind: 'info', title: 'Откуда прогноз', text: `Прогноз ${m}: уровень ${ff(s.forecast.level, 1)} шт в средний месяц, тренд ×${ff(s.forecast.trend)} (${s.forecast.trendSource === 'sku' ? 'по позиции' : s.forecast.trendSource === 'category' ? 'по категории' : 'не считается'}). На 30 / 90 / 180 дн — ${f(s.f30)} / ${f(s.f90)} / ${f(s.f180)} шт, на 12 мес — ${f(s.f12)}. За 12 полных месяцев продано ${f(s.sales12)}, спрос после восстановления ${f(s.demand12)}${s.restoredMonths ? `: восстановлено ${s.restoredMonths} мес без остатка, +${f(s.restoredQty)} шт` : ''}.${s.flags.forecastUnreliable ? ' Больше половины истории без остатка — прогноз ненадёжен.' : ''}`};
    }
    if (role === 'logist') {
      const q = c.inPlan(s) ? c.qtyOf(s) : s.qtyCalc;
      const po = R.openPOs.filter(p => p.sku === s.id && p.pending > 0);
      const poTxt = po.length ? ' В пути: ' + po.map(p => `${p.po} — ${f(p.pending)} шт, обещан ${d(p.promised)}${p.state !== 'future' ? `, просрочен ${p.daysLate} дн${p.expectedQty ? '' : ', в ожидаемом 0'}` : ''}`).join('; ') + '.' : ' Открытых заказов нет.';
      if (!s.sup) return {kind: 'risk', title: 'Нет поставщика', text: `Истории приходов нет — плечо ${s.lead.med} дн для дат условное.${s.alt ? ` Из данных подходит ${s.alt.name}: доля поставки ${ff(s.alt.fill)}, плечо ${s.alt.leadMed} дн, ${s.alt.whyText}.` : ' Альтернативы в данных нет — искать поставщика.'}${poTxt}`};
      return {kind: s.status === 'blocked' ? 'risk' : s.fill < 0.7 ? 'remark' : 'info', title: `${sup}: сроки и объём`, text: `Доля поставки ${ff(s.fill)} по приходам (${ff(s.fillErp)} по полю ERP), плечо ${s.lead.med} дн, p90 ${s.lead.p90}: при заказе сегодня приход ${c.range(s.arrival, s.arrivalP90)}. Партия ${f(s.batch)}, ${s.flags.weightImputed ? '≈' : ''}${ff(s.weightKg, 1)} кг/шт${q ? ` → ${f(q)} шт ≈ ${ff(q * s.weightKg / 1000, 1)} т` : ''}.${poTxt}${s.status === 'blocked' ? (s.alt ? ` Перенос на ${s.alt.name}: доля поставки ${ff(s.alt.fill)}, плечо ${s.alt.leadMed} дн.` : ' Альтернативы в данных нет.') : ''}`};
    }
    // наставник: простыми словами
    const lu = s.lastsUntil ? d(s.lastsUntil) : null;
    const q = c.inPlan(s) ? c.qtyOf(s) : s.qtyCalc;
    let t;
    if (s.status === 'late') t = `${lu && s.lastsUntil > R.today ? 'Товар закончится ' + lu : 'Товара уже нет'}, а новый заказ приедет только ${d(s.arrival)}. За это время не продадим примерно ${f(s.lostBeforeArrival)} шт. Заказать ${f(q)} шт нужно сейчас — иначе потеряем и следующий период.`;
    else if (s.status === 'order') t = `Заказ нужно разместить в этом цикле, до ${d(s.decisionBy)}: ${f(q)} шт приедут ${d(s.arrival)} и закроют спрос до ${d(s.qtyBreakdown.window.to)}. Если пропустить срок, остаток уйдёт ниже страхового запаса.`;
    else if (s.status === 'blocked') t = `Этот поставщик ${s.sup ? 'перестал отгружать' : 'не определён'}: заказ у него ничего не привезёт. По спросу нужно ${f(s.qtyCalc)} шт — ${s.alt ? 'можно перенести заказ на ' + s.alt.name + ' одной кнопкой «Перенести»' : 'нужно искать нового поставщика'}.`;
    else if (s.status === 'next') t = `Сейчас заказывать рано: решение — в следующем цикле, до ${d(s.decisionBy)}.`;
    else if (s.status === 'margin') t = `Позиция продаётся с наценкой ${s.markup} % — ниже порога ${R.params.minMarkup} %. Сначала решить с ценой, потом заказывать${s.flags.urgentPrice ? ': спрос есть, поэтому решение срочное' : ''}.`;
    else if (s.status === 'over') t = `Товара слишком много: через ${R.params.overMonths} мес останется ${f(s.overFrozen)} шт. Не заказывать, подумать об акции.`;
    else if (s.status === 'dead') t = `Позиция не продаётся с ${s.lastSale ? s.lastSale.slice(5, 7) + '.' + s.lastSale.slice(0, 4) : 'начала истории'}. Не заказывать, остаток ${f(s.stock)} шт — списать или распродать.`;
    else t = lu ? `Запаса хватит до ${lu}, следующий заказ — до ${d(s.orderBy)}. Сейчас ничего делать не нужно.` : 'Запаса хватит надолго. Сейчас ничего делать не нужно.';
    return {kind: KIND_BY_STATUS[s.status] || 'info', title: 'Простыми словами', text: t};
  }

  function supplier(role, S, c) {
    const R = c.R, f = c.fmt, ff = c.fmtF, d = c.dmy;
    const mine = R.skus.filter(s => s.sup === S.id), plan = mine.filter(c.inPlan), q = plan.reduce((a, s) => a + c.qtyOf(s), 0);
    const po = R.openPOs.filter(p => p.sup === S.id), over = po.filter(p => p.state !== 'future');
    if (role === 'logist' || role === 'critic') {
      if (S.blocked) return {kind: 'risk', title: 'Поставщик не отгружает', text: `${S.name}: ${S.blockReason === 'silent' ? 'приходов нет с ' + d(S.lastReceipt) + ' при заказах' : 'доля поставки ниже порога'}. Ожидаемый приход по его PO — 0, ${f(mine.filter(s => s.status === 'blocked').length)} поз. в группе «Сменить поставщика». Доля поставки ${ff(S.fillReceipts)} по приходам, ${ff(S.fillErp)} по полю ERP.`};
      return {kind: S.fill < 0.7 || over.length ? 'remark' : 'confirm', title: `${S.name}: ${plan.length ? 'к заказу ' + plan.length + ' поз.' : 'заказов в цикле нет'}`, text: `Доля поставки ${ff(S.fillReceipts)} по приходам (${ff(S.fillErp)} по полю ERP${S.fillSource !== 'data' ? ', мало PO — сглажено' : ''}), плечо ${S.leadMed} дн, p90 ${S.leadP90}. ${plan.length ? `К заказу ${plan.length} поз., ${f(q)} шт, приход при заказе сегодня ${d(c.isoOf(c.todayD() + S.leadMed))}.` : ''} Открытых PO ${po.length}${over.length ? `, просрочено ${over.length} — запросить подтверждение` : ''}.`};
    }
    if (role === 'analyst') return {kind: 'info', title: 'Доля в спросе', text: `${S.name}: ${c.pctS(S.demandShare)} прогноза на 12 мес, ${S.skus} поз. (активных ${S.active}), основная категория — ${c.catName(S.mainCat)}. По годам: ${S.byYear.length ? S.byYear.map(y => y.year + ' — ' + ff(y.fillRc) + ' / ' + ff(y.fillErp)).join(', ') + ' (по приходам / ERP)' : 'закрытых PO нет'}.`};
    return {kind: 'info', title: 'Простыми словами', text: S.blocked ? `Этот поставщик давно ничего не привозит. Заказывать у него бессмысленно — позиции переносим на альтернативу или ищем нового.` : `Поставщик привозит около ${Math.round(S.fill * 10)} из 10 заказанных штук и едет ${S.leadMed} дн. ${plan.length ? 'Заказ этого цикла — ' + f(q) + ' шт.' : 'В этом цикле заказывать у него нечего.'}`};
  }

  function category(role, cat, c) {
    const R = c.R, f = c.fmt, C = R.categories[cat], r = R.seasonReadiness.find(x => x.cat === cat);
    if (!C) return null;
    if (!r) return {kind: 'info', title: C.name, text: `${C.name}: ${C.type === 'moderate' ? 'умеренно сезонная' : 'ровная'} категория (CV индекса ${c.fmtF(C.cv)}), пик — ${c.pctS(C.peakShare)} годовых продаж. Сезонного правила заказа нет.`};
    if (role === 'mentor') return {kind: 'info', title: 'Простыми словами', text: `${r.title}: к сезону ${r.season} нужно около ${f(r.need)} шт. Того, что есть и едет, хватит на ${c.pctS(r.readiness.transitOnly)} сезона${r.planQty ? `, с заказами плана — на ${c.pctS(r.readiness.planFill)}` : ''}.`};
    const late = r.skusStartBeforeArrival;
    return {kind: r.readiness.planFill < 0.5 ? 'risk' : r.orderByPassed ? 'remark' : 'confirm', title: `${r.title}: готовность ${c.pctS(r.readiness.planFill)}`, text: `Сезон ${r.season}: нужно ${f(r.need)} шт (прогноз по дням сезона). До заказа ${c.pctS(r.readiness.transitOnly)}, после плана при 100 % — ${c.pctS(r.readiness.plan100)}, × доля поставки — ${c.pctS(r.readiness.planFill)}; разрыв ${f(r.gap.planFill)} шт. ${r.orderByPassed ? 'Срок к сезону прошёл ' + c.dmy(r.orderBy) + '.' : 'Заказать к сезону до ' + c.dmy(r.orderBy) + '.'}${late ? ` У ${late} из ${r.skus} поз. заказ сегодня придёт после старта сезона.` : ''}`};
  }

  function scenario(id, info, c) {
    const R = c.R, f = c.fmt;
    if (id === 'recalc' && info.diff) return [{kind: info.diff.count ? 'info' : 'confirm', title: 'Пересчёт: что изменилось', text: `Изменений ${f(info.diff.count)}: статус ${info.diff.summary.status}, срок ${info.diff.summary.orderBy}, количество ${info.diff.summary.qty}. План «Сейчас» ${f(info.diff.summary.planCount[0])} → ${f(info.diff.summary.planCount[1])} поз., ${f(info.diff.summary.planQty[0])} → ${f(info.diff.summary.planQty[1])} шт. Самопроверка после прогона пройдена.`}];
    if (id === 'move' && info.ids) {
      const list = info.ids.map(i => c.SK[i]).filter(Boolean), alts = [...new Set(list.map(s => s.sup))];
      return alts.map(a => { const A = c.SP[a], rs = list.filter(s => s.sup === a); return {kind: A && A.overduePO ? 'remark' : 'confirm', title: `Перенос на ${c.supNameOf(a)}`, text: `${rs.length} поз. пересчитаны с плечом ${A ? A.leadMed : '—'} дн: ${rs.filter(c.inPlan).length} теперь в плане, ${f(rs.reduce((x, s) => x + c.qtyOf(s), 0))} шт.${A && A.overduePO ? ` У поставщика ${A.overduePO} просроченных PO из ${A.openPO} — подтвердить, что он отгружает.` : ''}${A && A.fillSource !== 'data' ? ' Закрытых PO у него мало: доля поставки — среднее по выгрузке.' : ''}`}; });
    }
    if (id === 'fill') { const r = R.seasonReadiness.find(x => x.cat === info.ctx.cat); return r ? [{kind: r.gap.planFill > 0 ? 'remark' : 'confirm', title: `${r.title}: что не закрываем`, text: `После плана × доля поставки разрыв ${f(r.gap.planFill)} шт.${r.skusStartBeforeArrival ? ` Начало сезона у ${r.skusStartBeforeArrival} поз. закрывает только остаток и в пути — новый заказ приходит позже старта.` : ''}`}] : [];}
    if (id === 'container') return [{kind: 'remark', title: 'Проверить объём', text: `${R.kpi.volumeNote}: контейнер может упереться в объём раньше, чем в вес.`}];
    if (id === 'price') return [{kind: 'remark', title: 'Эластичность — допущение', text: 'Спрос после повышения цены посчитан при допущении об эластичности, а не по данным: чеков в выгрузке нет.'}];
    if (id === 'liq') return [{kind: 'confirm', title: 'Сезонные не в избытке', text: `Избыток считается по прямой проекции на ${R.params.overMonths} мес с сезонным прогнозом: летний остаток обогревателей избытком не считается, если его съест сезон.`}];
    if (id === 'supply') return [{kind: 'remark', title: 'Два метода доли поставки', text: R.traps[6].text}];
    return [];
  }

  function question(role, q, c) {
    const R = c.R, n = c.norm(q), f = c.fmt;
    const s = R.skus.find(x => n.includes(c.norm(x.id))) || R.skus.find(x => { const m = c.norm(x.name.replace(/^.*\s([A-Z]{2}-\d{3})(,.*)?$/, '$1')); return m.length >= 4 && n.includes(m); });
    if (s) return {msg: sku(role, s, c), ref: {type: 'sku', id: s.id}, found: true};
    const S = R.suppliers.find(x => n.includes(c.norm(x.id)) || (x.name && n.includes(c.norm(x.name.split(' ')[0])) && c.norm(x.name.split(' ')[0]).length > 3));
    if (S) return {msg: supplier(role, S, c), ref: {type: 'supplier', id: S.id}, found: true};
    const rule = [
      [/просроч|почемутакмного|late/, () => ({kind: 'info', title: 'Почему так много «Просрочено»', text: R.traps[0].text + ` «Просрочено» ставится только при потерях до прихода не меньше ${c.fmtF(R.params.lateLossShare)} месячного спроса: ${f(R.kpi.late)} поз., ${c.pctS(R.kpi.lateShareOfPlan)} плана.`})],
      [/сколько|итог|всего|заказатьсейчас/, () => { const t = c.planTotals(); return {kind: 'info', title: 'Итог плана', text: `Заказать сейчас: ${f(t.count)} поз., ${f(t.qty)} шт, ${t.approx ? '≈' : ''}${c.fmtF(t.tons, 0)} т; ожидаемо придёт ${f(t.expected)} шт. Вне итогов — «Сменить поставщика» ${f(R.statusCounts.blocked)} поз.`}; }],
      [/fill|доляпоставки|недопостав|qtyreceived/, () => ({kind: 'info', title: 'Доля поставки', text: R.traps[6].text})],
      [/сезон|обогрев|триммер|оснаст/, () => ({kind: 'info', title: 'Готовность к сезону', text: R.seasonReadiness.map(r => `${r.title} (${r.season}): до заказа ${c.pctS(r.readiness.transitOnly)}, с планом × доля поставки ${c.pctS(r.readiness.planFill)}`).join('; ') + '.'})],
      [/деньг|бюджет|руб|цен[аы]закуп/, () => ({kind: 'info', title: 'Деньги', text: R.kpi.moneyNote + '. Для сортировки — индекс ценности, деньгами он не подписывается.'})],
      [/плеч|срокпостав|когдапридет|когдапридёт/, () => ({kind: 'info', title: 'Плечо поставки', text: R.traps[0].text})],
      [/мертв|мёртв|неходов/, () => ({kind: 'info', title: 'Мёртвый ассортимент', text: R.traps[4].text})],
      [/наценк|маржа/, () => ({kind: 'info', title: 'Наценка', text: R.traps[3].text})],
      [/упущ|цензур|нетостатка/, () => ({kind: 'info', title: 'Упущенный спрос', text: R.traps[5].text})],
      [/открыт|впути|po/, () => ({kind: 'info', title: 'Открытые заказы', text: R.traps[2].text})],
      [/контейнер|объем|объём|вес/, () => ({kind: 'info', title: 'Контейнеры', text: R.kpi.volumeNote + '. Тоннаж с «≈», если у части позиций вес подставлен медианой категории.'})]
    ].find(([re]) => re.test(n));
    if (rule) return {msg: rule[1](), ref: null, found: true};
    return {msg: {kind: 'question', title: 'Готового ответа нет', text: 'Вопрос записан в замечания открытым. В макете ответы заготовлены шаблонами по данным прогона; свободный разговор — фаза 2.'}, ref: null, found: false};
  }

  /* стартовые пункты — проверки критика прогона (B-20), затем сигналы */
  function preset(c) {
    const R = c.R, items = R.critic.slice(0, 3).map(x => ({kind: x.code === 'fill_sensitive' ? 'question' : 'remark', title: x.cat ? R.categories[x.cat].name + ': сезон против плана' : x.code === 'fill_sensitive' ? 'Статус зависит от метода доли поставки' : 'Проверка критика', text: x.text, ref: x.sku ? {type: 'sku', id: x.sku} : x.cat ? {type: 'category', id: x.cat} : null}));
    if (items.length < 3) R.signals.slice(0, 3 - items.length).forEach(x => items.push({kind: x.kind === 'risk' ? 'risk' : 'remark', title: 'Сигнал прогона', text: x.text, ref: x.ref}));
    return items;
  }

  function letter(supId, c) {
    const R = c.R, S = c.SP[supId], po = R.openPOs.filter(p => p.sup === supId && p.pending > 0);
    if (!S || !po.length) return '';
    const by = c.dmy(c.isoOf(c.todayD() + 7));
    return `Тема: подтверждение открытых заказов — ${S.name}\n\nЗдравствуйте!\n\nПросим подтвердить количество и дату отгрузки по открытым заказам:\n` +
      po.map(p => `— ${p.po}: ${c.nameOf(p.sku)} (${p.sku}), ${c.fmt(p.pending)} шт, обещан ${c.dmy(p.promised)}${p.state !== 'future' ? `, просрочен на ${p.daysLate} дн` : ''}${p.confirmed ? '' : ', подтверждения нет'}`).join('\n') +
      `\n\nОтветьте, пожалуйста, до ${by}: что отгружено, что в производстве, новая дата по каждому заказу.\n\nС уважением,\nотдел закупок`;
  }

  return {roles, kinds, greeting, sku, supplier, category, scenario, question, preset, letter};
})();
