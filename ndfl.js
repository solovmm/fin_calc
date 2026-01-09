// Калькулятор НДФЛ (прототип, без автопересчёта)
// Логика ориентирована на публичные правила/описание на calcus.ru (прогрессивные ставки для ряда доходов).
// Важно: результат носит справочный характер.

function el(id){ return document.getElementById(id); }

function fmtMoney(n){
  if (!isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(n)) + ' ₽';
}
function fmtPercent(n, digits=2){
  if (!isFinite(n)) return '—';
  return (Math.round(n * Math.pow(10,digits)) / Math.pow(10,digits)).toFixed(digits).replace(/\.?0+$/,'') + '%';
}
function parseIntLike(s){
  const raw = String(s ?? '').replace(/\s+/g,'').replace(/[^\d]/g,'');
  return raw ? parseInt(raw,10) : 0;
}
function parseFloatLike(s){
  const raw = String(s ?? '').replace(',', '.').replace(/[^\d.]/g,'');
  const v = raw ? parseFloat(raw) : 0;
  return isFinite(v) ? v : 0;
}

let isDirty = false;

function markDirty(msg='Изменено. Нажмите «Рассчитать».'){
  isDirty = true;
  el('status').textContent = msg;
}

function hideAllPopovers(){
  document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
}

function bindPopovers(){
  document.querySelectorAll('.help').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-help');
      const pop = el(id);
      const isOpen = pop.style.display === 'block';
      hideAllPopovers();
      pop.style.display = isOpen ? 'none' : 'block';
    });
  });
  document.addEventListener('click', hideAllPopovers);
}

function bindMoneyInput(id){
  const input = el(id);
  input.addEventListener('input', () => {
    const prev = input.value || '';
    const caret = (input.selectionStart ?? prev.length);

    const digitsLeft = prev.slice(0, caret).replace(/\D/g,'').length;

    let raw = prev.replace(/\D/g,'');
    raw = raw.replace(/^0+(?=\d)/,'');
    if (!raw){
      input.value = '';
      markDirty(' ');
      return;
    }

    const formatted = raw.replace(/\B(?=(\d{3})+(?!\d))/g,' ');
    input.value = formatted;

    let pos=0, count=0;
    while (pos < input.value.length && count < digitsLeft){
      if (/\d/.test(input.value[pos])) count++;
      pos++;
    }
    try{ input.setSelectionRange(pos,pos); }catch(_){}
    markDirty();
  });

  input.addEventListener('blur', () => {
    if (!input.value) input.value = '0';
  });
}

function applyBrackets(amount, brackets){
  let tax = 0;
  let remaining = amount;
  let prevLimit = 0;
  const parts = [];
  for (const b of brackets){
    const lim = b.limit;
    const taxable = Math.max(0, Math.min(remaining, lim - prevLimit));
    if (taxable > 0){
      const t = taxable * b.rate;
      tax += t;
      parts.push({from: prevLimit, to: isFinite(lim)?lim:null, taxable, rate: b.rate, tax: t});
      remaining -= taxable;
    }
    prevLimit = lim;
    if (remaining <= 0) break;
  }
  return { tax, parts };
}

const BR_SALARY = [
  {limit: 2_400_000, rate: 0.13},
  {limit: 5_000_000, rate: 0.15},
  {limit: 20_000_000, rate: 0.18},
  {limit: 50_000_000, rate: 0.20},
  {limit: Infinity, rate: 0.22},
];

const BR_13_15 = [
  {limit: 5_000_000, rate: 0.13},
  {limit: Infinity, rate: 0.15},
];

function computeTax(gross, ctx){
  const incomeType = ctx.incomeType;
  const deduction = Math.max(0, ctx.deduction || 0);

  const isNonResident = ctx.isNonResident;
  const nonResidentAsResident = ctx.nonResidentAsResident;

  const hasNorth = ctx.hasNorth;
  const rkCoef = ctx.rkCoef;
  const northPct = ctx.northPct;

  // manual rate (flat)
  if (incomeType === 'manual'){
    const r = Math.max(0, ctx.manualRate)/100;
    const base = Math.max(0, gross - deduction);
    const tax = base * r;
    return { tax, parts:[{label:'Единая ставка', taxable:base, rate:r, tax}] };
  }

  // Non-resident (flat) unless treated as resident
  if (isNonResident && !nonResidentAsResident){
    // dividends & deposits: 15%
    let r = 0.30;
    if (incomeType === 'dividends' || incomeType === 'deposits') r = 0.15;
    // prizes: оставляем 35% как спецставку
    if (incomeType === 'prize' || incomeType === 'prize_ad') r = 0.35;
    const base = Math.max(0, gross - deduction);
    const tax = base * r;
    return { tax, parts:[{label:'Нерезидент (единая ставка)', taxable:base, rate:r, tax}] };
  }

  // Resident schedules
  if (incomeType === 'prize' || incomeType === 'prize_ad'){
    const r = 0.35;
    const base = Math.max(0, gross - deduction);
    const tax = base * r;
    return { tax, parts:[{label:'Приз/выигрыш', taxable:base, rate:r, tax}] };
  }

  if (incomeType === 'salary'){
    // optional RK/north split
    const baseSalary = gross;
    const extra = (hasNorth ? (baseSalary * Math.max(0, rkCoef - 1) + baseSalary * Math.max(0, northPct)/100) : 0);
    const total = baseSalary + extra;

    // allocate deduction: first to base, then to extra
    let d = deduction;
    const baseTaxable = Math.max(0, baseSalary - d);
    d = Math.max(0, d - baseSalary);
    const extraTaxable = Math.max(0, extra - d);

    const resBase = applyBrackets(baseTaxable, BR_SALARY);
    const parts = resBase.parts.map(p => ({...p, label:'Зарплата'}));

    let tax = resBase.tax;

    if (extraTaxable > 0){
      const resExtra = applyBrackets(extraTaxable, BR_13_15);
      tax += resExtra.tax;
      resExtra.parts.forEach(p => parts.push({...p, label:'РК/северные'}));
    }

    return { tax, parts };
  }

  if (incomeType === 'svo'){
    const base = Math.max(0, gross - deduction);
    const res = applyBrackets(base, BR_13_15);
    return { tax: res.tax, parts: res.parts.map(p => ({...p, label:'СВО'})) };
  }

  // other types: 13/15 scale
  const base = Math.max(0, gross - deduction);
  const res = applyBrackets(base, BR_13_15);
  const labelMap = {
    property_sale:'Продажа имущества',
    rent:'Аренда',
    securities:'Ценные бумаги',
    dividends:'Дивиденды',
    deposits:'Проценты по вкладам'
  };
  return { tax: res.tax, parts: res.parts.map(p => ({...p, label: labelMap[incomeType] || 'Доход'})) };
}

function netFromGross(gross, ctx){
  const { tax } = computeTax(gross, ctx);
  return gross - tax;
}

function invertGrossFromNet(targetNet, ctx){
  // expand upper bound until netFromGross(high) >= targetNet
  let low = Math.max(0, targetNet);
  let high = Math.max(1, targetNet);

  // Heuristic: start from 1/(1-minRate) if resident salary etc; but keep simple.
  for (let i=0;i<40;i++){
    const n = netFromGross(high, ctx);
    if (n >= targetNet) break;
    high *= 2;
  }
  if (high > 1e12) high = 1e12;

  for (let i=0;i<80;i++){
    const mid = (low + high) / 2;
    const n = netFromGross(mid, ctx);
    if (n >= targetNet) high = mid;
    else low = mid;
  }
  return high;
}

function buildCtx(){
  const incomeType = el('incomeType').value;
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'gross';
  const income = parseIntLike(el('income').value);
  const deduction = parseIntLike(el('deduction').value);
  const isNonResident = el('isNonResident').checked;
  const nonResidentAsResident = el('nonResidentAsResident').checked;
  const hasNorth = el('hasNorth').checked;

  const rkCoef = Math.max(1, parseFloatLike(el('rkCoef').value || '1'));
  const northPct = Math.max(0, parseFloatLike(el('northPct').value || '0'));

  const manualRate = Math.max(0, parseFloatLike(el('manualRate').value || '0'));

  return { incomeType, mode, income, deduction, isNonResident, nonResidentAsResident, hasNorth, rkCoef, northPct, manualRate };
}

function updateUIVisibility(){
  const t = el('incomeType').value;
  const isNR = el('isNonResident').checked;

  // manual rate
  el('manualRateWrap').style.display = (t === 'manual') ? 'block' : 'none';

  // RK/north only for salary
  const northWrap = el('northWrap');
  if (t !== 'salary'){
    el('hasNorth').checked = false;
    el('northFields').style.display = 'none';
    northWrap.style.opacity = '0.55';
    northWrap.style.pointerEvents = 'none';
  } else {
    northWrap.style.opacity = '1';
    northWrap.style.pointerEvents = 'auto';
  }

  // special nonresident checkbox enable
  el('nonResidentAsResident').disabled = !isNR;

  // deduction hint
  const hint = el('dedHint');
  const hints = {
    prize: 'Подсказка: для призов часто применяется вычет 4 000 ₽.',
    prize_ad: 'Подсказка: для призов часто применяется вычет 4 000 ₽.',
    property_sale: 'Подсказка: при продаже жилья возможен вычет 1 000 000 ₽ или в размере расходов.',
    deposits: 'Подсказка: для процентов по вкладам может быть необлагаемый лимит (в некоторых годах).',
  };
  hint.textContent = hints[t] || '';
}

function renderDetails(parts){
  if (!parts || parts.length === 0){
    el('detailsBox').textContent = '—';
    return;
  }
  const rows = parts.map(p => {
    const range = (p.from === 0 && p.to === null) ? 'вся база' :
      (p.to === null ? `свыше ${fmtMoney(p.from).replace(' ₽','')}` : `${fmtMoney(p.from).replace(' ₽','')} – ${fmtMoney(p.to).replace(' ₽','')}`);
    return `• ${p.label}: ${range}, ставка ${(p.rate*100).toFixed(0)}%, база ${fmtMoney(p.taxable)}, налог ${fmtMoney(p.tax)}`;
  });
  el('detailsBox').textContent = rows.join('\n');
}

function calculate(){
  const ctx = buildCtx();

  const incomeType = ctx.incomeType;
  const mode = ctx.mode;

  const inputVal = ctx.income;

  if (!isFinite(inputVal) || inputVal < 0){
    el('status').textContent = 'Проверьте сумму дохода.';
    return;
  }

  let gross = inputVal;
  if (mode === 'net'){
    gross = invertGrossFromNet(inputVal, ctx);
  }

  const res = computeTax(gross, ctx);
  const tax = res.tax;
  const net = gross - tax;
  const avgRate = gross > 0 ? (tax / gross) * 100 : 0;

  el('grossValue').textContent = fmtMoney(gross);
  el('taxValue').textContent = fmtMoney(tax);
  el('netValue').textContent = fmtMoney(net);
  el('avgRateValue').textContent = fmtPercent(avgRate, 2);

  const typeName = el('incomeType').selectedOptions[0]?.textContent || 'Доход';
  el('summary').textContent = `${typeName}. Вычет: ${fmtMoney(ctx.deduction)}.`;

  renderDetails(res.parts);

  isDirty = false;
  el('status').textContent = 'Готово. При изменениях нажмите «Рассчитать».';
}

function copyResult(){
  const txt = [
    'Калькулятор НДФЛ',
    el('summary').textContent,
    `Сумма до налога: ${el('grossValue').textContent}`,
    `НДФЛ: ${el('taxValue').textContent}`,
    `На руки: ${el('netValue').textContent}`,
    `Усреднённая ставка: ${el('avgRateValue').textContent}`,
  ].join('\n');
  navigator.clipboard?.writeText(txt).then(()=>{
    el('status').textContent = 'Результат скопирован.';
  }).catch(()=>{
    el('status').textContent = 'Не удалось скопировать. Скопируйте вручную.';
  });
}

function bindUI(){
  bindPopovers();
  bindMoneyInput('income');
  bindMoneyInput('deduction');

  // mode radio
  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', ()=> markDirty()));

  // basic field listeners
  el('incomeType').addEventListener('change', ()=>{ updateUIVisibility(); markDirty(); });
  el('isNonResident').addEventListener('change', ()=>{ updateUIVisibility(); markDirty(); });
  el('nonResidentAsResident').addEventListener('change', ()=> markDirty());

  // manual rate and north fields
  ['manualRate','rkCoef','northPct'].forEach(id => {
    el(id).addEventListener('input', ()=> markDirty());
    el(id).addEventListener('blur', ()=> {
      if (!el(id).value) el(id).value = (id==='rkCoef' ? '1.0' : '0');
    });
  });

  el('hasNorth').addEventListener('change', ()=>{
    el('northFields').style.display = el('hasNorth').checked ? 'grid' : 'none';
    markDirty();
  });

  // calculate
  el('calcBtn').addEventListener('click', calculate);

  // copy
  el('copyBtn').addEventListener('click', copyResult);

  // help modal
  el('helpOpen').addEventListener('click', ()=> el('helpModal').style.display = 'flex');
  el('helpClose').addEventListener('click', ()=> el('helpModal').style.display = 'none');
  el('helpModal').addEventListener('click', (e)=>{ if(e.target===el('helpModal')) el('helpModal').style.display='none'; });

  updateUIVisibility();
}

document.addEventListener('DOMContentLoaded', bindUI);
