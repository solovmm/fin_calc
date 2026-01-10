
export function fmtNumber(n){
  if(!isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}
export function fmtMoney(n){
  if(!isFinite(n)) return "—";
  return fmtNumber(n) + " ₽";
}
export function fmtPercent(x, digits=1){
  if(!isFinite(x)) return "—";
  return (x*100).toFixed(digits) + "%";
}

export function parseMoneyInput(value){
  const digits = (value||"").toString().replace(/[^\d]/g,"");
  return digits ? parseInt(digits,10) : 0;
}

export function attachMoneyFormatter(inputEl){
  const onInput = () => {
    const val = parseMoneyInput(inputEl.value);
    // keep 0 as empty? user wants 0 visible, so show 0
    inputEl.value = new Intl.NumberFormat("ru-RU").format(val);
    inputEl.dataset.raw = String(val);
    inputEl.dispatchEvent(new CustomEvent("money:changed", {bubbles:true}));
  };
  inputEl.addEventListener("input", onInput);
  // init
  if(!inputEl.value) inputEl.value = "0";
  onInput();
}

export function getMoneyValue(inputEl){
  if(inputEl.dataset.raw) return parseInt(inputEl.dataset.raw,10) || 0;
  return parseMoneyInput(inputEl.value);
}

export function setMoneyValue(inputEl, n){
  const v = Math.max(0, Math.round(n||0));
  inputEl.value = new Intl.NumberFormat("ru-RU").format(v);
  inputEl.dataset.raw = String(v);
}

export function setupSegmented(segEl, initial){
  const buttons = [...segEl.querySelectorAll("button[data-value]")];
  const set = (v) => {
    buttons.forEach(b => b.classList.toggle("active", b.dataset.value===v));
    segEl.dataset.value = v;
    segEl.dispatchEvent(new CustomEvent("seg:changed", {detail:{value:v}, bubbles:true}));
  };
  buttons.forEach(b => b.addEventListener("click", ()=> set(b.dataset.value)));
  set(initial ?? buttons[0]?.dataset.value ?? "");
  return {get:()=>segEl.dataset.value, set};
}

let activeTooltip = null;

export function bindTooltips(root=document){
  root.querySelectorAll("[data-tt]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation();
      toggleTooltip(btn, btn.dataset.ttTitle || "", btn.dataset.tt || "");
    });
  });

  document.addEventListener("click", ()=>{
    hideTooltip();
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key==="Escape") hideTooltip();
  });
}

function hideTooltip(){
  if(activeTooltip){
    activeTooltip.remove();
    activeTooltip=null;
  }
}

function toggleTooltip(anchor, title, text){
  if(activeTooltip){
    activeTooltip.remove();
    activeTooltip=null;
  }
  const tt = document.createElement("div");
  tt.className="tooltip";
  tt.innerHTML = `
    ${title ? `<div class="tt-title">${escapeHtml(title)}</div>` : ""}
    <div>${escapeHtml(text)}</div>
    <div class="tt-muted" style="margin-top:6px">Нажмите ещё раз или Esc, чтобы закрыть.</div>
  `;
  document.body.appendChild(tt);

  const r = anchor.getBoundingClientRect();
  const pad = 10;
  let left = r.right + pad + window.scrollX;
  let top = r.top + window.scrollY - 6;

  // keep in viewport
  const maxLeft = window.scrollX + window.innerWidth - tt.offsetWidth - 12;
  if(left > maxLeft) left = Math.max(12+window.scrollX, r.left + window.scrollX - tt.offsetWidth - pad);
  const maxTop = window.scrollY + window.innerHeight - tt.offsetHeight - 12;
  if(top > maxTop) top = maxTop;
  if(top < window.scrollY + 12) top = window.scrollY + 12;

  tt.style.left = left + "px";
  tt.style.top = top + "px";

  activeTooltip = tt;
  // prevent outside click closing immediately
  tt.addEventListener("click", (e)=>e.stopPropagation());
  anchor.addEventListener("click", (e)=> e.stopPropagation(), {once:true});
}

function escapeHtml(s){
  return (s||"").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

export async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch{
    return false;
  }
}

// Simple stacked bar (no external libs)
export function drawStackBar(canvas, parts){
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.clearRect(0,0,w,h);

  const total = parts.reduce((a,p)=>a + (p.value||0), 0) || 1;
  const pad = 10 * devicePixelRatio;
  const barH = 16 * devicePixelRatio;
  const y = (h - barH) / 2;
  const x0 = pad;
  const x1 = w - pad;
  const bw = x1 - x0;

  // background
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  roundRect(ctx, x0, y, bw, barH, 10*devicePixelRatio);
  ctx.fill();

  // segments
  let x = x0;
  parts.forEach((p,i)=>{
    const segW = bw * ((p.value||0) / total);
    if(segW <= 1) return;
    ctx.fillStyle = p.color || (i%2 ? "rgba(139,92,246,0.65)" : "rgba(34,197,94,0.55)");
    roundRect(ctx, x, y, segW, barH, 10*devicePixelRatio);
    ctx.fill();
    x += segW;
  });

  // outline
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1 * devicePixelRatio;
  roundRect(ctx, x0, y, bw, barH, 10*devicePixelRatio);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}
