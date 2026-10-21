'use strict';

/* ================= Configuración ================= */
// N_MUESTRAS: muestras por defecto en un registro nuevo; MAX_MUESTRAS: tope al agregar muestras extra
const CFG = { PH_MIN: 6.0, PH_MAX: 9.0, T_MAX: 35, SED_MAX: 1000, N_MUESTRAS: 7, MAX_MUESTRAS: 20, DIAS_RESPALDO: 7 };
const MEDIDORES = [
  { k: 'm21', label: 'Medidor 21' },
  { k: 'm22', label: 'Medidor 22' },
  { k: 'm23', label: 'Medidor 23' },
  { k: 'm25', label: 'Medidor 25' },
];
const PARAMS = [
  { k: 'ph',   label: 'pH',          unit: '' },
  { k: 'temp', label: 'Temperatura', unit: '°C' },
  { k: 'sst',  label: 'SST',         unit: 'mg/L', title: 'Sólidos Suspendidos Totales' },
  { k: 'dqo',  label: 'DQO',         unit: 'mg/L', title: 'Demanda Química de Oxígeno' },
];
const NA = ['N/D', 'N/L'];
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)$/;
const BLOQUEO_INACTIVIDAD_MIN = 5;   // bloquear tras N minutos sin uso
const BLOQUEO_FONDO_MIN = 2;         // bloquear si la app estuvo en segundo plano más de N minutos

/* ================= Utilidades ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const addDays = (s, n) => { const d = fromISO(s); d.setDate(d.getDate() + n); return toISO(d); };
const isWeekend = s => { const g = fromISO(s).getDay(); return g === 0 || g === 6; };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtCorta = s => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const fmtLarga = s => cap(fromISO(s).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
const diaSemana = s => cap(fromISO(s).toLocaleDateString('es-MX', { weekday: 'long' }));
const fmtStamp = iso => new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtNum = n => n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
const round3 = n => Math.round(n * 1000) / 1000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => NUM_RE.test(String(v ?? ''));
const clone = o => JSON.parse(JSON.stringify(o));

function normalize(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  const u = s.toUpperCase().replace(/[\s.\-_\\]/g, '');
  if (u === 'ND' || u === 'N/D') return 'N/D';
  if (u === 'NL' || u === 'N/L') return 'N/L';
  s = s.replace(/[\s,]/g, '');            // separador de miles (formato México)
  if (/^-?\d+\.$/.test(s)) s = s.slice(0, -1);
  return s;
}

/* ================= Almacenamiento (cifrado, ver seguridad.js) ================= */
let state = null;
function initialState(datos) {
  const base = { registros: {}, borradores: {}, ultimoRespaldo: null, ultimoResponsable: '', ultimoFolio: '', eliminados: [] };
  return datos && typeof datos.registros === 'object' ? { ...base, ...datos } : base;
}
let persistQueue = Promise.resolve();
function saveState() {
  const texto = JSON.stringify(state);          // se toma la foto ahora; se cifra y escribe en orden
  persistQueue = persistQueue
    .then(() => Boveda.guardar(texto))
    .then(() => $('#storageWarn').classList.add('hidden'))
    .catch(() => {
      $('#storageWarn').classList.remove('hidden');
      toast('No se pudo guardar en el dispositivo. Descarga un respaldo.', true);
    });
  return true;
}

/* ================= Modelo del formulario ================= */
const emptySample = () => Object.fromEntries(PARAMS.map(p => [p.k, '']));
function emptyForm(n = CFG.N_MUESTRAS) {
  return {
    medidores: Object.fromEntries(MEDIDORES.map(m => [m.k, ''])),
    muestras: Array.from({ length: n }, emptySample),
    sedimentacion: '', folio: '', responsable: '', observaciones: '',
  };
}
/* Cada registro conserva su propio número de muestras (los antiguos pueden tener 6). */
function pickForm(rec) {
  const f = emptyForm(Math.max(1, rec.muestras?.length || CFG.N_MUESTRAS));
  MEDIDORES.forEach(m => f.medidores[m.k] = rec.medidores?.[m.k] ?? '');
  f.muestras.forEach((mu, i) => PARAMS.forEach(p => mu[p.k] = rec.muestras?.[i]?.[p.k] ?? ''));
  f.sedimentacion = rec.sedimentacion ?? '';
  f.folio = rec.folio ?? '';
  f.responsable = rec.responsable ?? '';
  f.observaciones = rec.observaciones ?? '';
  return f;
}
function allPaths(n = CFG.N_MUESTRAS) {
  return [
    ...MEDIDORES.map(m => `medidores.${m.k}`),
    ...Array.from({ length: n }, (_, i) => PARAMS.map(p => `muestras.${i}.${p.k}`)).flat(),
    'sedimentacion', 'folio', 'responsable', 'observaciones',
  ];
}
const TEXT_PATHS = ['folio', 'responsable', 'observaciones'];
const NUM_PATHS = n => allPaths(n).filter(p => !TEXT_PATHS.includes(p));
function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
function kindOf(p) { if (p.startsWith('medidores.')) return 'med'; if (p === 'sedimentacion') return 'sed'; return p.split('.')[2]; }
function fieldLabel(p) {
  if (p.startsWith('medidores.')) return MEDIDORES.find(m => `medidores.${m.k}` === p).label;
  if (p.startsWith('muestras.')) { const [, i, k] = p.split('.'); return `Muestra ${+i + 1} · ${PARAMS.find(x => x.k === k).label}`; }
  return { sedimentacion: 'Sedimentación 30 min', folio: 'Folio', responsable: 'Analista', observaciones: 'Observaciones' }[p];
}
function cleanForm(f) {
  const c = clone(f);
  NUM_PATHS(c.muestras.length).forEach(p => setPath(c, p, normalize(getPath(c, p))));
  c.folio = String(c.folio || '').trim();
  c.responsable = String(c.responsable || '').trim();
  c.observaciones = String(c.observaciones || '').trim();
  return c;
}
const formKey = f => JSON.stringify(cleanForm(f));

/* ================= Validación ================= */
function prevReading(fecha, k) {
  const ds = Object.keys(state.registros).filter(d => d < fecha).sort().reverse();
  for (const d of ds) { const v = state.registros[d].medidores?.[k]; if (isNum(v)) return { fecha: d, n: Number(v) }; }
  return null;
}
function checkField(kind, v, ctx) {
  if (v === '') return { s: 'empty', msg: 'falta la lectura' };
  if (NA.includes(v)) return { s: 'na' };
  if (!isNum(v)) return { s: 'invalid', msg: `"${v}" no es un número válido (usa N/D o N/L si no hay dato)` };
  const n = Number(v);
  switch (kind) {
    case 'ph':
      if (n < 0 || n > 14) return { s: 'warn', msg: `pH ${v} fuera de la escala (0 a 14)` };
      if (n < CFG.PH_MIN || n > CFG.PH_MAX) return { s: 'warn', msg: `pH ${v} fuera de rango (${CFG.PH_MIN.toFixed(1)} a ${CFG.PH_MAX.toFixed(1)})` };
      break;
    case 'temp':
      if (n > CFG.T_MAX) return { s: 'warn', msg: `${v} °C excede el máximo de ${CFG.T_MAX} °C` };
      if (n < 0) return { s: 'warn', msg: `${v} °C está por debajo de 0 °C` };
      break;
    case 'sst': case 'dqo':
      if (n < 0) return { s: 'warn', msg: `${v} mg/L es un valor negativo` };
      break;
    case 'sed':
      if (n < 0) return { s: 'warn', msg: `${v} mL/L es un valor negativo` };
      if (n > CFG.SED_MAX) return { s: 'warn', msg: `${v} mL/L supera ${CFG.SED_MAX} mL/L` };
      break;
    case 'med':
      if (n < 0) return { s: 'warn', msg: `${v} m³ es un valor negativo` };
      if (ctx?.prev && n < ctx.prev.n) return { s: 'warn', msg: `${v} m³ es menor que la lectura anterior (${fmtNum(ctx.prev.n)} m³ del ${fmtCorta(ctx.prev.fecha)})` };
      break;
  }
  return { s: 'ok' };
}
function validateForm(form, fecha) {
  const byPath = {}, empty = [], invalid = [], warn = [];
  NUM_PATHS(form.muestras.length).forEach(p => {
    const kind = kindOf(p);
    const ctx = kind === 'med' && fecha ? { prev: prevReading(fecha, p.split('.')[1]) } : null;
    const r = checkField(kind, normalize(getPath(form, p)), ctx);
    byPath[p] = r;
    const item = { p, label: fieldLabel(p), msg: r.msg, text: `${fieldLabel(p)}: ${r.msg}` };
    if (r.s === 'empty') empty.push(item);
    else if (r.s === 'invalid') invalid.push(item);
    else if (r.s === 'warn') warn.push(item);
  });
  return { byPath, empty, invalid, warn };
}
/* Alertas de un registro guardado (para historial y exportaciones) */
function recordChecks(rec) { return validateForm(pickForm(rec), rec.fecha); }

/* ================= Construcción de la interfaz ================= */
function buildForm() {
  $('#meters').innerHTML = MEDIDORES.map(m => `
    <div class="meter">
      <label for="f-${m.k}">${m.label}</label>
      <div class="input-unit"><input id="f-${m.k}" class="inp" data-f="medidores.${m.k}" data-kind="med" inputmode="decimal" autocomplete="off"><span>m³</span></div>
      <div class="quick"><button type="button" class="chip" data-fill="N/D">N/D</button><button type="button" class="chip" data-fill="N/L">N/L</button></div>
      <div class="hint" id="h-${m.k}"></div>
    </div>`).join('');

  const head = `<thead><tr><th>Muestra</th>${PARAMS.map(p => `<th title="${esc(p.title || '')}">${p.label}${p.unit ? ` <small>(${p.unit})</small>` : ''}</th>`).join('')}<th style="text-align:right"><small>Llenar fila</small></th></tr></thead>`;
  $('#samples').innerHTML = head + '<tbody></tbody>';
  renderSamples(CFG.N_MUESTRAS);
}

/* ================= Muestras (7 por defecto + extras) ================= */
let nMuestras = CFG.N_MUESTRAS;     // filas que se muestran ahora
let minMuestras = CFG.N_MUESTRAS;   // no se pueden quitar filas por debajo de este número

function renderSamples(n) {
  nMuestras = n;
  $('#samples tbody').innerHTML = Array.from({ length: n }, (_, i) => `
    <tr${i >= CFG.N_MUESTRAS ? ' class="extra"' : ''}><th>Muestra ${i + 1}${i >= CFG.N_MUESTRAS ? ' <span class="tag-extra">extra</span>' : ''}</th>
      ${PARAMS.map(p => `<td data-label="${p.label}${p.unit ? ` (${p.unit})` : ''}"><input class="inp" data-f="muestras.${i}.${p.k}" data-kind="${p.k}" inputmode="decimal" autocomplete="off" aria-label="Muestra ${i + 1} ${p.label}"></td>`).join('')}
      <td class="rowfill"><div class="rowq"><button type="button" class="chip" data-rowfill="${i}" data-v="N/D">N/D</button><button type="button" class="chip" data-rowfill="${i}" data-v="N/L">N/L</button>${i === n - 1 && n > minMuestras ? '<button type="button" class="chip quitar" id="btnQuitarMuestra" title="Quitar esta muestra">Quitar</button>' : ''}</div></td>
    </tr>`).join('');
  const extra = Math.max(0, n - CFG.N_MUESTRAS);
  $('#muestrasInfo').textContent = `${n} muestras` + (extra ? ` (${extra} extra)` : '');
  $('#btnAddMuestra').disabled = n >= CFG.MAX_MUESTRAS;
}

function agregarMuestra() {
  if (nMuestras >= CFG.MAX_MUESTRAS) { toast(`Máximo ${CFG.MAX_MUESTRAS} muestras por registro`, true); return; }
  const f = readForm();
  f.muestras.push(emptySample());
  setForm(f);
  refresh(); scheduleDraft();
  const nueva = $(`#tab-captura [data-f="muestras.${nMuestras - 1}.${PARAMS[0].k}"]`);
  nueva.scrollIntoView({ block: 'center', behavior: 'smooth' });
  nueva.focus({ preventScroll: true });
}

async function quitarMuestra() {
  if (nMuestras <= minMuestras) return;
  const f = readForm();
  const ultima = f.muestras[f.muestras.length - 1];
  if (PARAMS.some(p => String(ultima[p.k]).trim())) {
    const r = await modal({ title: `Quitar la muestra ${nMuestras}`, html: '<p>Se borrarán los datos capturados en esta muestra.</p>', ok: 'Quitar', danger: true });
    if (!r.ok) return;
  }
  f.muestras.pop();
  setForm(f);
  refresh(); scheduleDraft();
}

function readForm() {
  const f = emptyForm(nMuestras);
  $$('#tab-captura [data-f]').forEach(el => setPath(f, el.dataset.f, el.value));
  return f;
}
function setForm(f) {
  if (f.muestras.length !== nMuestras) renderSamples(f.muestras.length);
  $$('#tab-captura [data-f]').forEach(el => { el.value = getPath(f, el.dataset.f) ?? ''; });
}

/* ================= Estado de captura ================= */
let baseline = emptyForm();
let showEmpty = false;
const curDate = () => $('#fecha').value;
const isDirty = () => formKey(readForm()) !== formKey(baseline);

function loadDate(f) {
  showEmpty = false;
  const rec = state.registros[f];
  // Los registros guardados conservan sus muestras; los nuevos empiezan con CFG.N_MUESTRAS.
  minMuestras = rec ? Math.min(rec.muestras.length, CFG.N_MUESTRAS) : CFG.N_MUESTRAS;
  baseline = rec ? pickForm(rec) : { ...emptyForm(), folio: state.ultimoFolio || '', responsable: state.ultimoResponsable || '' };
  nMuestras = -1;                     // obliga a redibujar (cambia el botón "Quitar")
  const dr = state.borradores[f];
  setForm(dr ? dr.form : baseline);
  refresh();
}

function refresh() {
  const f = curDate();
  const res = validateForm(readForm(), f);

  // Estilo de cada campo
  $$('#tab-captura [data-kind]').forEach(el => {
    const r = res.byPath[el.dataset.f];
    const err = r.s === 'invalid' || (showEmpty && r.s === 'empty');
    el.classList.toggle('is-warn', r.s === 'warn');
    el.classList.toggle('is-err', err);
    el.classList.toggle('is-na', r.s === 'na');
    el.title = r.msg && r.s !== 'empty' ? r.msg : '';
    el.setAttribute('aria-invalid', err ? 'true' : 'false');
  });

  // Lectura anterior y consumo por medidor
  const form = readForm();
  MEDIDORES.forEach(m => {
    const prev = f ? prevReading(f, m.k) : null;
    const v = normalize(form.medidores[m.k]);
    let h = prev ? `Anterior: <b>${fmtNum(prev.n)}</b> (${fmtCorta(prev.fecha).slice(0, 5)})` : 'Sin lectura anterior';
    if (prev && isNum(v)) { const c = round3(Number(v) - prev.n); h += ` · Consumo: <b>${c >= 0 ? '+' : ''}${fmtNum(c)}</b> m³`; }
    $(`#h-${m.k}`).innerHTML = h;
  });

  // Lista de alertas
  const items = [
    ...res.invalid.map(x => ({ c: 'e', ic: '!', p: x.p, t: x.text })),
    ...res.warn.map(x => ({ c: 'w', ic: '▲', p: x.p, t: x.text })),
  ];
  if (showEmpty && res.empty.length) items.unshift({ c: 'e', ic: '!', p: res.empty[0].p, t: `Faltan ${res.empty.length} lectura(s): ${res.empty.map(x => x.label).join(', ')}` });
  if (f && isWeekend(f)) items.push({ c: 'w', ic: '▲', t: `${diaSemana(f)}: la bitácora se llena de lunes a viernes.` });
  $('#alertList').innerHTML = items.length
    ? items.map(x => `<li class="${x.c}" ${x.p ? `data-goto="${x.p}"` : ''}><span class="ic">${x.ic}</span><span>${esc(x.t)}</span></li>`).join('')
    : '<li class="ok"><span class="ic">✓</span><span>Sin alertas. Todos los valores capturados están dentro de rango.</span></li>';

  // Barra de guardado
  const total = NUM_PATHS(nMuestras).length, filled = total - res.empty.length;
  const parts = [`<b>${filled}/${total}</b> lecturas capturadas`];
  if (res.warn.length) parts.push(`<b style="color:var(--warn)">${res.warn.length}</b> fuera de rango`);
  if (res.invalid.length) parts.push(`<b style="color:var(--err)">${res.invalid.length}</b> no válidas`);
  $('#saveSum').innerHTML = parts.join(' · ');

  renderStatus();
  return res;
}

function renderStatus() {
  const f = curDate();
  if (!f) return;
  const rec = state.registros[f], dirty = isDirty();
  $('#fechaLarga').textContent = fmtLarga(f);
  const pills = [];
  if (rec) pills.push(`<span class="pill ok">✓ Guardado · ${fmtStamp(rec.modificado)}</span>`);
  else pills.push('<span class="pill">Nuevo registro</span>');
  if (dirty) pills.push(`<span class="pill warn">${rec ? 'Cambios sin guardar' : 'Borrador sin guardar'}</span>`);
  if (rec?.cambios?.length) pills.push(`<span class="pill">${rec.cambios.length} corrección(es)</span>`);
  if (isWeekend(f)) pills.push('<span class="pill warn">Fin de semana</span>');
  $('#estado').innerHTML = pills.join('');
  $('#avisoBorrador').classList.toggle('hidden', !(dirty && state.borradores[f]));
  $('#btnGuardar').textContent = rec ? 'Guardar cambios' : 'Guardar registro';
  $('#btnXlsxDia').disabled = $('#btnPdfDia').disabled = !rec;
  $('#btnXlsxDia').title = $('#btnPdfDia').title = rec ? 'Exportar este día' : 'Guarda el registro para exportarlo';
}

let draftTimer = null;
function writeDraft() {
  draftTimer = null;
  const f = curDate(); if (!f || !state) return;
  if (isDirty()) state.borradores[f] = { form: readForm(), ts: new Date().toISOString() };
  else delete state.borradores[f];
  saveState();
  renderStatus();
}
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 350);
}
function flushDraft() {
  if (draftTimer) { clearTimeout(draftTimer); writeDraft(); }
}

/* ================= Guardar ================= */
function diffForms(a, b) {
  const na = a.muestras.length, nb = b.muestras.length;
  const comunes = allPaths(Math.min(na, nb)).flatMap(p => {
    const x = String(getPath(a, p) ?? '').trim(), y = String(getPath(b, p) ?? '').trim();
    return x !== y ? [`${fieldLabel(p)}: ${x || '(vacío)'} → ${y || '(vacío)'}`] : [];
  });
  const resumen = mu => PARAMS.map(p => `${p.label} ${mu[p.k] || '—'}`).join(', ');
  const agregadas = b.muestras.slice(na).map((mu, j) => `Se agregó la muestra ${na + j + 1} (${resumen(mu)})`);
  const quitadas = a.muestras.slice(nb).map((mu, j) => `Se quitó la muestra ${nb + j + 1} (${resumen(mu)})`);
  return [...comunes, ...agregadas, ...quitadas];
}

async function guardar() {
  const f = curDate();
  if (!f) { toast('Selecciona la fecha del registro', true); return; }
  const form = cleanForm(readForm());
  setForm(form);
  showEmpty = true;
  const res = refresh();

  if (res.empty.length || res.invalid.length) {
    let html = '';
    if (res.empty.length) html += `<div class="box e"><b>Faltan ${res.empty.length} lectura(s):</b><ul>${res.empty.map(x => `<li>${esc(x.label)}</li>`).join('')}</ul></div>`;
    if (res.invalid.length) html += `<div class="box e"><b>Valores no válidos:</b><ul>${res.invalid.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></div>`;
    html += '<p>Si un dato no existe, escribe <b>N/D</b> (No Disponible) o <b>N/L</b> (No Laborable).</p>';
    await modal({ title: 'No se puede guardar el registro', html, ok: 'Entendido', cancel: null });
    focusPath((res.empty[0] || res.invalid[0]).p);
    return;
  }

  const rec = state.registros[f];
  const cambios = rec ? diffForms(pickForm(rec), form) : [];
  if (rec && !cambios.length) { toast('No hay cambios que guardar'); return; }

  let motivo = '';
  if (rec || res.warn.length || isWeekend(f)) {
    let html = `<p>Fecha del registro: <b>${esc(fmtLarga(f))}</b></p>`;
    if (isWeekend(f)) html += `<div class="box w">La fecha es ${esc(diaSemana(f).toLowerCase())}; la bitácora normalmente se llena de lunes a viernes.</div>`;
    if (res.warn.length) html += `<div class="box w"><b>${res.warn.length} valor(es) fuera de rango:</b><ul>${res.warn.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>Verifica la lectura. Si es correcta, puedes guardarla; quedará marcada como alerta.</div>`;
    if (rec) html += `<p><b>Cambios respecto al registro guardado:</b></p><ul>${cambios.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`;
    const r = await modal({
      title: rec ? 'Guardar cambios' : 'Confirmar registro', html, ok: 'Guardar',
      input: rec ? { label: 'Motivo del cambio (obligatorio)', required: true } : null,
    });
    if (!r.ok) return;
    motivo = r.value;
  }

  const now = new Date().toISOString();
  state.registros[f] = {
    fecha: f, ...form,
    alertas: res.warn.map(x => x.text),
    creado: rec?.creado || now,
    modificado: now,
    cambios: rec ? [...(rec.cambios || []), { fecha: now, motivo, detalle: cambios }] : [],
  };
  delete state.borradores[f];
  if (form.responsable) state.ultimoResponsable = form.responsable;
  if (form.folio) state.ultimoFolio = form.folio;
  if (!saveState()) return;
  baseline = pickForm(state.registros[f]);
  showEmpty = false;
  refresh();
  renderHistory();
  toast(rec ? 'Cambios guardados' : `Registro del ${fmtCorta(f)} guardado`);
}

function focusPath(p) {
  const el = $(`#tab-captura [data-f="${p}"]`);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
}

/* ================= Historial ================= */
function rangeDates() {
  const from = $('#hDesde').value, to = $('#hHasta').value;
  return Object.keys(state.registros).filter(d => (!from || d >= from) && (!to || d <= to)).sort();
}
function setRange(from, to) {
  $('#hDesde').value = from || ''; $('#hHasta').value = to || '';
  $('#hMes').value = from && to && from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthEnd(from.slice(0, 7)) ? from.slice(0, 7) : '';
  renderHistory();
}
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return toISO(new Date(y, m, 0)); }
function applyPreset(p) {
  const t = todayISO();
  if (p === 'mes') setRange(t.slice(0, 7) + '-01', monthEnd(t.slice(0, 7)));
  else if (p === 'mesant') { const d = fromISO(t); d.setDate(1); d.setMonth(d.getMonth() - 1); const ym = toISO(d).slice(0, 7); setRange(ym + '-01', monthEnd(ym)); }
  else if (p === '7') setRange(addDays(t, -6), t);
  else setRange('', '');
}

function cellVal(v, warn) {
  if (v === '' || v == null) return '<span style="color:var(--mu)">—</span>';
  if (NA.includes(v)) return `<span class="tag">${v}</span>`;
  return warn ? `<span class="vwarn" title="Fuera de rango">${esc(v)}</span>` : esc(v);
}

function renderHistory() {
  const dates = rangeDates();
  const from = $('#hDesde').value, to = $('#hHasta').value;
  const conAlerta = dates.filter(d => recordChecks(state.registros[d]).warn.length).length;

  // Días hábiles sin registro en el periodo (hasta hoy)
  const missing = [];
  const start = from || dates[0], end = [to || todayISO(), todayISO()].sort()[0];
  if (start && end && start <= end) {
    let n = 0;
    for (let d = start; d <= end && n < 400; d = addDays(d, 1), n++) if (!isWeekend(d) && !state.registros[d]) missing.push(d);
  }
  $('#hStats').innerHTML = `
    <div class="stat"><b>${dates.length}</b><span>registros en el periodo</span></div>
    <div class="stat"><b>${conAlerta}</b><span>días con alertas</span></div>
    <div class="stat"><b>${missing.length}</b><span>días hábiles sin registro</span></div>`;
  $('#hMissing').innerHTML = missing.length
    ? `<span>Sin registro:</span>${missing.slice(0, 40).map(d => `<button class="chip" data-open="${d}" title="Capturar ${fmtLarga(d)}">${fmtCorta(d).slice(0, 5)}</button>`).join('')}${missing.length > 40 ? `<span>y ${missing.length - 40} más</span>` : ''}`
    : '';

  $('#btnXlsxRango').disabled = $('#btnPdfRango').disabled = !dates.length;
  if (!dates.length) {
    $('#hTable').innerHTML = `<tbody><tr><td class="empty">${Object.keys(state.registros).length ? 'No hay registros en el periodo seleccionado.' : 'Aún no hay registros guardados. Empieza en <b>Captura diaria</b>.'}</td></tr></tbody>`;
    return;
  }
  const head = `<thead><tr><th>Fecha</th>${MEDIDORES.map(m => `<th class="n">${m.label.replace('Medidor', 'Med.')} <small style="font-weight:400">m³</small></th>`).join('')}<th class="n">Sed. 30 min</th><th>Alertas</th><th>Analista</th><th></th></tr></thead>`;
  const rows = dates.slice().reverse().map(d => {
    const r = state.registros[d], chk = recordChecks(r), w = chk.warn.length;
    const wb = p => chk.byPath[p]?.s === 'warn';
    return `<tr class="row" data-d="${d}">
      <td class="h-fecha"><b>${fmtCorta(d)}</b><small>${diaSemana(d)}${r.folio ? ` · Folio ${esc(r.folio)}` : ''}${r.cambios?.length ? ' · corregido' : ''}</small></td>
      ${MEDIDORES.map(m => `<td class="n" data-label="${m.label} (m³)">${cellVal(r.medidores[m.k], wb('medidores.' + m.k))}</td>`).join('')}
      <td class="n" data-label="Sed. 30 min (mL/L)">${cellVal(r.sedimentacion, wb('sedimentacion'))}</td>
      <td class="h-alertas" data-label="Alertas">${w ? `<span class="badge w" title="${esc(chk.warn.map(x => x.text).join('\n'))}">▲ ${w}</span>` : '<span class="badge ok">✓</span>'}</td>
      <td class="h-resp" data-label="Analista">${esc(r.responsable) || '<span style="color:var(--mu)">—</span>'}</td>
      <td class="h-acts"><div class="acts">
        <button class="btn sm" data-act="open" title="Abrir en captura">Abrir</button>
        <button class="btn sm ghost" data-act="xlsx" title="Excel del día">XLSX</button>
        <button class="btn sm ghost" data-act="pdf" title="PDF del día">PDF</button>
        <button class="btn sm ghost" data-act="del" title="Eliminar registro" style="color:var(--err)">✕</button>
      </div></td></tr>
      <tr class="detail hidden" data-detail="${d}"><td colspan="${MEDIDORES.length + 5}">${detailHTML(r, chk)}</td></tr>`;
  }).join('');
  $('#hTable').innerHTML = head + `<tbody>${rows}</tbody>`;
}

function detailHTML(r, chk) {
  const t = `<table class="mini"><thead><tr><th>Muestra</th>${PARAMS.map(p => `<th>${p.label}${p.unit ? `<br><small>${p.unit}</small>` : ''}</th>`).join('')}</tr></thead><tbody>
    ${r.muestras.map((mu, i) => `<tr><td>${i + 1}</td>${PARAMS.map(p => `<td>${cellVal(mu[p.k], chk.byPath[`muestras.${i}.${p.k}`]?.s === 'warn')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let side = '';
  if (chk.warn.length) side += `<p class="lbl">Alertas</p><ul style="margin:0 0 10px;padding-left:18px;font-size:13px;color:var(--warn)">${chk.warn.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>`;
  side += `<p><span class="lbl">Folio:</span> ${esc(r.folio) || '—'} · <span class="lbl">Analista:</span> ${esc(r.responsable) || '—'}</p>`;
  side += `<p><span class="lbl">Observaciones:</span> ${esc(r.observaciones) || '—'}</p>`;
  side += `<p><span class="lbl">Capturado:</span> ${fmtStamp(r.creado)}${r.modificado !== r.creado ? ` · <span class="lbl">Modificado:</span> ${fmtStamp(r.modificado)}` : ''}</p>`;
  if (r.cambios?.length) side += `<p class="lbl" style="margin-top:10px">Historial de correcciones</p>${r.cambios.map(c => `<p style="font-size:13px"><b>${fmtStamp(c.fecha)}</b> — ${esc(c.motivo)}<br><span style="color:var(--mu)">${c.detalle.map(esc).join('<br>')}</span></p>`).join('')}`;
  return `<div class="dgrid"><div class="table-wrap">${t}</div><div>${side}</div></div>`;
}

function openDate(d) {
  $('#fecha').value = d;
  loadDate(d);
  showTab('captura');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function eliminar(d) {
  const r = await modal({
    title: 'Eliminar registro',
    html: `<p>Se eliminará el registro del <b>${esc(fmtLarga(d))}</b>. Esta acción no se puede deshacer.</p><p class="sub">Sugerencia: descarga un respaldo antes de eliminar.</p>`,
    ok: 'Eliminar', danger: true,
    input: { label: 'Motivo de la eliminación (obligatorio)', required: true },
  });
  if (!r.ok) return;
  state.eliminados = state.eliminados || [];
  state.eliminados.push({ fecha: new Date().toISOString(), registro: d, motivo: r.value });
  delete state.registros[d];
  saveState();
  renderHistory();
  if (curDate() === d) loadDate(d);
  toast('Registro eliminado');
}

/* ================= Exportación ================= */
function consumo(rec, k) {
  const v = rec.medidores?.[k], prev = prevReading(rec.fecha, k);
  return isNum(v) && prev ? round3(Number(v) - prev.n) : '';
}
const xv = v => isNum(v) ? Number(v) : (v ?? '');

function exportXLSX(dates, fileBase) {
  if (typeof XLSX === 'undefined') { toast('No se cargó el módulo de Excel', true); return; }
  const recs = dates.map(d => state.registros[d]);
  const wb = XLSX.utils.book_new();

  const h1 = ['Fecha', 'Día', 'Folio', ...MEDIDORES.map(m => `${m.label} (m³)`), ...MEDIDORES.map(m => `Consumo ${m.label.replace('Medidor ', 'M')} (m³)`), 'Sedimentación 30 min (mL/L)', 'Analista', 'Observaciones', 'Alertas'];
  const rows1 = recs.map(r => [
    fmtCorta(r.fecha), diaSemana(r.fecha), r.folio || '',
    ...MEDIDORES.map(m => xv(r.medidores[m.k])),
    ...MEDIDORES.map(m => consumo(r, m.k)),
    xv(r.sedimentacion), r.responsable || '', r.observaciones || '',
    recordChecks(r).warn.map(x => x.text).join('; '),
  ]);
  const ws1 = XLSX.utils.aoa_to_sheet([h1, ...rows1]);
  ws1['!cols'] = [{ wch: 11 }, { wch: 10 }, { wch: 10 }, ...MEDIDORES.map(() => ({ wch: 15 })), ...MEDIDORES.map(() => ({ wch: 15 })), { wch: 18 }, { wch: 22 }, { wch: 34 }, { wch: 60 }];
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows1.length, c: h1.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws1, 'Medidores y sedimentación');

  const h2 = ['Fecha', 'Muestra', 'pH', 'Temperatura (°C)', 'SST (mg/L)', 'DQO (mg/L)', 'Alertas'];
  const rows2 = recs.flatMap(r => {
    const chk = recordChecks(r);
    return r.muestras.map((mu, i) => [
      fmtCorta(r.fecha), i + 1, ...PARAMS.map(p => xv(mu[p.k])),
      PARAMS.filter(p => chk.byPath[`muestras.${i}.${p.k}`]?.s === 'warn').map(p => chk.byPath[`muestras.${i}.${p.k}`].msg).join('; '),
    ]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet([h2, ...rows2]);
  ws2['!cols'] = [{ wch: 11 }, { wch: 9 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 50 }];
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows2.length, c: h2.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws2, 'Calidad de agua');

  const corr = recs.flatMap(r => (r.cambios || []).map(c => [fmtCorta(r.fecha), fmtStamp(c.fecha), c.motivo, c.detalle.join('; ')]));
  if (corr.length) {
    const ws3 = XLSX.utils.aoa_to_sheet([['Fecha del registro', 'Fecha de corrección', 'Motivo', 'Detalle'], ...corr]);
    ws3['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 40 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Correcciones');
  }
  const datos = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  entregarArchivo(new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`);
}

/* --- PDF --- */
const C_DK = [8, 49, 42], C_AC = [0, 228, 124], C_TX = [16, 36, 31], C_MU = [90, 107, 102];
const W_STYLE = { fillColor: [255, 236, 179], textColor: [122, 74, 0], fontStyle: 'bold' };
const NA_STYLE = { textColor: [110, 125, 120], fontStyle: 'italic' };

/* Las fuentes estándar del PDF no incluyen algunos símbolos Unicode */
const pdfSafe = s => String(s ?? '').replace(/→/g, '->').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

function newPDF(orientation) {
  if (!window.jspdf?.jsPDF) { toast('No se cargó el módulo de PDF', true); return null; }
  return new window.jspdf.jsPDF({ orientation, unit: 'mm', format: 'letter' });
}
function pdfHeader(doc, subtitle) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...C_DK); doc.rect(0, 0, w, 22, 'F');
  doc.setFillColor(...C_AC); doc.rect(0, 22, w, 1.3, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('Bitácora de Agua', 14, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(185, 230, 210);
  doc.text(subtitle, 14, 17.2);
  return 32;
}
function pdfFooters(doc) {
  const n = doc.getNumberOfPages(), w = doc.internal.pageSize.getWidth(), h = doc.internal.pageSize.getHeight();
  const gen = `Generado el ${fmtStamp(new Date().toISOString())}`;
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(215, 226, 222); doc.line(14, h - 12, w - 14, h - 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C_MU);
    doc.text(`Bitácora de Agua · ${gen}`, 14, h - 7);
    doc.text(`Página ${i} de ${n}`, w - 14, h - 7, { align: 'right' });
  }
}
function pdfTitle(doc, text, y) {
  const h = doc.internal.pageSize.getHeight();
  if (y > h - 40) { doc.addPage(); y = 18; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...C_DK);
  doc.text(text, 14, y);
  return y + 2.5;
}
const tableBase = {
  theme: 'grid', margin: { left: 14, right: 14, top: 16, bottom: 18 },
  styles: { fontSize: 9, cellPadding: 1.8, textColor: C_TX, lineColor: [215, 226, 222], lineWidth: 0.2 },
  headStyles: { fillColor: C_DK, textColor: [255, 255, 255], fontStyle: 'bold' },
  alternateRowStyles: { fillColor: [246, 250, 248] },
};
function pc(v, warn, extra) {
  if (v === '' || v == null) return { content: '-', styles: { halign: 'center', textColor: C_MU } };
  const st = { halign: 'right', ...(NA.includes(v) ? NA_STYLE : {}), ...(warn ? W_STYLE : {}) };
  return { content: String(v) + (extra || ''), styles: st };
}

function exportPDFDia(d) {
  const r = state.registros[d]; if (!r) return;
  const doc = newPDF('portrait'); if (!doc) return;
  const chk = recordChecks(r), wb = p => chk.byPath[p]?.s === 'warn';
  let y = pdfHeader(doc, 'Registro diario · Medidores, calidad de agua y sedimentación');

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...C_TX);
  doc.text(fmtLarga(d), 14, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C_MU);
  doc.text(`Folio: ${pdfSafe(r.folio) || '-'}   ·   Analista: ${pdfSafe(r.responsable) || '-'}   ·   Capturado: ${fmtStamp(r.creado)}${r.modificado !== r.creado ? `   ·   Modificado: ${fmtStamp(r.modificado)}` : ''}`, 14, y + 5.5);
  y += 14;

  y = pdfTitle(doc, '1. Medidores de agua', y);
  doc.autoTable({ ...tableBase, startY: y,
    head: [['Medidor', 'Lectura (m³)', 'Lectura anterior (m³)', 'Consumo (m³)']],
    body: MEDIDORES.map(m => {
      const prev = prevReading(d, m.k), c = consumo(r, m.k);
      return [m.label, pc(r.medidores[m.k], wb('medidores.' + m.k)), pc(prev ? `${fmtNum(prev.n)} (${fmtCorta(prev.fecha)})` : ''), pc(c === '' ? '' : (c >= 0 ? '+' : '') + fmtNum(c))];
    }),
  });
  y = doc.lastAutoTable.finalY + 9;

  y = pdfTitle(doc, '2. Calidad de agua en muestras', y);
  doc.autoTable({ ...tableBase, startY: y,
    head: [['Muestra', ...PARAMS.map(p => p.label + (p.unit ? ` (${p.unit})` : ''))]],
    body: r.muestras.map((mu, i) => [`Muestra ${i + 1}`, ...PARAMS.map(p => pc(mu[p.k], wb(`muestras.${i}.${p.k}`)))]),
  });
  y = doc.lastAutoTable.finalY + 9;

  y = pdfTitle(doc, '3. Prueba de sedimentación', y);
  doc.autoTable({ ...tableBase, startY: y, head: [['Parámetro', 'Valor']],
    body: [['Volumen de sedimentación a 30 min (mL/L)', pc(r.sedimentacion, wb('sedimentacion'))]],
    columnStyles: { 0: { cellWidth: 110 } } });
  y = doc.lastAutoTable.finalY + 9;

  if (chk.warn.length) {
    y = pdfTitle(doc, 'Alertas (valores fuera de rango)', y);
    doc.autoTable({ ...tableBase, startY: y, body: chk.warn.map(x => [x.text]), styles: { ...tableBase.styles, textColor: [122, 74, 0], fillColor: [255, 246, 222] }, alternateRowStyles: {} });
    y = doc.lastAutoTable.finalY + 9;
  }
  y = pdfTitle(doc, 'Observaciones', y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C_TX);
  const obs = doc.splitTextToSize(pdfSafe(r.observaciones) || 'Sin observaciones.', doc.internal.pageSize.getWidth() - 28);
  doc.text(obs, 14, y + 3.5);
  y += 6 + obs.length * 4.2;

  if (r.cambios?.length) {
    y = pdfTitle(doc, 'Historial de correcciones', y + 3);
    doc.autoTable({ ...tableBase, startY: y, head: [['Fecha', 'Motivo', 'Detalle']],
      body: r.cambios.map(c => [fmtStamp(c.fecha), pdfSafe(c.motivo), pdfSafe(c.detalle.join('\n'))]),
      columnStyles: { 0: { cellWidth: 32 }, 1: { cellWidth: 50 } }, styles: { ...tableBase.styles, fontSize: 8 } });
    y = doc.lastAutoTable.finalY + 6;
  }

  // Firmas
  const h = doc.internal.pageSize.getHeight(), w = doc.internal.pageSize.getWidth();
  if (y + 20 > h - 16) { doc.addPage(); y = 20; }
  y = Math.max(y + 14, h - 40);
  doc.setDrawColor(...C_MU);
  doc.line(24, y, 94, y); doc.line(w - 94, y, w - 24, y);
  doc.setFontSize(9); doc.setTextColor(...C_MU);
  doc.text('Realizó (nombre y firma)', 59, y + 4.5, { align: 'center' });
  doc.text('Revisó (nombre y firma)', w - 59, y + 4.5, { align: 'center' });

  pdfFooters(doc);
  entregarArchivo(doc.output('blob'), `Bitacora_Agua_${d}.pdf`);
}

function exportPDFRango(dates, label, fileBase) {
  const doc = newPDF('landscape'); if (!doc) return;
  const recs = dates.map(d => state.registros[d]);
  let y = pdfHeader(doc, `Reporte del periodo ${label} · ${recs.length} registro(s)`);

  y = pdfTitle(doc, 'Medidores de agua y sedimentación', y);
  doc.autoTable({ ...tableBase, startY: y, styles: { ...tableBase.styles, fontSize: 8.5 },
    head: [['Fecha', 'Día', 'Folio', ...MEDIDORES.map(m => `${m.label} (m³)`), 'Sed. 30 min (mL/L)', 'Alertas', 'Analista']],
    body: recs.map(r => {
      const chk = recordChecks(r), wb = p => chk.byPath[p]?.s === 'warn';
      return [fmtCorta(r.fecha), diaSemana(r.fecha), pdfSafe(r.folio) || '-',
        ...MEDIDORES.map(m => { const c = consumo(r, m.k); return pc(r.medidores[m.k], wb('medidores.' + m.k), c === '' ? '' : `\n(${c >= 0 ? '+' : ''}${fmtNum(c)})`); }),
        pc(r.sedimentacion, wb('sedimentacion')),
        { content: chk.warn.length ? String(chk.warn.length) : '-', styles: { halign: 'center', ...(chk.warn.length ? W_STYLE : { textColor: C_MU }) } },
        pdfSafe(r.responsable) || '-'];
    }),
  });
  y = doc.lastAutoTable.finalY + 3;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...C_MU);
  doc.text('Entre paréntesis: consumo respecto a la lectura anterior registrada.', 14, y + 2);
  y += 10;

  y = pdfTitle(doc, 'Calidad de agua en muestras', y);
  doc.autoTable({ ...tableBase, startY: y, rowPageBreak: 'avoid', styles: { ...tableBase.styles, fontSize: 8.5 }, alternateRowStyles: {},
    head: [['Fecha', 'Muestra', ...PARAMS.map(p => p.label + (p.unit ? ` (${p.unit})` : ''))]],
    body: recs.flatMap(r => {
      const chk = recordChecks(r);
      return r.muestras.map((mu, i) => [
        ...(i === 0 ? [{ content: `${fmtCorta(r.fecha)}\n${diaSemana(r.fecha)}`, rowSpan: r.muestras.length, styles: { valign: 'middle', fontStyle: 'bold' } }] : []),
        String(i + 1), ...PARAMS.map(p => pc(mu[p.k], chk.byPath[`muestras.${i}.${p.k}`]?.s === 'warn'))]);
    }),
  });
  y = doc.lastAutoTable.finalY + 9;

  const al = recs.flatMap(r => recordChecks(r).warn.map(x => [fmtCorta(r.fecha), pdfSafe(x.text)]));
  if (al.length) {
    y = pdfTitle(doc, 'Alertas del periodo', y);
    doc.autoTable({ ...tableBase, startY: y, head: [['Fecha', 'Alerta']], body: al, columnStyles: { 0: { cellWidth: 26 } }, styles: { ...tableBase.styles, fontSize: 8.5 } });
    y = doc.lastAutoTable.finalY + 9;
  }
  const obs = recs.filter(r => r.observaciones).map(r => [fmtCorta(r.fecha), pdfSafe(r.observaciones)]);
  if (obs.length) {
    y = pdfTitle(doc, 'Observaciones', y);
    doc.autoTable({ ...tableBase, startY: y, head: [['Fecha', 'Observación']], body: obs, columnStyles: { 0: { cellWidth: 26 } }, styles: { ...tableBase.styles, fontSize: 8.5 } });
  }
  pdfFooters(doc);
  entregarArchivo(doc.output('blob'), `${fileBase}.pdf`);
}

function rangeInfo() {
  const dates = rangeDates();
  const from = $('#hDesde').value || dates[0], to = $('#hHasta').value || dates[dates.length - 1];
  const mes = $('#hMes').value;
  const fileBase = mes ? `Bitacora_Agua_${mes}` : `Bitacora_Agua_${from}_a_${to}`;
  const label = mes ? cap(fromISO(mes + '-01').toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })) : `${fmtCorta(from)} al ${fmtCorta(to)}`;
  return { dates, fileBase, label };
}

/* ================= Respaldo ================= */
function renderBackup() {
  const ds = Object.keys(state.registros).sort();
  const last = state.ultimoRespaldo;
  $('#bStats').innerHTML = `
    <div class="stat"><b>${ds.length}</b><span>registros guardados</span></div>
    <div class="stat"><b style="font-size:15px">${ds.length ? `${fmtCorta(ds[0])} – ${fmtCorta(ds[ds.length - 1])}` : '—'}</b><span>periodo</span></div>
    <div class="stat"><b style="font-size:15px">${last ? fmtStamp(last) : 'Nunca'}</b><span>último respaldo</span></div>`;
  const stale = ds.length && (!last || (Date.now() - new Date(last)) / 864e5 > CFG.DIAS_RESPALDO);
  $('#backupDot').classList.toggle('hidden', !stale);
}
async function downloadBackup() {
  const r = await modal({
    title: 'Respaldo cifrado',
    html: '<p>El respaldo se guarda <b>cifrado</b>. Elige una contraseña para abrirlo (puede ser la misma de la app).</p>'
      + '<div class="box w">Sin esta contraseña el respaldo no se puede restaurar. Anótala junto con tu código de recuperación.</div>',
    ok: 'Crear respaldo',
    inputs: [
      { label: 'Contraseña del respaldo', type: 'password', required: true, autocomplete: 'new-password' },
      { label: 'Confirmar contraseña', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    validar: v => Candado.validarNueva(v[0], v[1]),
  });
  if (!r.ok) return;
  toast('Cifrando respaldo…');
  const data = await Boveda.cifrarRespaldo({ registros: state.registros, eliminados: state.eliminados || [] }, r.values[0]);
  await entregarArchivo(new Blob([JSON.stringify(data)], { type: 'application/json' }), `Respaldo_Bitacora_Agua_${todayISO()}.json`);
  state.ultimoRespaldo = new Date().toISOString();
  saveState(); renderBackup();
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('El archivo no es un respaldo válido', true); return; }
  if (data?.app !== 'bitacora-agua') { toast('El archivo no es un respaldo de esta bitácora', true); return; }
  if (data.cifrado) {
    const r = await modal({
      title: 'Respaldo cifrado', html: '<p>Escribe la contraseña con la que se creó este respaldo.</p>', ok: 'Abrir',
      inputs: [{ label: 'Contraseña del respaldo', type: 'password', required: true, autocomplete: 'off' }],
    });
    if (!r.ok) return;
    const contenido = await Boveda.descifrarRespaldo(data, r.values[0]);
    if (!contenido) { toast('Contraseña incorrecta o respaldo dañado', true); return; }
    data = { ...data, ...contenido };
  }
  const regs = data?.registros;
  if (typeof regs !== 'object' || !regs) { toast('El archivo no es un respaldo de esta bitácora', true); return; }
  const valid = Object.entries(regs).filter(([d, r]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && r && r.medidores && Array.isArray(r.muestras));
  let nuevos = 0, act = 0, iguales = 0, conservados = 0;
  valid.forEach(([d, r]) => {
    const cur = state.registros[d];
    if (!cur) nuevos++;
    else if (JSON.stringify(cur) === JSON.stringify(r)) iguales++;
    else if ((r.modificado || '') > (cur.modificado || '')) act++;
    else conservados++;
  });
  const ok = await modal({
    title: 'Restaurar respaldo',
    html: `<p>Respaldo del <b>${data.exportado ? fmtStamp(data.exportado) : '—'}</b> con <b>${valid.length}</b> registro(s).</p>
      <ul><li>${nuevos} nuevo(s) se agregarán</li><li>${act} se actualizarán (versión del respaldo más reciente)</li><li>${iguales} ya son iguales</li><li>${conservados} se conservan (la versión actual es más reciente)</li></ul>`,
    ok: 'Restaurar',
  });
  if (!ok.ok) return;
  valid.forEach(([d, r]) => {
    const cur = state.registros[d];
    if (!cur || (r.modificado || '') > (cur.modificado || '')) state.registros[d] = { ...r, fecha: d };
  });
  saveState();
  renderBackup(); renderHistory(); loadDate(curDate());
  toast(`Respaldo restaurado: ${nuevos + act} registro(s) incorporados`);
}

/* ================= Diálogo y avisos ================= */
/**
 * Diálogo modal. `input` = un campo de texto largo (compatibilidad);
 * `inputs` = lista de campos {label, type: 'text'|'password'|'textarea', required, autocomplete};
 * `validar(valores)` devuelve un mensaje de error o ''.
 */
function modal({ title, html, ok = 'Aceptar', cancel = 'Cancelar', danger = false, input = null, inputs = null, validar = null }) {
  const dlg = $('#dlg');
  const campos = inputs || (input ? [{ ...input, type: 'textarea' }] : []);
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  $('#dlgOk').textContent = ok;
  $('#dlgOk').className = 'btn ' + (danger ? 'danger' : 'primary');
  $('#dlgCancel').textContent = cancel || '';
  $('#dlgCancel').classList.toggle('hidden', !cancel);
  const wrap = $('#dlgInputWrap');
  wrap.innerHTML = campos.map((c, i) => `<label for="dlgIn${i}">${esc(c.label)}</label>` + (c.type === 'textarea'
    ? `<textarea id="dlgIn${i}" class="inp" rows="2"></textarea>`
    : `<input id="dlgIn${i}" class="inp" type="${c.type || 'text'}" autocomplete="${c.autocomplete || 'off'}" autocapitalize="off" spellcheck="false">`)
  ).join('') + '<div id="dlgErr" class="dlg-err hidden"></div>';
  wrap.classList.toggle('hidden', !campos.length);
  const valores = () => campos.map((c, i) => { const v = $('#dlgIn' + i).value; return c.type === 'password' ? v : v.trim(); });
  return new Promise(resolve => {
    const finish = ok => {
      const values = valores();
      $('#dlgOk').removeEventListener('click', onOk);
      $('#dlgCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEsc);
      wrap.removeEventListener('keydown', onKey);
      dlg.close();
      wrap.innerHTML = '';                       // no dejar contraseñas en la página
      resolve({ ok, value: values[0] ?? '', values });
    };
    const onOk = () => {
      const v = valores();
      const vacio = campos.findIndex((c, i) => c.required && !v[i]);
      const msg = vacio >= 0 ? 'Este campo es obligatorio.' : (validar ? validar(v) : '');
      if (msg) {
        $('#dlgErr').textContent = msg;
        $('#dlgErr').classList.remove('hidden');
        $('#dlgIn' + Math.max(vacio, 0)).focus();
        return;
      }
      finish(true);
    };
    const onCancel = () => finish(false);
    const onEsc = e => { e.preventDefault(); finish(false); };
    const onKey = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); onOk(); } };
    $('#dlgOk').addEventListener('click', onOk);
    $('#dlgCancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);
    wrap.addEventListener('keydown', onKey);
    dlg.showModal();
    (campos.length ? $('#dlgIn0') : $('#dlgOk')).focus();
  });
}

/* ================= Entrega de archivos (descarga o menú Compartir en iPad/iPhone) ================= */
const ES_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function entregarArchivo(blob, nombre) {
  const archivo = new File([blob], nombre, { type: blob.type });
  if (ES_IOS && navigator.canShare?.({ files: [archivo] })) {
    const r = await modal({
      title: 'Archivo listo',
      html: `<p><b>${esc(nombre)}</b></p><p>Toca <b>Compartir</b> y elige <b>Guardar en Archivos</b>. Guárdalo solo en ubicaciones autorizadas.</p>`,
      ok: 'Compartir',
    });
    if (!r.ok) return;
    try { await navigator.share({ files: [archivo] }); }
    catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir el archivo', true); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`${nombre} descargado`);
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.innerHTML = (err ? '' : '<span class="ic">✓</span>') + esc(msg);
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast' + (err ? ' err' : ''), 2800);
}

/* ================= Navegación ================= */
function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'historial') renderHistory();
  if (name === 'graficas') renderGraficas();
  if (name === 'respaldo') renderBackup();
}

/* ================= Gráficas y tendencias ================= */
const charts = {};
const C = { ac: '#00E47C', acBg: 'rgba(0,228,124,.15)', warn: '#ffb703', warnBg: 'rgba(255,183,3,.12)', err: '#ef4444',
            info: '#38bdf8', morado: '#a855f7', mu: '#95b3aa', grid: 'rgba(255,255,255,.06)' };
const promedio = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const numeros = (r, k) => (r.muestras || []).map(m => m[k]).filter(isNum).map(Number);
const red = (v, d) => v == null ? null : Number(v.toFixed(d));

function setGRange(from, to) { $('#gDesde').value = from; $('#gHasta').value = to; renderGraficas(); }
function gPreset(p) {
  const t = todayISO();
  if (p === 'mes') setGRange(t.slice(0, 7) + '-01', monthEnd(t.slice(0, 7)));
  else if (p === '30') setGRange(addDays(t, -29), t);
  else if (p === '90') setGRange(addDays(t, -89), t);
  else { const ds = Object.keys(state.registros).sort(); setGRange(ds[0] || t, ds.length && ds.at(-1) > t ? ds.at(-1) : t); }
}

function renderGraficas() {
  if (!state || !$('#tab-graficas').classList.contains('active')) return;
  const from = $('#gDesde').value, to = $('#gHasta').value;
  const recs = Object.keys(state.registros).filter(d => (!from || d >= from) && (!to || d <= to)).sort().map(d => state.registros[d]);
  const hay = recs.length > 0;
  $('#gVacio').classList.toggle('hidden', hay);
  $('#gCharts').classList.toggle('hidden', !hay);
  $('#gResumen').textContent = hay ? `${recs.length} registro(s) del ${fmtCorta(recs[0].fecha)} al ${fmtCorta(recs.at(-1).fecha)}` : '';

  // --- Tarjetas de promedios ---
  const todos = k => recs.flatMap(r => numeros(r, k));
  const ph = todos('ph'), te = todos('temp'), sst = todos('sst'), dqo = todos('dqo');
  const phFuera = ph.filter(v => v < CFG.PH_MIN || v > CFG.PH_MAX).length, teFuera = te.filter(v => v > CFG.T_MAX).length;
  const tarjeta = (ic, lbl, v, dec, unidad, sub, alerta) => `<div class="metric"><div class="metric-ic" aria-hidden="true">${ic}</div><div>
      <span class="metric-lbl">${lbl}</span><span class="metric-val">${v == null ? '--' : v.toFixed(dec)}${v != null && unidad ? `<small>${unidad}</small>` : ''}</span>
      <span class="metric-sub${alerta ? ' w' : ''}">${sub}</span></div></div>`;
  $('#gMetricas').innerHTML =
    tarjeta('🧪', 'Promedio de pH', promedio(ph), 2, '', phFuera ? `${phFuera} lectura(s) fuera de ${CFG.PH_MIN.toFixed(1)}–${CFG.PH_MAX.toFixed(1)}` : `Rango óptimo: ${CFG.PH_MIN.toFixed(1)} – ${CFG.PH_MAX.toFixed(1)}`, phFuera) +
    tarjeta('🌡️', 'Temp. promedio', promedio(te), 1, '°C', teFuera ? `${teFuera} lectura(s) sobre ${CFG.T_MAX} °C` : `Límite: ≤ ${CFG.T_MAX} °C`, teFuera) +
    tarjeta('🌫️', 'SST promedio', promedio(sst), 1, 'mg/L', `${sst.length} lectura(s)`) +
    tarjeta('💧', 'DQO promedio', promedio(dqo), 1, 'mg/L', `${dqo.length} lectura(s)`);

  Object.values(charts).forEach(c => c.destroy());
  if (!hay || typeof Chart === 'undefined') return;

  // --- Configuración común ---
  const telefono = innerWidth < 600;
  Chart.defaults.color = C.mu;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = telefono ? 11 : 12;
  const labels = recs.map(r => fmtCorta(r.fecha).slice(0, 5));
  const escalas = extra => ({
    x: { grid: { color: C.grid }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
    y: { grid: { color: C.grid }, ...extra },
  });
  const opciones = extra => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: telefono ? 10 : 14, padding: telefono ? 8 : 12 } } },
    scales: escalas(extra),
  });
  const limite = (texto, valor) => ({ label: texto, data: labels.map(() => valor), borderColor: C.err, borderWidth: 1.5,
    borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, fill: false });
  // Punto rojo si CUALQUIER muestra del día salió de rango (el promedio podría ocultarla)
  const diaFuera = (k, fuera) => recs.map(r => numeros(r, k).some(fuera));
  const puntos = (marcas, color) => marcas.map(f => f ? C.err : color);
  const radios = marcas => marcas.map(f => f ? 6 : 4);

  // pH
  const phDia = recs.map(r => red(promedio(numeros(r, 'ph')), 2));
  const phMarca = diaFuera('ph', v => v < CFG.PH_MIN || v > CFG.PH_MAX);
  charts.ph = new Chart($('#chPh'), { type: 'line', options: opciones({ suggestedMin: 5, suggestedMax: 10 }), data: { labels, datasets: [
    { label: 'pH promedio diario', data: phDia, borderColor: C.ac, backgroundColor: C.acBg, fill: true, tension: .3, spanGaps: true,
      pointRadius: radios(phMarca), pointBackgroundColor: puntos(phMarca, C.ac), pointBorderColor: 'transparent' },
    limite(`Límite superior (${CFG.PH_MAX.toFixed(1)})`, CFG.PH_MAX), limite(`Límite inferior (${CFG.PH_MIN.toFixed(1)})`, CFG.PH_MIN)] } });

  // Temperatura
  const teDia = recs.map(r => red(promedio(numeros(r, 'temp')), 1));
  const teMarca = diaFuera('temp', v => v > CFG.T_MAX);
  charts.temp = new Chart($('#chTemp'), { type: 'line', options: opciones({ suggestedMin: 15, suggestedMax: 40 }), data: { labels, datasets: [
    { label: 'Temperatura promedio (°C)', data: teDia, borderColor: C.warn, backgroundColor: C.warnBg, fill: true, tension: .3, spanGaps: true,
      pointRadius: radios(teMarca), pointBackgroundColor: puntos(teMarca, C.warn), pointBorderColor: 'transparent' },
    limite(`Límite máximo (${CFG.T_MAX} °C)`, CFG.T_MAX)] } });

  // SST y DQO
  charts.sstdqo = new Chart($('#chSstDqo'), { type: 'bar', options: opciones({ beginAtZero: true }), data: { labels, datasets: [
    { label: 'SST promedio (mg/L)', data: recs.map(r => red(promedio(numeros(r, 'sst')), 1)), backgroundColor: 'rgba(56,189,248,.75)', borderRadius: 5 },
    { label: 'DQO promedio (mg/L)', data: recs.map(r => red(promedio(numeros(r, 'dqo')), 1)), backgroundColor: 'rgba(0,228,124,.75)', borderRadius: 5 }] } });

  // Consumo diario de medidores
  const colores = [C.ac, C.info, C.warn, C.morado];
  charts.med = new Chart($('#chMed'), { type: 'bar', options: opciones({}), data: { labels, datasets: MEDIDORES.map((m, i) => ({
    label: m.label.replace('Medidor ', 'M-'), data: recs.map(r => { const c = consumo(r, m.k); return c === '' ? null : c; }),
    backgroundColor: colores[i % colores.length], borderRadius: 4 })) } });
}
function stepWorkday(dir) {
  let d = curDate() || todayISO();
  do { d = addDays(d, dir); } while (isWeekend(d));
  $('#fecha').value = d; loadDate(d);
}

/* ================= Eventos ================= */
buildForm();
$$('.tab[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#dlgForm').addEventListener('submit', e => e.preventDefault());

const cap0 = $('#tab-captura');
cap0.addEventListener('input', e => { if (e.target.matches('[data-f]')) { refresh(); scheduleDraft(); } });
cap0.addEventListener('focusout', e => {
  const el = e.target;
  if (el.matches('[data-kind]')) { const n = normalize(el.value); if (n !== el.value) { el.value = n; refresh(); scheduleDraft(); } }
});
cap0.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input[data-f]')) {
    e.preventDefault();
    const list = $$('#tab-captura input[data-f]');
    const i = list.indexOf(e.target);
    if (i >= 0 && i < list.length - 1) { list[i + 1].focus(); list[i + 1].select(); }
    else $('#f-obs').focus();
  }
});
cap0.addEventListener('click', e => {
  const fill = e.target.closest('[data-fill]');
  if (fill) { const inp = fill.closest('.meter, .sed-wrap').querySelector('input'); inp.value = fill.dataset.fill; refresh(); scheduleDraft(); return; }
  if (e.target.closest('#btnQuitarMuestra')) { quitarMuestra(); return; }
  if (e.target.closest('#btnAddMuestra')) { agregarMuestra(); return; }
  const rf = e.target.closest('[data-rowfill]');
  if (rf) { $$(`#tab-captura [data-f^="muestras.${rf.dataset.rowfill}."]`).forEach(i => i.value = rf.dataset.v); refresh(); scheduleDraft(); return; }
  const go = e.target.closest('[data-goto]');
  if (go) focusPath(go.dataset.goto);
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (state && $('#tab-captura').classList.contains('active') && !$('#dlg').open) guardar();
  }
});

$('#fecha').addEventListener('change', () => { if (curDate()) loadDate(curDate()); });
$('#btnHoy').addEventListener('click', () => { $('#fecha').value = todayISO(); loadDate(todayISO()); });
$('#btnPrev').addEventListener('click', () => stepWorkday(-1));
$('#btnNext').addEventListener('click', () => stepWorkday(1));
$('#btnGuardar').addEventListener('click', guardar);
$('#btnDescartar').addEventListener('click', async () => {
  const r = await modal({ title: 'Descartar cambios', html: '<p>Se perderán los datos capturados que no se han guardado para esta fecha.</p>', ok: 'Descartar', danger: true });
  if (!r.ok) return;
  delete state.borradores[curDate()]; saveState(); loadDate(curDate());
});
$('#btnXlsxDia').addEventListener('click', () => exportXLSX([curDate()], `Bitacora_Agua_${curDate()}`));
$('#btnPdfDia').addEventListener('click', () => exportPDFDia(curDate()));

$('#hDesde').addEventListener('change', () => { $('#hMes').value = ''; renderHistory(); });
$('#hHasta').addEventListener('change', () => { $('#hMes').value = ''; renderHistory(); });
$('#hMes').addEventListener('change', () => { const m = $('#hMes').value; if (m) setRange(m + '-01', monthEnd(m)); });
$$('[data-preset]').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
$('#btnXlsxRango').addEventListener('click', () => { const r = rangeInfo(); exportXLSX(r.dates, r.fileBase); });
$('#btnPdfRango').addEventListener('click', () => { const r = rangeInfo(); exportPDFRango(r.dates, r.label, r.fileBase); });
$('#hMissing').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openDate(b.dataset.open); });
$('#hTable').addEventListener('click', e => {
  const row = e.target.closest('tr.row'); if (!row) return;
  const d = row.dataset.d, act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'open') openDate(d);
  else if (act === 'xlsx') exportXLSX([d], `Bitacora_Agua_${d}`);
  else if (act === 'pdf') exportPDFDia(d);
  else if (act === 'del') eliminar(d);
  else { row.classList.toggle('open'); $(`tr[data-detail="${d}"]`).classList.toggle('hidden'); }
});

$$('[data-gpreset]').forEach(b => b.addEventListener('click', () => gPreset(b.dataset.gpreset)));
$('#gDesde').addEventListener('change', renderGraficas);
$('#gHasta').addEventListener('change', renderGraficas);
let gResize;
addEventListener('resize', () => { clearTimeout(gResize); gResize = setTimeout(renderGraficas, 250); });

$('#btnBackup').addEventListener('click', downloadBackup);
$('#btnRestore').addEventListener('click', () => $('#fileRestore').click());
$('#fileRestore').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });

/* ================= Seguridad: bloqueo automático y ajustes ================= */
let bloqueando = false;
async function bloquear() {
  if (bloqueando || !state) return;
  bloqueando = true;
  flushDraft();
  try { await persistQueue; } catch (e) { /* ya se avisó al usuario */ }
  location.reload();                         // borra de la memoria la llave y los datos
}
let ultimoUso = Date.now(), ocultoDesde = null;
['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { ultimoUso = Date.now(); }, { passive: true, capture: true }));
setInterval(() => { if (state && Date.now() - ultimoUso > BLOQUEO_INACTIVIDAD_MIN * 60000) bloquear(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (!state) return;
  if (document.hidden) { ocultoDesde = Date.now(); flushDraft(); }
  else if (ocultoDesde && Date.now() - ocultoDesde > BLOQUEO_FONDO_MIN * 60000) bloquear();
});
$('#btnBloquear').addEventListener('click', bloquear);
$('#btnBloquear2').addEventListener('click', bloquear);

$('#btnCambiarPass').addEventListener('click', async () => {
  const r = await modal({
    title: 'Cambiar contraseña', html: '<p>La nueva contraseña se usará para abrir la bitácora en este dispositivo.</p>', ok: 'Cambiar',
    inputs: [
      { label: 'Contraseña actual', type: 'password', required: true, autocomplete: 'current-password' },
      { label: 'Nueva contraseña', type: 'password', required: true, autocomplete: 'new-password' },
      { label: 'Confirmar nueva contraseña', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    validar: v => Candado.validarNueva(v[1], v[2]),
  });
  if (!r.ok) return;
  toast('Verificando…');
  if (await Boveda.cambiar(r.values[0], r.values[1])) toast('Contraseña actualizada');
  else toast('La contraseña actual no es correcta', true);
});
$('#btnNuevoCodigo').addEventListener('click', async () => {
  const r = await modal({
    title: 'Nuevo código de recuperación', html: '<p>Se generará un código nuevo y <b>el anterior dejará de funcionar</b>.</p>', ok: 'Generar',
    inputs: [{ label: 'Contraseña actual', type: 'password', required: true, autocomplete: 'current-password' }],
  });
  if (!r.ok) return;
  toast('Verificando…');
  const codigo = await Boveda.nuevoCodigo(r.values[0]);
  if (!codigo) { toast('La contraseña no es correcta', true); return; }
  await modal({
    title: 'Tu nuevo código de recuperación', ok: 'Ya lo anoté', cancel: null,
    html: `<p>Anótalo en papel y guárdalo en un lugar seguro. No se volverá a mostrar.</p><div class="codigo">${esc(codigo)}</div>`,
  });
});

/* ================= Actualizaciones de la app (service worker) ================= */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let actualizando = false;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const avisar = w => {
      if (!w || !navigator.serviceWorker.controller) return;
      $('#avisoUpdate').classList.remove('hidden');
      $('#btnUpdate').onclick = async () => {
        actualizando = true;
        flushDraft();
        try { await persistQueue; } catch (e) { /* ya se avisó */ }
        w.postMessage('SKIP_WAITING');
      };
    };
    if (reg.waiting) avisar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') avisar(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* sin service worker la app sigue funcionando en línea */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (actualizando) location.reload(); });
}

/* ================= Inicio (después de desbloquear) ================= */
function arrancar(datos) {
  state = initialState(datos);
  if (!datos) saveState();
  navigator.storage?.persist?.().catch(() => {});
  $('#fecha').value = todayISO();
  loadDate(todayISO());
  applyPreset('mes');
  gPreset('mes');
  renderBackup();
  ultimoUso = Date.now();
}
Candado.iniciar(arrancar);
