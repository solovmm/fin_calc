
import {
  fmtMoney, fmtNumber, attachMoneyFormatter, getMoneyValue, setMoneyValue,
  bindTooltips, copyText, drawStackBar
} from "./common.js";

const els = {
  price: document.getElementById("price"),
  fromYear: document.getElementById("fromYear"),
  toYear: document.getElementById("toYear"),
  series: document.getElementById("series"),
  calcBtn: document.getElementById("calcBtn"),
  swapBtn: document.getElementById("swapBtn"),
  copyBtn: document.getElementById("copyBtn"),
  inflNotice: document.getElementById("inflNotice"),
  resSub: document.getElementById("resSub"),
  resMain: document.getElementById("resMain"),
  resExplain: document.getElementById("resExplain"),
  kDiff: document.getElementById("kDiff"),
  kPct: document.getElementById("kPct"),
  kMul: document.getElementById("kMul"),
  bar: document.getElementById("bar"),
  mini: document.getElementById("mini"),
};

attachMoneyFormatter(els.price);
bindTooltips(document);

let db = null;
let dirty = true;
let last = null;

await init();

async function init(){
  db = await fetchJson("./inflation_ru_full_1991_2024.json");
  fillYears();
  fillSeries();
  // defaults: 2020 -> 2024 if available
  setDefaultYears();
  markDirty();
  renderEmpty();
}

function fillYears(){
  const years = db.years || [];
  const opts = years.map(y=>String(y));
  els.fromYear.innerHTML = "";
  els.toYear.innerHTML = "";
  opts.forEach(y=>{
    const o1=document.createElement("option"); o1.value=y; o1.textContent=y;
    const o2=document.createElement("option"); o2.value=y; o2.textContent=y;
    els.fromYear.appendChild(o1);
    els.toYear.appendChild(o2);
  });

  els.fromYear.addEventListener("change", markDirty);
  els.toYear.addEventListener("change", markDirty);
  els.series.addEventListener("change", markDirty);
  els.price.addEventListener("money:changed", markDirty);

  els.swapBtn.addEventListener("click", ()=>{
    const a=els.fromYear.value;
    els.fromYear.value = els.toYear.value;
    els.toYear.value = a;
    markDirty();
  });

  els.calcBtn.addEventListener("click", calculate);

  els.copyBtn.addEventListener("click", async ()=>{
    if(!last){
      await copyText("Инфляционный калькулятор: результата пока нет.");
      return;
    }
    const t = `Инфляционный калькулятор\n` +
      `Категория: ${last.seriesName}\n` +
      `${fmtMoney(last.amount)} в ${last.fromYear} → ${fmtMoney(last.result)} в ${last.toYear}\n` +
      `Разница: ${fmtMoney(last.diff)} (${last.pct.toFixed(1)}%), множитель: ${last.mul.toFixed(2)}x`;
    await copyText(t);
  });
}

function fillSeries(){
  const arr = db.series || [];
  // Create a neat short list: prioritize defaults if present, then others
  const ids = new Set();
  const ordered = [];
  ["total","food","nonfood","services"].forEach(k=>{
    const id = db.defaults?.[k];
    if(id){
      const s = arr.find(x=>x.id===id);
      if(s){ ordered.push(s); ids.add(id); }
    }
  });
  arr.forEach(s=>{
    if(!ids.has(s.id)) ordered.push(s);
  });

  els.series.innerHTML = "";
  ordered.forEach(s=>{
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    els.series.appendChild(opt);
  });
  // set default series
  const def = db.defaults?.total;
  if(def) els.series.value = def;
}

function setDefaultYears(){
  const years = db.years || [];
  const setIf = (sel, y) => { if(years.includes(y)) sel.value = String(y); };
  setIf(els.fromYear, 2020);
  setIf(els.toYear, 2024);
  if(els.fromYear.value === els.toYear.value){
    // pick last year as toYear
    els.toYear.value = String(years[years.length-1] || 2024);
  }
}

function markDirty(){
  dirty = true;
  els.inflNotice.textContent = "Параметры изменены. Нажмите «Рассчитать».";
}

function renderEmpty(){
  els.resSub.textContent = "—";
  els.resMain.textContent = "—";
  els.resExplain.textContent = "Введите параметры слева и нажмите «Рассчитать».";
  els.kDiff.textContent = "—";
  els.kPct.textContent = "—";
  els.kMul.textContent = "—";
  els.mini.textContent = "—";
  drawStackBar(els.bar, [{value:1, color:"rgba(255,255,255,0.12)"}]);
}

function calculate(){
  const amount = getMoneyValue(els.price);
  const fromYear = parseInt(els.fromYear.value,10);
  const toYear = parseInt(els.toYear.value,10);
  const id = els.series.value;
  const s = (db.series || []).find(x=>x.id===id);
  if(!s){
    alert("Категория не найдена в JSON.");
    return;
  }
  if(fromYear === toYear){
    alert("Выберите разные годы.");
    return;
  }

  const mul = computeMultiplier(s.inflationPct, fromYear, toYear);
  const result = amount * mul;
  const diff = result - amount;
  const pct = (amount>0) ? (diff/amount*100) : 0;

  last = {amount, fromYear, toYear, mul, result, diff, pct, seriesName:s.name};

  els.resSub.textContent = s.name;
  els.resMain.textContent = fmtMoney(result);
  els.resExplain.textContent = `${fmtMoney(amount)} в ${fromYear} году = ${fmtMoney(result)} в ценах ${toYear} года.`;
  els.kDiff.textContent = fmtMoney(diff);
  els.kPct.textContent = (pct>=0?"+":"") + pct.toFixed(1) + "%";
  els.kMul.textContent = mul.toFixed(2) + "x";

  // mini timeline (start, mid, end)
  const path = buildMiniPoints(amount, s.inflationPct, fromYear, toYear);
  const parts = path.parts;
  drawStackBar(els.bar, parts);
  els.mini.textContent = `${fromYear}: ${fmtMoney(path.a)} · ${path.midYear}: ${fmtMoney(path.mid)} · ${toYear}: ${fmtMoney(path.b)}`;

  dirty = false;
  els.inflNotice.textContent = "Готово.";
}

function computeMultiplier(inflByYear, fromYear, toYear){
  // inflationPct keyed by year as string; use years between
  let mul = 1.0;
  if(fromYear < toYear){
    for(let y=fromYear; y<toYear; y++){
      const r = inflByYear[String(y)];
      const rate = (r==null) ? 0 : (parseFloat(r)/100);
      mul *= (1 + rate);
    }
  }else{
    // reverse
    for(let y=toYear; y<fromYear; y++){
      const r = inflByYear[String(y)];
      const rate = (r==null) ? 0 : (parseFloat(r)/100);
      mul /= (1 + rate);
    }
  }
  return mul;
}

function buildMiniPoints(amount, inflByYear, fromYear, toYear){
  const dir = fromYear < toYear ? 1 : -1;
  const years = [];
  if(dir===1){
    for(let y=fromYear; y<=toYear; y++) years.push(y);
  }else{
    for(let y=fromYear; y>=toYear; y--) years.push(y);
  }
  const midYear = years[Math.floor(years.length/2)];
  const a = amount;
  const mid = amount * computeMultiplier(inflByYear, fromYear, midYear);
  const b = amount * computeMultiplier(inflByYear, fromYear, toYear);

  // stacked bar parts: growth by segments
  const parts = [];
  const total = Math.abs(b-a) || 1;
  const p1 = Math.abs(mid-a);
  const p2 = Math.abs(b-mid);
  parts.push({value:p1, color:"rgba(139,92,246,0.60)"});
  parts.push({value:p2, color:"rgba(34,197,94,0.55)"});
  return {a, mid, b, midYear, parts};
}

async function fetchJson(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error("Failed to load: " + url);
  return await res.json();
}
