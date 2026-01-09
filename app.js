/* app.js
   Инфляционный калькулятор: читает JSON с рядами ИПЦ и пересчитывает сумму между годами.
*/

const DATA_URL = "./inflation_ru_full_1991_2024.json";

const el = (id) => document.getElementById(id);

const elAmount = el("amount");
const elCat = el("category");
const elFrom = el("fromYear");
const elTo = el("toYear");
const elFlowText = el("flowText");
const elRangeNote = el("rangeNote");
const elDataBadgeText = el("dataBadgeText");
const elWarnFile = el("warnFile");
const elCatSearch = el("catSearch");

let DATA = null;
let SERIES_BY_ID = new Map();
let currentSeries = null;
let lastResultText = "";

function formatNumber(n){ return new Intl.NumberFormat("ru-RU").format(Math.round(n)); }
function formatMoney(n){ return formatNumber(n) + " ₽"; }

function formatPct(p){
  const sign = p > 0 ? "+" : (p < 0 ? "−" : "");
  const abs = Math.abs(p);
  const val = abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  return sign + val + "%";
}

function parseAmount(str){
  const clean = (str || "").toString().replace(/[^\d]/g, "");
  return clean ? Number(clean) : NaN;
}

function setLoading(isLoading){
  const btn = el("btnCalc");
  el("calcIcon").style.display = isLoading ? "none" : "inline-flex";
  el("calcLoading").style.display = isLoading ? "inline-flex" : "none";
  btn.disabled = !!isLoading;
}

function toast(msg, ok=false){
  const t = el("toast");
  if(!msg){
    t.style.display = "none";
    t.textContent = "";
    t.classList.remove("ok");
    return;
  }
  t.textContent = msg;
  t.style.display = "block";
  t.classList.toggle("ok", !!ok);
}

function closeAllTips(exceptId){
  document.querySelectorAll(".tooltip").forEach(t=>{
    if(t.id !== exceptId) t.style.display = "none";
  });
}

function initTooltips(){
  document.querySelectorAll(".helpBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-tip");
      const tip = el(id);
      if(!tip) return;
      const isOpen = tip.style.display === "block";
      closeAllTips(isOpen ? null : id);
      tip.style.display = isOpen ? "none" : "block";
    });
  });
  document.addEventListener("click", (e)=>{
    const isHelp = e.target.closest(".helpBtn") || e.target.closest(".tooltip");
    if(!isHelp) closeAllTips(null);
  });
}

function buildLevels(series){
  // level[minYear] = 1
  // level[y] = level[y-1] * (yoyIndex[y] / 100), where yoyIndex[y] is Dec(y)/Dec(y-1)*100
  const yoy = series.yoyIndex || {};
  const minY = series.minYear;
  const maxY = series.maxYear;
  const level = {};
  level[minY] = 1.0;
  let prev = minY;

  for(let y=minY+1; y<=maxY; y++){
    const v = yoy[String(y)];
    if(!isFinite(v)) break;
    level[y] = level[prev] * (v / 100.0);
    prev = y;
  }
  return level;
}

function yearsFromLevel(level){
  return Object.keys(level).map(Number).sort((a,b)=>a-b);
}

function setSelectOptions(sel, years){
  sel.innerHTML = "";
  years.forEach(y=>{
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  });
}

function setDefaultYears(availableYears){
  const setIf = (sel, prefer) => {
    if(availableYears.includes(prefer)) sel.value = String(prefer);
    else sel.value = String(availableYears[0]);
  };

  setIf(elFrom, 2010);
  if(availableYears.includes(2024)) elTo.value = "2024";
  else elTo.value = String(availableYears[availableYears.length - 1]);
  updateFlow();
}

function updateFlow(){
  elFlowText.textContent = `цена в ${elFrom.value} → в цены ${elTo.value}`;
}

function swapYears(){
  const a = elFrom.value;
  elFrom.value = elTo.value;
  elTo.value = a;
  updateFlow();
}

function renderSpark(points){
  const box = el("sparkBox");
  const svg = el("sparkSvg");
  const span = el("sparkSpan");
  const sMin = el("sparkMin");
  const sMax = el("sparkMax");

  if(!points || points.length < 2){
    box.style.display = "none";
    return;
  }
  box.style.display = "block";

  const years = points.map(p=>p.year);
  const vals = points.map(p=>p.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);

  const W = 300, H = 92;
  const padX = 6, padY = 8;
  const innerW = W - padX*2;
  const innerH = H - padY*2;
  const denom = (maxV - minV) || 1;

  const coords = points.map((p, i)=>{
    const x = padX + (innerW * i / (points.length - 1));
    const y = padY + innerH * (1 - (p.value - minV) / denom);
    return [x, y];
  });

  const path = coords.map((c,i)=> (i===0 ? "M" : "L") + c[0].toFixed(2) + " " + c[1].toFixed(2)).join(" ");
  const area = path + ` L ${coords[coords.length-1][0].toFixed(2)} ${(H-padY).toFixed(2)} L ${coords[0][0].toFixed(2)} ${(H-padY).toFixed(2)} Z`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="gFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(124,58,237,.28)"></stop>
        <stop offset="100%" stop-color="rgba(124,58,237,0)"></stop>
      </linearGradient>
      <linearGradient id="gLine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="rgba(34,197,94,.95)"></stop>
        <stop offset="60%" stop-color="rgba(124,58,237,.95)"></stop>
        <stop offset="100%" stop-color="rgba(239,68,68,.92)"></stop>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#gFill)"></path>
    <path d="${path}" fill="none" stroke="url(#gLine)" stroke-width="2.2" stroke-linecap="round"></path>
    ${coords.map(([x,y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.3" fill="rgba(255,255,255,.80)"></circle>`).join("")}
  `;

  span.textContent = `${years[0]} → ${years[years.length-1]}`;
  sMin.textContent = formatMoney(minV);
  sMax.textContent = formatMoney(maxV);
}

function setResultUI({ amount, fromYear, toYear, out, diff, pct, factor, catName }){
  el("resMain").innerHTML = `<span class="mono">${formatMoney(out)}</span>`;
  el("resLine").innerHTML =
    `Если <b>${formatMoney(amount)}</b> было в <b>${fromYear}</b>, то в ценах <b>${toYear}</b> это примерно <b>${formatMoney(out)}</b>.<br/>Категория: <b>${catName}</b>.`;

  const isForward = Number(toYear) >= Number(fromYear);

  const diffEl = el("resDiff");
  diffEl.textContent = (diff >= 0 ? "+" : "−") + formatMoney(Math.abs(diff));
  diffEl.className = "val " + (isForward ? "bad" : "good");

  const pctEl = el("resPct");
  pctEl.textContent = formatPct(pct);
  pctEl.className = "val " + (isForward ? "bad" : "good");

  el("resFactor").textContent = factor.toFixed(2) + "x";
  el("resultHint").textContent = "Готово.";

  lastResultText =
    `${formatMoney(amount)} в ${fromYear} году = ${formatMoney(out)} в ценах ${toYear} года.\n` +
    `Категория: ${catName}.\n` +
    `Разница: ${(diff>=0?"+":"-")}${formatMoney(Math.abs(diff))} (${formatPct(pct)}), фактор: ${factor.toFixed(2)}x.`;
}

function buildOptionsForSelect(seriesList){
  elCat.innerHTML = "";
  // Сначала headline, затем остальные по алфавиту
  const headline = seriesList.filter(s=>s.kind==="headline");
  const detail = seriesList.filter(s=>s.kind!=="headline").sort((a,b)=>a.name.localeCompare(b.name, "ru"));

  const addGroup = (label, items) => {
    const og = document.createElement("optgroup");
    og.label = label;
    items.forEach(s=>{
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      og.appendChild(opt);
    });
    elCat.appendChild(og);
  };

  if(headline.length) addGroup("Основные", headline);
  if(detail.length) addGroup("Категории", detail);

  elCat.value = "cpi_all";
}

function applyCategoryFilter(q){
  const query = (q || "").trim().toLowerCase();
  const options = elCat.querySelectorAll("option");
  options.forEach(opt=>{
    if(!query){
      opt.hidden = false;
      return;
    }
    opt.hidden = !opt.textContent.toLowerCase().includes(query);
  });
}

function onSeriesChange(){
  const id = elCat.value;
  const s = SERIES_BY_ID.get(id);
  if(!s){
    toast("Не найден выбранный ряд.");
    return;
  }
  currentSeries = s;
  currentSeries._level = buildLevels(s);
  const years = yearsFromLevel(currentSeries._level);

  if(years.length < 2){
    toast("По этой категории недостаточно данных для пересчета.");
    return;
  }

  setSelectOptions(elFrom, years);
  setSelectOptions(elTo, years);
  setDefaultYears(years);

  elRangeNote.textContent = `Доступно: ${years[0]}–${years[years.length-1]}.`;
}

async function calculate(){
  toast("");

  if(!DATA || !currentSeries){
    toast("Данные еще не загружены.");
    return;
  }

  const amount = parseAmount(elAmount.value);
  if(!isFinite(amount) || amount <= 0){
    toast("Введите сумму больше нуля.");
    return;
  }

  const fromYear = Number(elFrom.value);
  const toYear = Number(elTo.value);

  const level = currentSeries._level;
  const a = level[fromYear];
  const b = level[toYear];

  if(!isFinite(a) || !isFinite(b)){
    toast("Выбранные годы не доступны для этой категории.");
    return;
  }

  setLoading(true);
  try{
    const out = amount * (b / a);
    const outRounded = Math.round(out);
    const diff = outRounded - amount;
    const pct = (diff / amount) * 100;
    const factor = out / amount;

    // график
    const start = Math.min(fromYear, toYear);
    const end = Math.max(fromYear, toYear);
    const pts = [];
    for(let y=start; y<=end; y++){
      if(isFinite(level[y])){
        pts.push({ year: y, value: Math.round(amount * (level[y] / a)) });
      }
    }

    setResultUI({
      amount, fromYear, toYear,
      out: outRounded, diff, pct, factor,
      catName: currentSeries.name
    });

    renderSpark(pts);
    toast("Готово.", true);
  } catch(e){
    toast("Ошибка расчета.");
  } finally {
    setLoading(false);
  }
}

async function loadData(){
  if(location.protocol === "file:") elWarnFile.style.display = "block";

  setLoading(true);
  try{
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if(!res.ok) throw new Error("Не удалось загрузить JSON с данными.");
    DATA = await res.json();

    const series = DATA.series || [];
    SERIES_BY_ID = new Map(series.map(s => [s.id, s]));

    elDataBadgeText.textContent = "Росстат (JSON, локально)";
    el("srcMeta").textContent = `Источник: ${DATA.meta?.source || "Росстат"}. Дата генерации JSON: ${DATA.meta?.generatedAt || "—"}.`;

    buildOptionsForSelect(series);
    onSeriesChange();

    toast("", true);
  } catch(e){
    toast(e.message || "Ошибка загрузки данных.");
    elDataBadgeText.textContent = "ошибка загрузки";
  } finally {
    setLoading(false);
  }
}

function initEvents(){
  el("btnSwap").addEventListener("click", swapYears);
  el("summarySwap").addEventListener("click", swapYears);

  el("btnSetMax").addEventListener("click", ()=>{
    const years = yearsFromLevel(currentSeries._level);
    elTo.value = String(years[years.length - 1]);
    updateFlow();
  });

  elCat.addEventListener("change", ()=>{
    toast("");
    onSeriesChange();
  });

  elFrom.addEventListener("change", updateFlow);
  elTo.addEventListener("change", updateFlow);

  el("btnCalc").addEventListener("click", calculate);

  // amount formatting
  elAmount.addEventListener("input", ()=>{
    const digits = elAmount.value.replace(/[^\d]/g, "");
    elAmount.value = digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "";
  });
  elAmount.addEventListener("blur", ()=>{
    const n = parseAmount(elAmount.value);
    elAmount.value = isFinite(n) ? formatNumber(n) : "";
  });

  // copy
  el("btnCopy").addEventListener("click", async ()=>{
    if(!lastResultText){
      toast("Пока нечего копировать. Сначала сделайте расчет.");
      return;
    }
    try{
      await navigator.clipboard.writeText(lastResultText);
      toast("Скопировано.", true);
    } catch(e){
      toast("Не удалось скопировать. В браузере могут быть ограничения.");
    }
  });

  // search
  elCatSearch.addEventListener("input", ()=>{
    applyCategoryFilter(elCatSearch.value);
  });

  // modal
  const modalBack = el("modalBack");
  el("btnHelp").addEventListener("click", ()=>{ modalBack.style.display="flex"; });
  el("btnCloseHelp").addEventListener("click", ()=>{ modalBack.style.display="none"; });
  modalBack.addEventListener("click", (e)=>{ if(e.target === modalBack) modalBack.style.display="none"; });
}

function bootstrap(){
  initTooltips();
  initEvents();
  elAmount.value = "100 000";
  loadData();
}

bootstrap();
