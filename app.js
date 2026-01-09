// Инфляционный калькулятор (простая версия без поиска)
// Данные подгружаются из JSON рядом с файлом.

const DATA_URL = 'inflation_ru_full_1991_2024.json';

const el = (id) => document.getElementById(id);

const state = {
  data: null,
  seriesById: new Map(),
  selectedSeriesId: null,
};

let isDirty = true;

function markDirty(msg = 'Изменено. Нажмите «Рассчитать».') {
  isDirty = true;
  el('summary').textContent = '—';
  el('resultValue').textContent = '—';
  el('diffValue').textContent = '—';
  el('pctValue').textContent = '—';
  el('factorValue').textContent = '—';
  el('rangeTag').textContent = '—';
  drawChart([]);
  el('status').textContent = msg;
}

function fmtMoney(n) {
  if (!isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

function fmtSignedMoney(n) {
  if (!isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + fmtMoney(n).replace(' ₽','') + ' ₽';
}

function fmtSignedPct(n) {
  if (!isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(1) + '%';
}

function clampInt(v, fallback=0){
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? x : fallback;
}

function buildSeriesSelect() {
  const select = el('series');
  select.innerHTML = '';

  const agg = state.data.series.filter(s => s.type === 'aggregate');
  const cat = state.data.series.filter(s => s.type !== 'aggregate').slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));

  const og1 = document.createElement('optgroup');
  og1.label = 'Основные';
  agg.forEach(s => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    og1.appendChild(o);
  });

  const og2 = document.createElement('optgroup');
  og2.label = 'Детальные категории';
  cat.forEach(s => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    og2.appendChild(o);
  });

  select.appendChild(og1);
  select.appendChild(og2);

  // default: total CPI if exists, else first aggregate
  const total = agg.find(s => s.name.toLowerCase().includes('все товары'));
  state.selectedSeriesId = (total || agg[0] || cat[0]).id;
  select.value = state.selectedSeriesId;
}

function availableYearsForSeries(series) {
  const years = Object.keys(series.rates).map(y => parseInt(y,10)).filter(Number.isFinite).sort((a,b)=>a-b);
  return years;
}

function buildYearSelects() {
  const series = state.seriesById.get(state.selectedSeriesId);
  const years = availableYearsForSeries(series);

  const fromSel = el('fromYear');
  const toSel = el('toYear');

  fromSel.innerHTML = '';
  toSel.innerHTML = '';

  years.forEach(y => {
    const o1 = document.createElement('option'); o1.value = y; o1.textContent = y;
    const o2 = document.createElement('option'); o2.value = y; o2.textContent = y;
    fromSel.appendChild(o1);
    toSel.appendChild(o2);
  });

  const pickNearest = (target) => {
    if (years.includes(target)) return target;
    let best = years[0];
    let bestD = Math.abs(best - target);
    for (const y of years) {
      const d = Math.abs(y - target);
      if (d < bestD) { best = y; bestD = d; }
    }
    return best;
  };

  const defaultFrom = pickNearest(2020);
  const defaultTo = pickNearest(2024);

  fromSel.value = String(defaultFrom);
  toSel.value = String(defaultTo);

  updateDirectionText();
}

function updateDirectionText(){
  const fromY = clampInt(el('fromYear').value);
  const toY = clampInt(el('toYear').value);
  const txt = `Считаем: цена в ${fromY} → в цены ${toY}`;
  el('directionText').textContent = txt;
}

function swapYears(){
  const fromSel = el('fromYear');
  const toSel = el('toYear');
  const a = fromSel.value;
  fromSel.value = toSel.value;
  toSel.value = a;
  updateDirectionText();
  markDirty();
}

// Mode A: multiply rates from minYear..maxYear-1 (matches прошлые версии)
function recalc(amount, fromYear, toYear, ratesByYear) {
  if (fromYear === toYear) return amount;

  let result = amount;
  const start = Math.min(fromYear, toYear);
  const end = Math.max(fromYear, toYear);

  for (let y = start; y < end; y++) {
    const r = ratesByYear[y];
    if (typeof r !== 'number') {
      // missing data - stop gracefully
      return NaN;
    }
    const k = 1 + (r / 100);
    if (fromYear < toYear) result *= k;
    else result /= k;
  }
  return result;
}

function buildPath(amount, fromYear, toYear, ratesByYear) {
  const path = [];
  const step = fromYear <= toYear ? 1 : -1;
  let cur = amount;
  path.push({ year: fromYear, value: cur });

  for (let y = fromYear; y !== toYear; y += step) {
    const idxYear = step === 1 ? y : (y - 1);
    const r = ratesByYear[idxYear];
    if (typeof r !== 'number') return [];
    const k = 1 + (r / 100);
    cur = step === 1 ? cur * k : cur / k;
    path.push({ year: y + step, value: cur });
  }
  return path;
}

function drawChart(points) {
  const canvas = el('chart');
  const ctx = canvas.getContext('2d');

  // Пустой график (когда пользователь изменил параметры и еще не нажал «Рассчитать»)
  if (!points || points.length < 2) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Нажмите «Рассчитать», чтобы построить график', canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'left';
    return;
  }

  // clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!points || points.length < 2) {
    // placeholder
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '16px ui-sans-serif, system-ui';
    ctx.fillText('Недостаточно данных для графика', 18, 38);
    return;
  }

  const pad = { l: 40, r: 18, t: 18, b: 34 };
  const W = canvas.width - pad.l - pad.r;
  const H = canvas.height - pad.t - pad.b;

  const xs = points.map(p => p.year);
  const ys = points.map(p => p.value);

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  const xScale = (x) => pad.l + (W * (x - xMin) / (xMax - xMin));
  const yScale = (v) => pad.t + (H * (1 - (v - yMin) / (yMax - yMin || 1)));

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (H * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + W, y);
    ctx.stroke();
  }

  // line
  ctx.strokeStyle = 'rgba(167,139,250,.95)'; // soft purple
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xScale(p.year);
    const y = yScale(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // dots
  ctx.fillStyle = 'rgba(34,197,94,.95)';
  points.forEach((p, i) => {
    const x = xScale(p.year);
    const y = yScale(p.value);
    ctx.beginPath();
    ctx.arc(x, y, i === points.length - 1 ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // axis labels
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  ctx.font = '14px ui-sans-serif, system-ui';

  ctx.fillText(String(xMin), pad.l, pad.t + H + 26);
  ctx.fillText(String(xMax), pad.l + W - 26, pad.t + H + 26);

  // y labels (min/max)
  ctx.fillText(fmtMoney(yMax).replace(' ₽',''), 8, pad.t + 14);
  ctx.fillText(fmtMoney(yMin).replace(' ₽',''), 8, pad.t + H);
}

function calculateAndRender() {
    const amountRaw = (el('amount').value || '').replace(/\s+/g,'').replace(/\D/g,'');
  const amount = amountRaw ? parseFloat(amountRaw) : 0;
  const fromYear = clampInt(el('fromYear').value);
  const toYear = clampInt(el('toYear').value);
  const series = state.seriesById.get(state.selectedSeriesId);

  if (!series) return;

    if (!Number.isFinite(amount) || amount < 0) {
    el('status').textContent = 'Введите корректную сумму (0 или больше).';
    return;
  }

  const result = recalc(amount, fromYear, toYear, series.rates);

  if (!isFinite(result)) {
    el('status').textContent = 'Для выбранной категории нет данных на весь заданный диапазон.';
    el('resultValue').textContent = '—';
    el('summary').textContent = '—';
    el('diffValue').textContent = '—';
    el('pctValue').textContent = '—';
    el('factorValue').textContent = '—';
    el('rangeTag').textContent = '—';
    drawChart([]);
    return;
  }

  const diff = result - amount;
  const pct = (diff / amount) * 100;
  const factor = result / amount;

  el('status').textContent = 'Готово.';
  el('resultValue').textContent = fmtMoney(result);

  const catName = series.name;
  el('summary').textContent = `Если ${fmtMoney(amount)} было в ${fromYear}, то в ценах ${toYear} это примерно ${fmtMoney(result)}. Категория: ${catName}.`;

  const diffEl = el('diffValue');
  diffEl.textContent = fmtSignedMoney(diff);
  diffEl.className = 'v ' + (diff >= 0 ? 'pos' : 'neg');

  const pctEl = el('pctValue');
  pctEl.textContent = fmtSignedPct(pct);
  pctEl.className = 'v ' + (pct >= 0 ? 'pos' : 'neg');

  el('factorValue').textContent = factor.toFixed(2) + 'x';
  el('rangeTag').textContent = `${fromYear} → ${toYear}`;

  const points = buildPath(amount, fromYear, toYear, series.rates);
  drawChart(points);

  updateDirectionText();

  // cache last for copy
  state.lastResultText = `${fmtMoney(amount)} в ${fromYear} = ${fmtMoney(result)} в ценах ${toYear} (${catName})`;

  isDirty = false;
  el('status').textContent = 'Готово.';
}


function bindUI(){
  // help popovers
  document.querySelectorAll('.help').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-help');
      const pop = el(id);
      const isOpen = pop.style.display === 'block';
      document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
      pop.style.display = isOpen ? 'none' : 'block';
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
  });

  el('series').addEventListener('change', () => { state.selectedSeriesId = el('series').value; buildYearSelects(); updateDirectionText(); markDirty(); });

  el('fromYear').addEventListener('change', () => { updateDirectionText(); markDirty(); });
  el('toYear').addEventListener('change', () => { updateDirectionText(); markDirty(); });

  el('swapBtn').addEventListener('click', swapYears);
  el('calcBtn').addEventListener('click', () => { calculateAndRender(); });

  el('resetBtn').addEventListener('click', () => {
    el('amount').value = '';
    buildYearSelects();
    markDirty('Введите сумму, выберите годы и нажмите «Рассчитать».');
    el('resultValue').textContent = '—';
    el('summary').textContent = '—';
    el('diffValue').textContent = '—';
    el('pctValue').textContent = '—';
    el('factorValue').textContent = '—';
    el('rangeTag').textContent = '—';
    drawChart([]);
  });

  el('copyBtn').addEventListener('click', async () => {
    const txt = state.lastResultText || '';
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      el('status').textContent = 'Скопировано в буфер обмена.';
    } catch (e) {
      el('status').textContent = 'Не удалось скопировать (браузер ограничил доступ).';
    }
  });

  // modal help
  el('helpOpen').addEventListener('click', () => el('helpModal').style.display = 'flex');
  el('helpClose').addEventListener('click', () => el('helpModal').style.display = 'none');
  el('helpModal').addEventListener('click', (e) => {
    if (e.target === el('helpModal')) el('helpModal').style.display = 'none';
  });

  // nice spacing in amount input on blur
  el('amount').addEventListener('blur', () => {
    const input = el('amount');
    let raw = (input.value || '').replace(/\s+/g,'').replace(/\D/g,'');
    raw = raw.replace(/^0+(?=\d)/,'');
    if (!raw) {
      input.value = '0';
      markDirty();
      return;
    }
    input.value = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    markDirty();
  });

  el('amount').addEventListener('input', () => {
    const input = el('amount');
    const prev = input.value || '';
    const caret = (input.selectionStart ?? prev.length);

    // сколько цифр было слева от курсора
    const digitsLeft = prev.slice(0, caret).replace(/\D/g,'').length;

    // оставляем только цифры
    let raw = prev.replace(/\D/g,'');
    raw = raw.replace(/^0+(?=\d)/,'');
    // не форсируем 0 во время ввода, только на blur
    if (!raw) {
      input.value = '';
      markDirty(' ');
      return;
    }

    // форматируем разряды пробелами
    const formatted = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    input.value = formatted;

    // восстанавливаем позицию курсора по количеству цифр слева
    let pos = 0, count = 0;
    while (pos < input.value.length && count < digitsLeft) {
      if (/\d/.test(input.value[pos])) count++;
      pos++;
    }
    try { input.setSelectionRange(pos, pos); } catch (e) {}

    markDirty(' ');
  });

}

async function init(){
  try{
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.data = data;
    data.series.forEach(s => state.seriesById.set(s.id, s));

    buildSeriesSelect();
    buildYearSelects();
    bindUI();

    markDirty('Введите сумму, выберите годы и нажмите «Рассчитать».');
  } catch (err) {
    console.error(err);
    el('status').textContent = 'Не удалось загрузить данные. Проверьте, что сайт открыт через http:// (а не file://).';
  }
}

init();
