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
  inflChart: document.getElementById("inflChart"),
  mini: document.getElementById("mini"),
};

attachMoneyFormatter(els.price);
bindTooltips(document);

let db = null;
let dirty = true;
let last = null;

await init();

function normalizeDB(raw){
  if(!raw) throw new Error("Пустой JSON.");
  
  // Native format (preferred)
  if(raw.series && raw.years) return raw;
  
  // Format: { inflation_annual: { "2024": 9.5, ... } }
  if(raw.inflation_annual && typeof raw.inflation_annual === "object"){
    const infl = raw.inflation_annual;
    const years = Object.keys(infl).filter(k=>/^\d{4}$/.test(k)).map(Number).sort((a,b)=>a-b);
    return {
      meta: { title: "ИПЦ (годовая инфляция)", source: "Пользовательский JSON", unit: "percent" },
      years,
      defaults: { total: "total", food: null, nonfood: null, services: null },
      series: [{
        id: "total",
        name: "ИПЦ (все товары и услуги)",
        displayName: "ИПЦ (все товары и услуги)",
        inflationPct: infl
      }]
    };
  }
  
  // Format: { categories: { id: { name: "...", 2024: 9.5, ... }, ... } }
  if(raw.categories && typeof raw.categories === "object"){
    const series = [];
    for(const [id, obj] of Object.entries(raw.categories)){
      if(!obj || typeof obj !== "object") continue;
      const inflationPct = {};
      for(const [k,v] of Object.entries(obj)){
        if(/^\d{4}$/.test(k) && v!=null && v!==""){
          inflationPct[k] = Number(v);
        }
      }
      if(Object.keys(inflationPct).length===0) continue;
      series.push({
        id,
        name: obj.name || id,
        displayName: obj.displayName || null,
        inflationPct
      });
    }
    const yearsSet = new Set();
    series.forEach(s=>Object.keys(s.inflationPct).forEach(y=>yearsSet.add(Number(y))));
    const years = Array.from(yearsSet).sort((a,b)=>a-b);
    return {
      meta: { title: "ИПЦ по категориям", source: "Пользовательский JSON", unit: "percent" },
      years,
      defaults: { total: series[0]?.id || null, food: null, nonfood: null, services: null },
      series
    };
  }
  
  // Format: { "2000": 20.2, "2001": 18.6, ... } (plain year->rate)
  const keys = Object.keys(raw);
  if(keys.length && keys.every(k=>/^\d{4}$/.test(k))){
    const years = keys.map(Number).sort((a,b)=>a-b);
    const inflationPct = {};
    years.forEach(y=>{ inflationPct[String(y)] = Number(raw[String(y)]); });
    return {
      meta: { title: "ИПЦ (годовая инфляция)", source: "Пользовательский JSON", unit: "percent" },
      years,
      defaults: { total: "total", food: null, nonfood: null, services: null },
      series: [{
        id: "total",
        name: "ИПЦ (все товары и услуги)",
        displayName: "ИПЦ (все товары и услуги)",
        inflationPct
      }]
    };
  }
  
  throw new Error("Неизвестный формат JSON. Нужны поля series/years или inflation_annual или categories.");
}

async function init(){
  try{
    const raw = await fetchJson("./inflation_ru_full_1991_2024.json");
    db = normalizeDB(raw);
  }catch(e){
    console.error(e);
    els.resSub.textContent = "Ошибка загрузки данных";
    els.resMain.textContent = "—";
    els.resExplain.textContent = "Не удалось загрузить JSON с инфляцией. Проверьте, что файл inflation_ru_full_1991_2024.json лежит рядом с inflation.html и имеет корректный формат.";
    els.kDiff.textContent = "—";
    els.kPct.textContent = "—";
    els.kMul.textContent = "—";
    if(els.inflChart) els.inflChart.getContext('2d').clearRect(0, 0, els.inflChart.width, els.inflChart.height);
    els.mini.innerHTML = "";
    return;
  }
  
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
    opt.textContent = (s.displayName || s.name);
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
  if(els.inflChart){
    const ctx = els.inflChart.getContext('2d');
    ctx.clearRect(0, 0, els.inflChart.width, els.inflChart.height);
  }
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
  
  // Draw yearly chart
  drawYearlyChart(els.inflChart, s.inflationPct, fromYear, toYear);
  els.mini.textContent = `Динамика годовой инфляции: ${fromYear}–${toYear}`;
  
  dirty = false;
  els.inflNotice.textContent = "Готово.";
}

function computeMultiplier(inflByYear, fromYear, toYear){
  // inflationPct keyed by year as string; use years between
  let mul = 1.0;
  if(fromYear < toYear){
    for(let y=fromYear; y<toYear; y++){
      const rate = parseFloat(inflByYear[String(y+1)] || 0);
      mul *= (1 + rate/100);
    }
  } else {
    for(let y=fromYear; y>toYear; y--){
      const rate = parseFloat(inflByYear[String(y)] || 0);
      mul /= (1 + rate/100);
    }
  }
  return mul;
}

function drawYearlyChart(canvasEl, inflByYear, fromYear, toYear){
  if(!canvasEl || !inflByYear) return;
  
  const years = [];
  if(fromYear < toYear){
    for(let y=fromYear; y<=toYear; y++) years.push(y);
  } else {
    for(let y=fromYear; y>=toYear; y--) years.push(y);
  }
  
  const inflData = years.map(y => parseFloat(inflByYear[String(y)] || 0));
  const ctx = canvasEl.getContext('2d');
  const w = canvasEl.width;
  const h = canvasEl.height;
  
  ctx.clearRect(0, 0, w, h);
  
  if(inflData.length === 0) return;
  
  const maxInfl = Math.max(...inflData, 5);
  const padding = 50;
  const chartW = w - padding * 2;
  const chartH = h - padding * 2;
  
  // Grid and axes
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for(let i=0; i<=5; i++){
    const y = padding + (chartH/5)*i;
    ctx.moveTo(padding, y);
    ctx.lineTo(w-padding, y);
  }
  ctx.stroke();
  
  // Y-axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'right';
  for(let i=0; i<=5; i++){
    const val = maxInfl * (1 - i/5);
    const y = padding + (chartH/5)*i;
    ctx.fillText(val.toFixed(1) + '%', padding-8, y+4);
  }
  
  // Line chart
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  inflData.forEach((val, i) => {
    const x = padding + (chartW/(inflData.length-1||1))*i;
    const y = padding + chartH - (val/maxInfl)*chartH;
    if(i===0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Points
  ctx.fillStyle = '#8b5cf6';
  inflData.forEach((val, i) => {
    const x = padding + (chartW/(inflData.length-1||1))*i;
    const y = padding + chartH - (val/maxInfl)*chartH;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI*2);
    ctx.fill();
  });
  
  // X-axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '12px Inter, sans-serif';
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(years.length/10));
  years.forEach((yr, i) => {
    if(i%step===0 || i===years.length-1){
      const x = padding + (chartW/(inflData.length-1||1))*i;
      ctx.fillText(String(yr), x, h-padding+20);
    }
  });
}

async function fetchJson(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error("Failed to load: " + url);
  return await res.json();
}
