
import {
  fmtMoney, fmtNumber, fmtPercent,
  attachMoneyFormatter, getMoneyValue, setMoneyValue,
  setupSegmented, bindTooltips, copyText, drawStackBar
} from "./common.js";

const els = {
  incomeType: document.getElementById("incomeType"),
  taxYear: document.getElementById("taxYear"),
  amount: document.getElementById("amount"),
  deduction: document.getElementById("deduction"),
  status: document.getElementById("status"),
  amountMode: document.getElementById("amountMode"),
  calcBtn: document.getElementById("calcBtn"),
  dirtyText: document.getElementById("dirtyText"),
  calcNotice: document.getElementById("calcNotice"),
  statusBadge: document.getElementById("statusBadge"),
  resMain: document.getElementById("resMain"),
  resExplain: document.getElementById("resExplain"),
  resultSubtitle: document.getElementById("resultSubtitle"),
  kTax: document.getElementById("kTax"),
  kGross: document.getElementById("kGross"),
  kEff: document.getElementById("kEff"),
  breakdownBody: document.getElementById("breakdownBody"),
  baseLine: document.getElementById("baseLine"),
  taxTotalLine: document.getElementById("taxTotalLine"),
  bar: document.getElementById("bar"),
  copyBtn: document.getElementById("copyBtn"),
  useRegional: document.getElementById("useRegional"),
  regionalFields: document.getElementById("regionalFields"),
  rkPct: document.getElementById("rkPct"),
  northPct: document.getElementById("northPct"),
  depositLimitBlock: document.getElementById("depositLimitBlock"),
  maxKeyRate: document.getElementById("maxKeyRate"),
  limitBase: document.getElementById("limitBase"),
  limitPreview: document.getElementById("limitPreview"),
};

let rules = null;
let seg = null;
let dirty = true;
let lastResult = null;

attachMoneyFormatter(els.amount);
attachMoneyFormatter(els.deduction);

bindTooltips(document);

seg = setupSegmented(els.amountMode, "gross");

els.useRegional.addEventListener("change", ()=>{
  els.regionalFields.hidden = !els.useRegional.checked;
  markDirty();
});

els.incomeType.addEventListener("change", ()=>{
  updateVisibility();
  markDirty();
});
els.taxYear.addEventListener("change", ()=>{
  applyYearDefaults();
  markDirty();
});
els.status.addEventListener("change", markDirty);
els.amountMode.addEventListener("seg:changed", markDirty);

["input","change"].forEach(ev=>{
  [els.amount, els.deduction, els.rkPct, els.northPct, els.maxKeyRate, els.limitBase].forEach(el=>{
    if(!el) return;
    el.addEventListener(ev, ()=>{
      if(el === els.maxKeyRate || el === els.rkPct || el === els.northPct){
        // normalize decimals
        el.value = el.value.replace(",",".");
      }
      updateLimitPreview();
      markDirty();
    });
  });
});

els.calcBtn.addEventListener("click", ()=>{
  calculate();
});

els.copyBtn.addEventListener("click", async ()=>{
  if(!lastResult){
    await copyText("Калькулятор НДФЛ: результата пока нет.");
    return;
  }
  const t = buildCopyText(lastResult);
  const ok = await copyText(t);
  els.statusBadge.style.display = "inline-flex";
  els.statusBadge.textContent = ok ? "Скопировано" : "Не удалось скопировать";
  setTimeout(()=>{ els.statusBadge.style.display="none"; }, 1200);
});

await init();

async function init(){
  rules = await fetchJson("./ndfl_rules.json");
  fillYears();
  applyYearDefaults();
  updateVisibility();
  updateLimitPreview();
  renderEmpty();
}

function fillYears(){
  const years = Object.keys(rules.years).map(x=>parseInt(x,10)).sort((a,b)=>b-a);
  els.taxYear.innerHTML = "";
  years.forEach(y=>{
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    els.taxYear.appendChild(opt);
  });
  const def = (rules.defaults && rules.defaults.taxYear) ? String(rules.defaults.taxYear) : String(years[0]||"2025");
  els.taxYear.value = years.includes(parseInt(def,10)) ? def : String(years[0]||"2025");
}

function applyYearDefaults(){
  const y = els.taxYear.value;
  const yr = rules.years[y];
  if(!yr) return;
  // deposit defaults
  if(yr.deposit){
    els.maxKeyRate.value = (yr.deposit.maxKeyRatePctDefault ?? 16).toFixed(1);
    els.limitBase.value = String(yr.deposit.nonTaxableBase ?? 1000000);
  }
}

function updateVisibility(){
  const isDeposit = els.incomeType.value === "deposit";
  els.depositLimitBlock.hidden = !isDeposit;
  // For deposit: deduction usually 0 but leave for flexibility.
  updateLimitPreview();
}

function updateLimitPreview(){
  const isDeposit = els.incomeType.value === "deposit";
  if(!isDeposit) return;
  const base = parseMoneyLike(els.limitBase.value);
  const r = parseFloat((els.maxKeyRate.value||"0").replace(",","."));
  const limit = base * (isFinite(r) ? r/100 : 0);
  els.limitPreview.textContent = "Необлагаемый лимит: " + fmtMoney(limit);
}

function markDirty(){
  dirty = true;
  els.calcNotice.textContent = "Параметры изменены. Нажмите «Рассчитать».";
  els.statusBadge.style.display = "none";
}

function renderEmpty(){
  els.resultSubtitle.textContent = "—";
  els.resMain.textContent = "—";
  els.resExplain.textContent = "Введите параметры слева и нажмите «Рассчитать».";
  els.kTax.textContent = "—";
  els.kGross.textContent = "—";
  els.kEff.textContent = "—";
  els.baseLine.textContent = "Налогооблагаемая база: —";
  els.taxTotalLine.textContent = "—";
  els.breakdownBody.innerHTML = `<tr><td colspan="4" style="color:rgba(255,255,255,.55); font-weight:700">—</td></tr>`;
  drawStackBar(els.bar, [{value:1, color:"rgba(255,255,255,0.12)"}]);
}

function calculate(){
  const amount = getMoneyValue(els.amount);      // entered (gross or net)
  const deduction = getMoneyValue(els.deduction);
  const year = els.taxYear.value;
  const incomeType = els.incomeType.value;
  const status = els.status.value;
  const mode = els.amountMode.dataset.value; // gross | net

  const yr = rules.years[year];
  if(!yr){
    alert("Нет правил для выбранного года.");
    return;
  }

  // Apply regional coefficients to gross only (if enabled)
  const useRegional = els.useRegional.checked && incomeType === "salary";
  const rk = useRegional ? safePct(els.rkPct.value) : 0;
  const north = useRegional ? safePct(els.northPct.value) : 0;

  let result;
  if(incomeType === "deposit"){
    result = calcDeposit(amount, mode, deduction, status, yr);
  }else{
    result = calcSalary(amount, mode, deduction, status, yr, rk, north);
  }

  lastResult = result;
  dirty = false;
  els.statusBadge.style.display = "inline-flex";
  els.statusBadge.textContent = "Готово";
  els.calcNotice.textContent = "Готово.";
  renderResult(result, yr);
}

function calcSalary(amount, mode, deduction, status, yr, rk, north){
  const grossMultiplier = (1 + rk/100) * (1 + north/100);
  const isResidentRate = (status === "resident" || status === "nonresident_resident_rate");
  const flatRate = yr.nonResidentFlatRate ?? 0.30;

  if(mode === "gross"){
    const gross = amount * grossMultiplier;
    const base = Math.max(0, gross - deduction);
    const tax = isResidentRate ? progressiveTax(base, yr.brackets) : base * flatRate;
    const net = gross - tax;
    return buildResult("salary", gross, net, tax, base, isResidentRate, yr.brackets);
  }else{
    // net input -> find gross such that net = gross - tax(base)
    const targetNet = amount;
    const solve = (g)=>{
      const base = Math.max(0, g - deduction);
      const tax = isResidentRate ? progressiveTax(base, yr.brackets) : base * flatRate;
      return g - tax;
    };
    // binary search in [0, hi]
    let lo = 0;
    let hi = Math.max(1, targetNet) * 2.5 + 1_000_000; // heuristics
    for(let i=0;i<80;i++){
      const mid = (lo+hi)/2;
      const v = solve(mid);
      if(v >= targetNet) hi = mid; else lo = mid;
    }
    const grossSolved = hi;
    const grossShown = grossSolved / grossMultiplier; // reverse coefficients for display? user entered net without coef. We'll display gross (with coef) as "Сумма до налога"
    const gross = grossSolved;
    const base = Math.max(0, gross - deduction);
    const tax = isResidentRate ? progressiveTax(base, yr.brackets) : base * flatRate;
    const net = gross - tax;
    return buildResult("salary", gross, net, tax, base, isResidentRate, yr.brackets, grossShown);
  }
}

function calcDeposit(amount, mode, deduction, status, yr){
  const isResidentRate = (status === "resident" || status === "nonresident_resident_rate");
  const flatRate = yr.nonResidentFlatRate ?? 0.30;

  const baseLimit = parseMoneyLike(els.limitBase.value);
  const maxKey = safePct(els.maxKeyRate.value);
  const nonTaxable = baseLimit * (maxKey/100);

  const taxBaseFromGross = (grossInterest)=>{
    const taxable = Math.max(0, grossInterest - nonTaxable);
    return Math.max(0, taxable - deduction);
  };

  if(mode === "gross"){
    const gross = amount;
    const base = taxBaseFromGross(gross);
    const tax = isResidentRate ? (
      (yr.deposit?.taxUsesProgressive ?? true) ? progressiveTax(base, yr.brackets) : base * (yr.brackets?.[0]?.rate ?? 0.13)
    ) : base * flatRate;
    const net = gross - tax;
    return buildResult("deposit", gross, net, tax, base, isResidentRate, yr.brackets, null, nonTaxable);
  }else{
    // net input -> solve gross
    const targetNet = amount;
    const solve = (g)=>{
      const base = taxBaseFromGross(g);
      const tax = isResidentRate ? (
        (yr.deposit?.taxUsesProgressive ?? true) ? progressiveTax(base, yr.brackets) : base * (yr.brackets?.[0]?.rate ?? 0.13)
      ) : base * flatRate;
      return g - tax;
    };
    let lo = 0;
    let hi = Math.max(1, targetNet) * 2.2 + nonTaxable + 1_000_000;
    for(let i=0;i<80;i++){
      const mid = (lo+hi)/2;
      const v = solve(mid);
      if(v >= targetNet) hi = mid; else lo = mid;
    }
    const gross = hi;
    const base = taxBaseFromGross(gross);
    const tax = isResidentRate ? (
      (yr.deposit?.taxUsesProgressive ?? true) ? progressiveTax(base, yr.brackets) : base * (yr.brackets?.[0]?.rate ?? 0.13)
    ) : base * flatRate;
    const net = gross - tax;
    return buildResult("deposit", gross, net, tax, base, isResidentRate, yr.brackets, null, nonTaxable);
  }
}

function buildResult(type, gross, net, tax, base, isResidentRate, brackets, grossBeforeCoef=null, nonTaxable=null){
  const eff = gross > 0 ? tax / gross : 0;
  const breakdown = isResidentRate ? breakdownByBrackets(base, brackets) : [{
    range:"—",
    base: base,
    rate: null,
    tax: tax
  }];

  return {
    type, gross, net, tax, base, eff,
    breakdown, isResidentRate,
    scheme: isResidentRate ? "Прогрессивная шкала" : "Плоская ставка",
    grossBeforeCoef,
    nonTaxable
  };
}

function renderResult(r, yr){
  const mode = els.amountMode.dataset.value;
  const isNet = mode === "net";
  const isDeposit = r.type === "deposit";

  // Main number: if user entered gross -> show net; if entered net -> show gross? Actually user expects "на руки" or "до налога" display.
  // We'll always show "на руки" as big number (practical), but keep both in KPI.
  els.resMain.textContent = fmtMoney(r.net);
  els.resultSubtitle.textContent = isDeposit ? "Доход по процентам за год" : "Доход за год";
  const year = els.taxYear.value;
  const statusText = (els.status.value === "resident") ? "резидент" : (els.status.value === "nonresident") ? "нерезидент" : "нерезидент (как резидент)";
  const schemeName = (els.status.value === "nonresident") ? "плоская ставка" : (yr.schemeName || "прогрессивная шкала");

  let explain = `При сумме ${fmtMoney(r.gross)} до налога, статус: ${statusText}, год: ${year}. Схема: ${schemeName}.`;
  if(isDeposit){
    explain = `Проценты за год: ${fmtMoney(r.gross)} (до налога), статус: ${statusText}, год: ${year}. Схема: ${schemeName}.`;
    if(isFinite(r.nonTaxable)){
      explain += ` Необлагаемый лимит: ${fmtMoney(r.nonTaxable)}.`;
    }
  }
  els.resExplain.textContent = explain;

  els.kTax.textContent = fmtMoney(r.tax);
  els.kGross.textContent = fmtMoney(r.gross);
  els.kEff.textContent = (r.gross>0 ? (r.eff*100).toFixed(1) : "0.0") + "%";

  els.baseLine.textContent = "Налогооблагаемая база: " + fmtMoney(r.base);
  els.taxTotalLine.textContent = fmtMoney(r.tax);

  // breakdown table
  els.breakdownBody.innerHTML = "";
  if(r.breakdown.length === 0){
    els.breakdownBody.innerHTML = `<tr><td colspan="4" style="color:rgba(255,255,255,.55); font-weight:700">—</td></tr>`;
  }else{
    r.breakdown.forEach(b=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(b.range)}</td>
        <td>${fmtMoney(b.base)}</td>
        <td>${b.rate==null ? "—" : (b.rate*100).toFixed(1) + "%"}</td>
        <td>${fmtMoney(b.tax)}</td>
      `;
      els.breakdownBody.appendChild(tr);
    });
  }

  // bar
  const parts = r.breakdown.map((b,i)=>({value:b.tax, color: i%2 ? "rgba(139,92,246,0.65)" : "rgba(34,197,94,0.55)"}));
  drawStackBar(els.bar, parts.length ? parts : [{value:1, color:"rgba(255,255,255,0.12)"}]);
}

function progressiveTax(base, brackets){
  if(!brackets || brackets.length===0) return 0;
  let tax = 0;
  let prev = 0;
  for(const b of brackets){
    const upTo = b.upTo;
    const rate = b.rate;
    if(upTo == null){
      const chunk = Math.max(0, base - prev);
      tax += chunk * rate;
      break;
    }else{
      const cap = upTo;
      const chunk = Math.max(0, Math.min(base, cap) - prev);
      tax += chunk * rate;
      prev = cap;
      if(base <= cap) break;
    }
  }
  return tax;
}

function breakdownByBrackets(base, brackets){
  const out = [];
  let prev = 0;
  for(const b of brackets){
    const upTo = b.upTo;
    const rate = b.rate;
    const cap = upTo == null ? Infinity : upTo;
    const chunk = Math.max(0, Math.min(base, cap) - prev);
    if(chunk > 0){
      const tax = chunk * rate;
      out.push({
        range: formatRange(prev, upTo),
        base: chunk,
        rate: rate,
        tax: tax
      });
    }
    prev = cap;
    if(base <= cap) break;
  }
  return out;
}

function formatRange(from, to){
  const a = fmtNumber(from);
  if(to == null) return `${a}+`;
  return `${a}–${fmtNumber(to)}`;
}

function safePct(v){
  const x = parseFloat((v||"0").toString().replace(",","."));
  return isFinite(x) ? x : 0;
}

function parseMoneyLike(v){
  const s = (v||"").toString().replace(/[^\d]/g,"");
  return s ? parseInt(s,10) : 0;
}

function escapeHtml(s){
  return (s||"").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function fetchJson(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error("Failed to load: " + url);
  return await res.json();
}

function buildCopyText(r){
  const year = els.taxYear.value;
  const statusText = (els.status.value === "resident") ? "резидент" : (els.status.value === "nonresident") ? "нерезидент" : "нерезидент (как резидент)";
  const typeText = (r.type === "deposit") ? "Проценты по вкладам" : "Заработная плата";
  let t = `Калькулятор НДФЛ\n` +
          `${typeText}, год ${year}, статус: ${statusText}\n` +
          `Сумма до налога: ${fmtMoney(r.gross)}\n` +
          `НДФЛ: ${fmtMoney(r.tax)}\n` +
          `На руки: ${fmtMoney(r.net)}\n` +
          `Эффективная ставка: ${(r.eff*100).toFixed(1)}%\n`;
  if(r.type==="deposit" && isFinite(r.nonTaxable)){
    t += `Необлагаемый лимит: ${fmtMoney(r.nonTaxable)}\n`;
  }
  t += `\nРазбивка по ставкам:\n`;
  r.breakdown.forEach(b=>{
    t += `${b.range}: ${fmtMoney(b.base)} × ${(b.rate*100).toFixed(1)}% = ${fmtMoney(b.tax)}\n`;
  });
  return t.trim();
}
