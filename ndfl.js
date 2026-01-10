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
    const fmt = new Intl.NumberFormat('ru-RU');

    const getDigits = (s)=> String(s || '').replace(/[^\d]/g,'');
    const countDigits = (s)=> (String(s||'').match(/\d/g) || []).length;

    const setWithCaret = (rawBefore, caretPosBefore)=>{
      const digitsBefore = countDigits(rawBefore.slice(0, caretPosBefore));
      let digits = getDigits(rawBefore);
      if (!digits) digits = '0';

      // avoid leading zeros like 00012 -> 12 (but keep single 0)
      digits = digits.replace(/^0+(?=\d)/,'');
      const n = Number(digits);
      const pretty = fmt.format(Number.isFinite(n) ? n : 0);

      el.value = pretty;

      // map caret to same digit count
      let pos = 0;
      let seen = 0;
      while (pos < pretty.length){
        if (/\d/.test(pretty[pos])) seen++;
        if (seen >= digitsBefore) break;
        pos++;
      }
      // if caret was at end, keep at end
      if (digitsBefore >= countDigits(pretty)) pos = pretty.length;
      el.setSelectionRange(pos, pos);
    };

    el.addEventListener('input', ()=>{
      const raw = el.value;
      const caret = el.selectionStart ?? raw.length;
      setWithCaret(raw, caret);
      $('status').textContent = 'Параметры изменены. Нажмите «Рассчитать».';
      $('status').className = 'status';
    });

    el.addEventListener('focus', ()=>{
      // keep pretty, just place caret at end if value is 0
      if (parseMoney(el.value) === 0){
        const s = el.value;
        el.setSelectionRange(s.length, s.length);
      }
    });

    el.addEventListener('blur', ()=>{
      if (!String(el.value||'').trim()) el.value = '0';
      // normalize
      const n = Math.max(0, Math.round(parseMoney(el.value)));
      el.value = fmt.format(n);
    });

    // initial
    if (!String(el.value||'').trim()) el.value = '0';
    const n = Math.max(0, Math.round(parseMoney(el.value)));
    el.value = fmt.format(n);
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

        // place (prefer right of the icon)
        const pad = 10;
        const gap = 12;

        // first measure
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;

        let left = rect.right + gap;
        let top = rect.top - 6;

        // if overflow right, place left side
        if (left + tw > window.innerWidth - pad){
          left = rect.left - tw - gap;
        }
        // clamp
        left = Math.min(window.innerWidth - tw - pad, Math.max(pad, left));
        top = Math.min(window.innerHeight - th - pad, Math.max(pad, top));

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
  // Progressive brackets for residents
  const BR_RESIDENT_2024 = [
    { cap: 5_000_000, rate: 0.13 },
    { cap: Infinity, rate: 0.15 },
  ];

  // 2025+ style (progressive)
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

    function getResidentBrackets(year){
    const y = Number(year) || 2024;
    return y >= 2025 ? BR_RESIDENT_2025 : BR_RESIDENT_2024;
  }

  function depositNonTaxLimit(maxKeyRate){
    const r = (Number(maxKeyRate) || 0) / 100;
    return 1_000_000 * r;
  }

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
    const taxYear = $('taxYear') ? Number($('taxYear').value) : 2024;

    const hasNorth = $('hasNorth').checked;
    const rkCoef = Number(String($('rkCoef').value).replace(',', '.')) || 1;
    const northPct = Number(String($('northPct').value).replace(',', '.')) || 0;

    const manualRate = Number(String($('manualRate').value).replace(',', '.'));
    const maxKeyRate = Number(String(($('maxKeyRate')?.value ?? '0')).replace(',', '.')) || 0;

    return { incomeType, status, mode, taxYear, hasNorth, rkCoef, northPct, manualRate, maxKeyRate };
  }

  function effectiveGross(gross, ctx){
    if (!ctx.hasNorth) return gross;
    // Simplified model: wage increases by RK and then by northern allowance
    const rk = Math.max(0, ctx.rkCoef || 1);
    const north = 1 + (Math.max(0, ctx.northPct || 0) / 100);
    return gross * rk * north;
  }

    function computeTaxFromGross(gross, deduction, ctx){
    const type = ctx.incomeType;
    const year = Number(ctx.taxYear) || 2024;

    // Deposits: only part above the non-taxable limit is taxed
    const depLimit = (type === 'deposits') ? depositNonTaxLimit(ctx.maxKeyRate) : 0;

    const base = (type === 'deposits')
      ? Math.max(0, gross - depLimit)
      : Math.max(0, gross - deduction);

    // Manual rate overrides everything
    if (type === 'manual'){
      const r = (Number.isFinite(ctx.manualRate) ? ctx.manualRate : 13) / 100;
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: `своя ставка ${formatPct(r*100,1)}`,
        meta: { base, depLimit }
      };
    }

    // Non-resident flat rate (prototype)
    if (ctx.status === 'nonresident'){
      const r = (type === 'dividends') ? 0.15 : 0.30;
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: (type === 'dividends') ? 'нерезидент 15% (дивиденды)' : 'нерезидент 30%',
        meta: { base, depLimit }
      };
    }

    // Some exceptions: treat like resident rates
    const treatAsResident = (ctx.status === 'resident') || (ctx.status === 'nonresident_resident_rate');

    // Prize / winning (prototype)
    if (type === 'prize'){
      const r = 0.35;
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: '35%',
        meta: { base, depLimit }
      };
    }

    if (!treatAsResident){
      // fallback
      const r = 0.30;
      return {
        tax: base * r,
        lines: [{ base, rate: r, tax: base * r, range: 'вся база' }],
        scheme: '30%',
        meta: { base, depLimit }
      };
    }

    // Dividends (13/15)
    if (type === 'dividends'){
      const res = calcByBrackets(base, BR_DIVIDENDS);
      return { tax: res.tax, lines: res.lines, scheme: '13%/15% (дивиденды)', meta: { base, depLimit } };
    }

    // Salary / other / deposits
    const brackets = getResidentBrackets(year);
    const res = calcByBrackets(base, brackets);
    const scheme = (year >= 2025) ? 'прогрессивная шкала' : '13%/15%';
    return { tax: res.tax, lines: res.lines, scheme, meta: { base, depLimit } };
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

    // own rate input
    $('manualRateWrap').style.display = (type === 'manual') ? '' : 'none';

    // deposits: show max key rate, hide deductions and northern options
    const isDeposit = (type === 'deposits');
    if ($('depositRateWrap')) $('depositRateWrap').style.display = isDeposit ? '' : 'none';

    const deductionField = $('deduction')?.closest('.field');
    if (deductionField) deductionField.style.display = isDeposit ? 'none' : '';

    const northToggleRow = $('hasNorth')?.closest('.row');
    if (northToggleRow) northToggleRow.style.display = isDeposit ? 'none' : '';

    if (isDeposit){
      $('northFields').style.display = 'none';
      $('hasNorth').checked = false;
    } else {
      updateNorthVisibility();
    }

    updateDepositNote();
  }

  function updateDepositNote(){
    const type = $('incomeType').value;
    const note = $('depLimitNote');
    if (!note) return;

    if (type !== 'deposits'){
      note.textContent = '';
      return;
    }

    const limit = depositNonTaxLimit(Number(String(($('maxKeyRate')?.value ?? '0')).replace(',', '.')) || 0);
    note.textContent = `Не облагается: ${formatMoney(limit)} (1 000 000 ₽ × ставка).`;
  }

  function updateNorthVisibility(){
    $('northFields').style.display = $('hasNorth').checked ? '' : 'none';
  }

    function calc(){
    const ctx = ctxFromUI();

    const incomeRaw = parseMoney($('income').value);
    let deduction = parseMoney($('deduction').value);

    if (incomeRaw < 0 || deduction < 0){
      setStatus('Суммы не могут быть отрицательными.', 'bad');
      return;
    }

    const isDeposit = (ctx.incomeType === 'deposits');
    if (isDeposit) deduction = 0;

    // Hint about deduction
    if (!isDeposit){
      $('dedHint').textContent = (deduction>0)
        ? `База уменьшится на ${formatMoney(deduction)}.`
        : '';
    } else {
      $('dedHint').textContent = '';
    }

    let typedValue; // what user typed in the sum field
    let gross;      // gross before tax

    if (ctx.mode === 'gross'){
      typedValue = incomeRaw;
      gross = incomeRaw;
    } else {
      // user entered target net (after tax)
      const targetNet = incomeRaw;
      gross = grossFromTargetNet(targetNet, deduction, ctx);
      typedValue = targetNet;
    }

    const grossEff = effectiveGross(gross, ctx);
    const taxRes = computeTaxFromGross(grossEff, deduction, ctx);
    const tax = taxRes.tax;
    const net = Math.max(0, grossEff - tax);

    const effRate = grossEff > 0 ? (tax / grossEff) * 100 : 0;

    // Output
    $('grossValue').textContent = formatMoney(grossEff);
    $('taxValue').textContent = formatMoney(tax);
    $('netValue').textContent = formatMoney(net);
    $('avgRateValue').textContent = formatPct(effRate, 1);

    const modeText = (ctx.mode === 'gross')
      ? `При сумме ${formatMoney(typedValue)} до налога`
      : `Чтобы получить ${formatMoney(typedValue)} на руки`;

    const statusText = (ctx.status === 'resident')
      ? 'резидент'
      : (ctx.status === 'nonresident')
        ? 'нерезидент'
        : 'нерезидент (как резидент)';

    const yearText = `год: ${ctx.taxYear}`;

    const northText = ctx.hasNorth
      ? `, с учётом районного коэффициента ${ctx.rkCoef} и северной надбавки ${ctx.northPct}%`
      : '';

    $('summary').textContent = `${modeText}, статус: ${statusText}${northText}, ${yearText}. Схема: ${taxRes.scheme}.`;

    // Details
    const parts = [];

    // Deposits-specific info
    if (isDeposit){
      const limit = taxRes.meta?.depLimit ?? 0;
      const taxable = taxRes.meta?.base ?? Math.max(0, grossEff);
      parts.push(`<div><b>Процентный доход</b>: ${formatMoney(grossEff)} (за год)</div>`);
      parts.push(`<div><b>Не облагается</b>: ${formatMoney(limit)} (1 000 000 ₽ × ставка)</div>`);
      parts.push(`<div><b>Налогооблагаемая часть</b>: ${formatMoney(taxable)}</div>`);
    } else {
      parts.push(`<div><b>Налогооблагаемая база</b>: ${formatMoney(Math.max(0, grossEff - deduction))}</div>`);
      if (deduction>0){
        parts.push(`<div><b>Вычеты</b>: ${formatMoney(deduction)}</div>`);
      }
    }

    if (ctx.hasNorth){
      parts.push(`<div><b>Районный коэффициент</b>: ${ctx.rkCoef}; <b>северная надбавка</b>: ${ctx.northPct}%.</div>`);
    }

    parts.push(`<div style="margin-top:10px"><b>Разбивка по ставкам</b>:</div>`);

    const totalBase = (taxRes.lines || []).reduce((s,l)=>s+(l.base||0), 0) || 0;

    const rows = (taxRes.lines || []).map(l => {
      const ratePct = (l.rate*100);
      const w = totalBase>0 ? Math.max(2, Math.round((l.base/totalBase)*100)) : 0;
      return `
        <tr>
          <td class="cRange">${escapeHtml(l.range)}</td>
          <td class="cBase">${formatMoney(l.base)}</td>
          <td class="cRate">${formatPct(ratePct,1)}</td>
          <td class="cTax"><b>${formatMoney(l.tax)}</b></td>
          <td class="cBar"><div class="barWrap"><div class="bar" style="width:${w}%"></div></div></td>
        </tr>
      `;
    }).join('');

    const table = `
      <table class="brTable">
        <thead>
          <tr><th>Диапазон</th><th>База</th><th>Ставка</th><th>Налог</th><th></th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody>
      </table>
    `;

    parts.push(table);
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

    const txt = `Калькулятор НДФЛ\n${summary}\n\nСумма до налога: ${gross}\nНДФЛ: ${tax}\nНа руки: ${net}\nЭффективная ставка: ${avg}`;

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

  $('taxYear')?.addEventListener('change', ()=>setStatus('Параметры изменены. Нажмите «Рассчитать».'));

  $('maxKeyRate')?.addEventListener('input', ()=>{
    updateDepositNote();
    setStatus('Параметры изменены. Нажмите «Рассчитать».');
  });
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
