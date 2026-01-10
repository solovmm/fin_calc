/* NDFL calculator (prototype)
   Notes:
   - This is a simplified calculator for quick estimates.
   - Rates can depend on year, income type and taxpayer status.
*/

(function(){
  const $ = (id)=>document.getElementById(id);

  // ===== Formatting / parsing =====
  function parseMoney(str){
    if (str == null) return 0;
    const s = String(str).replace(/\s+/g,'').replace(/₽/g,'').replace(/,/g,'.');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  function formatMoney(n){
    const v = Math.round(Number(n)||0);
    return new Intl.NumberFormat('ru-RU').format(v) + ' ₽';
  }

  function formatPct(v, d=1){
    return (Number(v)||0).toFixed(d) + '%';
  }

  function bindMoneyInput(el){
    const setPretty = ()=>{
      const val = parseMoney(el.value);
      el.value = new Intl.NumberFormat('ru-RU').format(Math.max(0, Math.round(val)));
    };

    el.addEventListener('focus', ()=>{
      const val = parseMoney(el.value);
      el.value = String(Math.max(0, Math.round(val)));
      el.select();
    });

    el.addEventListener('blur', ()=>{
      if (!el.value.trim()) el.value = '0';
      setPretty();
    });

    el.addEventListener('input', ()=>{
      el.value = el.value.replace(/[^0-9]/g,'');
    });

    // initial pretty
    if (!el.value.trim()) el.value = '0';
    setPretty();
  }

  // ===== Help bubbles =====
  function setupHelpBubbles(){
    const helps = Array.from(document.querySelectorAll('.help[data-help]'));
    let openTip = null;

    function close(){
      if (openTip){
        openTip.remove();
        openTip = null;
      }
      helps.forEach(h => h.classList.remove('on'));
    }

    helps.forEach(h => {
      h.addEventListener('click', (e)=>{
        e.preventDefault();
        e.stopPropagation();
        if (openTip){ close(); }

        const rect = h.getBoundingClientRect();
        const tip = document.createElement('div');
        tip.className = 'tooltip';
        tip.textContent = h.getAttribute('data-help') || '';
        document.body.appendChild(tip);

        // place
        const pad = 10;
        const left = Math.min(window.innerWidth - tip.offsetWidth - pad, Math.max(pad, rect.left));
        const top = rect.bottom + 10;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';

        openTip = tip;
        h.classList.add('on');
      });
    });

    document.addEventListener('click', close);
    window.addEventListener('scroll', close, {passive:true});
    window.addEventListener('resize', close);
  }

  // ===== Tax logic =====
  // Progressive brackets for residents (simplified, 2025+ style)
  const BR_RESIDENT_2025 = [
    { cap: 2_400_000, rate: 0.13 },
    { cap: 5_000_000, rate: 0.15 },
    { cap: 20_000_000, rate: 0.18 },
    { cap: 50_000_000, rate: 0.20 },
    { cap: Infinity, rate: 0.22 },
  ];

  // For some income types (simplified)
  const BR_DIVIDENDS = [
    { cap: 5_000_000, rate: 0.13 },
    { cap: Infinity, rate: 0.15 },
  ];

  function calcByBrackets(base, brackets){
    let remaining = Math.max(0, base);
    let prevCap = 0;
    let tax = 0;
    const lines = [];

    for (const b of brackets){
      const cap = b.cap;
      const chunk = Math.max(0, Math.min(remaining, cap - prevCap));
      if (chunk <= 0){
        prevCap = cap;
        continue;
      }
      const t = chunk * b.rate;
      tax += t;
      remaining -= chunk;
      lines.push({
        base: chunk,
        rate: b.rate,
        tax: t,
        range: `${new Intl.NumberFormat('ru-RU').format(prevCap)}–${cap===Infinity? '∞' : new Intl.NumberFormat('ru-RU').format(cap)}`
      });
      prevCap = cap;
      if (remaining <= 0) break;
    }
    return { tax, lines };
  }

  function ctxFromUI(){
    const incomeType = $('incomeType').value;
    const status = $('taxStatus').value;
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'gross';

    const hasNorth = $('hasNorth').checked;
    const rkCoef = Number(String($('rkCoef').value).replace(',', '.')) || 1;
    const northPct = Number(String($('northPct').value).replace(',', '.')) || 0;

    const manualRate = Number(String($('manualRate').value).replace(',', '.'));

    return { incomeType, status, mode, hasNorth, rkCoef, northPct, manualRate };
  }

  function effectiveGross(gross, ctx){
    if (!ctx.hasNorth) return gross;
    // Simplified model: wage increases by RK and then by northern allowance
    const rk = Math.max(0, ctx.rkCoef || 1);
    const north = 1 + (Math.max(0, ctx.northPct || 0) / 100);
    return gross * rk * north;
  }

  function computeTaxFromGross(gross, deduction, ctx){
    let type = ctx.incomeType;

    // Manual rate overrides everything
    if (type === 'manual'){
      const r = (Number.isFinite(ctx.manualRate) ? ctx.manualRate : 13) / 100;
      const base = Math.max(0, gross - deduction);
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: `своя ставка ${formatPct(r*100,1)}`
      };
    }

    // Non-resident flat rate (prototype)
    if (ctx.status === 'nonresident'){
      const r = (type === 'dividends') ? 0.15 : 0.30;
      const base = Math.max(0, gross - deduction);
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: (type === 'dividends') ? 'нерезидент 15% (дивиденды)' : 'нерезидент 30%'
      };
    }

    // Non-resident but resident rates
    // Resident
    if (type === 'prize'){
      // Common case: 35% for some prizes (simplified)
      const r = 0.35;
      const base = Math.max(0, gross - deduction);
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: '35% (упрощённо)'
      };
    }

    const base = Math.max(0, gross - deduction);

    if (type === 'dividends' || type === 'deposits'){
      const res = calcByBrackets(base, BR_DIVIDENDS);
      return { tax: res.tax, lines: res.lines, scheme: '13%/15% (упрощённо)' };
    }

    // salary / other
    const res = calcByBrackets(base, BR_RESIDENT_2025);
    return { tax: res.tax, lines: res.lines, scheme: 'прогрессивная шкала (упрощённо)' };
  }

  function netFromGross(gross, deduction, ctx){
    const gEff = effectiveGross(gross, ctx);
    const { tax } = computeTaxFromGross(gEff, deduction, ctx);
    // Tax is withheld from effective gross; net we show from effective gross
    return gEff - tax;
  }

  function grossFromTargetNet(targetNet, deduction, ctx){
    // Binary search on "base gross" before RK/North (if any)
    let low = 0;
    let high = Math.max(1, targetNet * 5 + 10_000);

    // Ensure high is enough
    for (let i=0;i<30;i++){
      if (netFromGross(high, deduction, ctx) >= targetNet) break;
      high *= 2;
    }

    for (let i=0;i<70;i++){
      const mid = (low + high) / 2;
      const n = netFromGross(mid, deduction, ctx);
      if (n >= targetNet) high = mid; else low = mid;
    }
    return high;
  }

  // ===== UI wiring =====
  function setStatus(msg, kind){
    const el = $('status');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function updateManualVisibility(){
    const type = $('incomeType').value;
    $('manualRateWrap').style.display = (type === 'manual') ? '' : 'none';
  }

  function updateNorthVisibility(){
    $('northFields').style.display = $('hasNorth').checked ? '' : 'none';
  }

  function calc(){
    const ctx = ctxFromUI();

    const incomeRaw = parseMoney($('income').value);
    const deduction = parseMoney($('deduction').value);

    if (incomeRaw < 0 || deduction < 0){
      setStatus('Суммы не могут быть отрицательными.', 'bad');
      return;
    }

    // Hint about deduction
    $('dedHint').textContent = (deduction>0)
      ? `База уменьшится на ${formatMoney(deduction)}.`
      : '';

    let baseGross; // the value the user typed (gross or target net)
    let gross;     // gross before tax, in "effective" terms

    if (ctx.mode === 'gross'){
      baseGross = incomeRaw;
      gross = incomeRaw;
    } else {
      // user entered target net
      const targetNet = incomeRaw;
      gross = grossFromTargetNet(targetNet, deduction, ctx);
      baseGross = targetNet;
    }

    const grossEff = effectiveGross(gross, ctx);
    const taxRes = computeTaxFromGross(grossEff, deduction, ctx);
    const tax = taxRes.tax;
    const net = Math.max(0, grossEff - tax);

    const avgRate = grossEff > 0 ? (tax / grossEff) * 100 : 0;

    // Output
    $('grossValue').textContent = formatMoney(grossEff);
    $('taxValue').textContent = formatMoney(tax);
    $('netValue').textContent = formatMoney(net);
    $('avgRateValue').textContent = formatPct(avgRate, 1);

    const modeText = (ctx.mode === 'gross')
      ? `При доходе ${formatMoney(baseGross)} до налога`
      : `Чтобы получить ${formatMoney(baseGross)} на руки`;

    const statusText = (ctx.status === 'resident')
      ? 'резидент'
      : (ctx.status === 'nonresident')
        ? 'нерезидент'
        : 'нерезидент (как резидент)';

    const northText = ctx.hasNorth
      ? `, с учётом РК ${ctx.rkCoef} и надбавки ${ctx.northPct}% (упрощённо)`
      : '';

    $('summary').textContent = `${modeText}, статус: ${statusText}${northText}. Схема: ${taxRes.scheme}.`;

    // Details
    const parts = [];
    parts.push(`<div><b>Налогооблагаемая база</b>: ${formatMoney(Math.max(0, grossEff - deduction))}</div>`);
    if (deduction>0){
      parts.push(`<div><b>Вычет</b>: ${formatMoney(deduction)}</div>`);
    }
    if (ctx.hasNorth){
      parts.push(`<div><b>РК</b>: ${ctx.rkCoef}; <b>северная надбавка</b>: ${ctx.northPct}% (упрощённый пересчёт).</div>`);
    }
    parts.push(`<div style="margin-top:8px"><b>Расклад по ставкам</b>:</div>`);

    const rows = taxRes.lines.map(l => {
      const ratePct = (l.rate*100);
      return `<div class="line"><span>${l.range}</span><span>${formatMoney(l.base)} × ${formatPct(ratePct,1)} = <b>${formatMoney(l.tax)}</b></span></div>`;
    }).join('');

    parts.push(`<div class="lines">${rows || '—'}</div>`);
    parts.push(`<div style="margin-top:8px"><b>Итого налог</b>: ${formatMoney(tax)}</div>`);

    $('detailsBox').innerHTML = parts.join('');

    setStatus('Готово.', 'ok');
  }

  async function copyResult(){
    const net = $('netValue').textContent;
    const tax = $('taxValue').textContent;
    const gross = $('grossValue').textContent;
    const avg = $('avgRateValue').textContent;
    const summary = $('summary').textContent;

    const txt = `Калькулятор НДФЛ\n${summary}\n\nСумма до налога: ${gross}\nНДФЛ: ${tax}\nНа руки: ${net}\nУсреднённая ставка: ${avg}`;

    try{
      await navigator.clipboard.writeText(txt);
      setStatus('Скопировано в буфер обмена.', 'ok');
    } catch{
      setStatus('Не удалось скопировать. Выделите текст и скопируйте вручную.', 'bad');
    }
  }

  function setupModal(){
    const modal = $('helpModal');
    $('helpOpen').addEventListener('click', ()=>{ modal.style.display = ''; });
    $('helpClose').addEventListener('click', ()=>{ modal.style.display = 'none'; });
    modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.style.display = 'none'; });
  }

  // Init
  bindMoneyInput($('income'));
  bindMoneyInput($('deduction'));

  $('incomeType').addEventListener('change', ()=>{
    updateManualVisibility();
    setStatus('Параметры изменены. Нажмите «Рассчитать».');
  });
  $('taxStatus').addEventListener('change', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».'));
  document.querySelectorAll('input[name="mode"]').forEach(r=>r.addEventListener('change', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».')));

  $('hasNorth').addEventListener('change', ()=>{
    updateNorthVisibility();
    setStatus('Параметры изменены. Нажмите «Рассчитать».');
  });

  $('rkCoef').addEventListener('input', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».'));
  $('northPct').addEventListener('input', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».'));
  $('manualRate').addEventListener('input', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».'));

  $('calcBtn').addEventListener('click', calc);
  $('copyBtn').addEventListener('click', copyResult);

  updateManualVisibility();
  updateNorthVisibility();
  setupHelpBubbles();
  setupModal();
})();
