import { KEL103, MODES, DYN_MODES, DYN_LIMITS } from './kel103.js';
import { TimePlot, drawXY } from './plot.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = new KEL103();

const MAX_HISTORY = 500_000;

const state = {
  polling: true,
  pollTimer: null,
  inputOn: false,
  mode: 'CC',
  history: [], // { t, v, i, p }
  energyWh: 0,
  chargeAh: 0,
  cycle: 0,
  busy: false, // läuft gerade die Innenwiderstandsmessung?
  abort: false,
  batt: null, // Zustand des internen Batterietests, siehe startBattery()
};
const battRunning = () => state.batt?.running === true;

// ---------- Protokoll ----------
const logEl = $('log');
function log(kind, text) {
  const line = document.createElement('div');
  line.className = kind;
  const prefix = { tx: '→ ', rx: '← ', err: '! ', info: '· ' }[kind] ?? '';
  line.textContent = `${new Date().toLocaleTimeString()}  ${prefix}${text}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 500) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
load.onLog = (kind, text) => {
  // Messabfragen nicht ins Log schreiben, sonst läuft es voll
  if (kind !== 'err' && /^:MEAS:|^-?[\d.]+[VAW]$|^:INP\?$|^(ON|OFF)$/.test(text)) return;
  log(kind, text);
};

// ---------- UI-Zustand ----------
function updateControls() {
  const connected = load.connected;
  const free = connected && !state.busy;
  $('btnConnect').textContent = connected ? 'Trennen' : 'Verbinden';
  $('status').textContent = connected ? 'verbunden' : 'getrennt';
  $('status').classList.toggle('on', connected);
  for (const id of ['btnInput', 'mode', 'setpoint', 'btnApply', 'btnPoll', 'cmd', 'btnSend']) {
    $(id).disabled = !free;
  }
  $('btnRi').disabled = !connected || (!state.busy && battRunning());
  $('btnRi').textContent = state.busy ? 'Abbrechen' : 'Messung starten';
  $('btnRi').classList.toggle('primary', !state.busy);
  $('btnBattLoad').disabled = !free || battRunning();
  $('btnBattStart').disabled = !free || battRunning();
  $('btnBattStop').disabled = !connected || !battRunning();
  const dynFree = free && !battRunning();
  for (const id of ['btnDynStart', 'btnDynApply', 'btnDynRead']) $(id).disabled = !dynFree;
  $('btnDynStop').disabled = !connected;
  $('btnDynTrig').disabled = !dynFree || !DYN_MODES[$('dynMode').value]?.trigger;
  if (!connected) {
    $('idn').textContent = '—';
    setInputUI(false);
  }
}

function setInputUI(on) {
  state.inputOn = on;
  const btn = $('btnInput');
  btn.textContent = on ? 'Eingang AUS' : 'Eingang EIN';
  btn.classList.toggle('is-on', on);
  $('inputState').textContent = on ? 'Eingang an' : 'Eingang aus';
  $('inputState').classList.toggle('on', on);
}

function setModeUI(mode) {
  state.mode = mode;
  const m = MODES[mode];
  if (!m) {
    // Batterietest, Dynamik oder anderer Sondermodus des Geräts
    $('mode').value = ['BATTERY', 'DYNAMIC'].includes(mode) ? mode : '';
    $('unit').textContent = '—';
    $('curSet').textContent = '—';
    return;
  }
  $('mode').value = mode;
  $('unit').textContent = m.unit;
  $('setpoint').max = m.max;
  $('setpoint').step = m.step;
}

for (const [key, m] of Object.entries(MODES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = m.label;
  $('mode').appendChild(opt);
}
for (const [value, text] of [['BATTERY', 'Batterietest (intern)'], ['DYNAMIC', 'Dynamik']]) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  opt.disabled = true;
  $('mode').appendChild(opt);
}
for (const [key, d] of Object.entries(DYN_MODES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = d.label;
  $('dynMode').appendChild(opt);
}
$('dynMode').value = '2';
for (let n = 1; n <= 10; n++) {
  const opt = document.createElement('option');
  opt.value = n;
  opt.textContent = n;
  $('battSlot').appendChild(opt);
}
$('battSlot').value = '10';

// ---------- Verbindung ----------
async function connect() {
  try {
    await load.connect(Number($('baud').value));
  } catch (e) {
    if (e.name !== 'NotFoundError') log('err', `Verbinden fehlgeschlagen: ${e.message}`);
    return;
  }
  log('info', 'Port geöffnet');
  updateControls();
  try {
    $('idn').textContent = await load.identify();
    const on = await load.getInput();
    setInputUI(on);
    const mode = await load.getMode();
    setModeUI(mode);
    await refreshSetpoint();
    if (mode === 'BATTERY' && on) await attachRunningBattery();
    if (mode === 'DYNAMIC') await readDynamic();
  } catch (e) {
    log('err', `${e.message} – stimmt die Baudrate? (Gerätemenü: System → Baudrate)`);
  }
  schedulePoll(0);
}

async function disconnect() {
  state.abort = true;
  stopPoll();
  if ($('offOnDisconnect').checked && load.connected) {
    try { await load.setInput(false); } catch {}
  }
  await load.disconnect();
}

load.onDisconnect = () => {
  stopPoll();
  if (battRunning()) {
    state.batt.running = false;
    setBattState('getrennt', 'fail');
    battMsg($('offOnDisconnect').checked
      ? 'Verbindung getrennt – der Eingang wurde ausgeschaltet, der Test ist beendet.'
      : 'Verbindung getrennt – der Test läuft am Gerät weiter. Zum Weiterverfolgen neu verbinden.');
  }
  updateControls();
  log('info', 'Port geschlossen');
};

$('btnConnect').addEventListener('click', () => (load.connected ? disconnect() : connect()));

// ---------- Steuerung ----------
$('btnInput').addEventListener('click', async () => {
  if (battRunning() && state.inputOn) return stopBattery();
  try {
    await load.setInput(!state.inputOn);
    setInputUI(await load.getInput());
  } catch (e) {
    log('err', e.message);
  }
});

$('mode').addEventListener('change', async () => {
  const mode = $('mode').value;
  try {
    await load.setMode(mode);
    setModeUI(mode);
    await refreshSetpoint();
  } catch (e) {
    log('err', e.message);
  }
});

async function refreshSetpoint() {
  const m = MODES[state.mode];
  if (!m) return;
  const v = await load.getSetpoint(state.mode);
  $('curSet').textContent = `${v} ${m.unit}`;
  $('setpoint').value = v;
}

async function applySetpoint() {
  const value = Number($('setpoint').value);
  try {
    await load.setSetpoint(state.mode, value);
    await refreshSetpoint();
  } catch (e) {
    log('err', e.message);
  }
}
$('btnApply').addEventListener('click', applySetpoint);
$('setpoint').addEventListener('keydown', (e) => { if (e.key === 'Enter') applySetpoint(); });

// ---------- Messung / Aufzeichnung ----------
function schedulePoll(delay = Number($('interval').value)) {
  clearTimeout(state.pollTimer);
  if (state.polling && load.connected) state.pollTimer = setTimeout(poll, delay);
}
function stopPoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function poll() {
  // Während eines Tests liefert der Test selbst die Messwerte
  if (state.busy) return schedulePoll();
  const started = performance.now();
  try {
    const m = await load.measure();
    addSample(m);
    if (battRunning()) {
      await updateBattery(m);
    } else if (state.cycle++ % 5 === 0) {
      // Eingangsstatus gelegentlich nachlesen (könnte am Gerät umgeschaltet worden sein)
      setInputUI(await load.getInput());
    }
  } catch (e) {
    if (load.connected) log('err', e.message);
  }
  const elapsed = performance.now() - started;
  schedulePoll(Math.max(0, Number($('interval').value) - elapsed));
}

function addSample({ v, i, p }) {
  const t = Date.now();
  const prev = state.history[state.history.length - 1];
  if (prev) {
    const dtH = (t - prev.t) / 3_600_000;
    state.energyWh += ((p + prev.p) / 2) * dtH;
    state.chargeAh += ((i + prev.i) / 2) * dtH;
  }
  state.history.push({ t, v, i, p });
  if (state.history.length > MAX_HISTORY) state.history.splice(0, MAX_HISTORY / 10);

  $('mV').textContent = v.toFixed(3);
  $('mI').textContent = i.toFixed(3);
  $('mP').textContent = p.toFixed(2);
  $('samples').textContent = state.history.length;
  $('energy').textContent = state.energyWh.toFixed(3);
  $('charge').textContent = state.chargeAh.toFixed(3);
  plot.requestDraw();
}

$('btnPoll').addEventListener('click', () => {
  state.polling = !state.polling;
  $('btnPoll').textContent = state.polling ? 'Pause' : 'Fortsetzen';
  state.polling ? schedulePoll(0) : stopPoll();
});
$('interval').addEventListener('change', () => schedulePoll());

$('btnClear').addEventListener('click', () => {
  state.history = [];
  state.energyWh = state.chargeAh = 0;
  $('samples').textContent = '0';
  $('energy').textContent = $('charge').textContent = '0.000';
  plot.setData(state.history);
});

function downloadCsv(name, rows) {
  const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('btnCsv').addEventListener('click', () => {
  if (!state.history.length) return;
  const t0 = state.history[0].t;
  const rows = ['zeit_iso;zeit_s;spannung_V;strom_A;leistung_W'];
  for (const s of state.history) {
    rows.push([new Date(s.t).toISOString(), ((s.t - t0) / 1000).toFixed(3), s.v, s.i, s.p].join(';'));
  }
  downloadCsv('kel103', rows);
});

// ---------- Verlaufsdiagramm ----------
const plot = new TimePlot($('plot'), [
  { key: 'v', label: 'Spannung', unit: 'V', color: '--c-volt', digits: 3, visible: true },
  { key: 'i', label: 'Strom', unit: 'A', color: '--c-curr', digits: 3, visible: true },
  { key: 'p', label: 'Leistung', unit: 'W', color: '--c-pow', digits: 2, visible: true },
]);
plot.setData(state.history);

for (const cb of document.querySelectorAll('[data-series]')) {
  cb.addEventListener('change', () => {
    plot.panels.find((p) => p.key === cb.dataset.series).visible = cb.checked;
    plot.requestDraw();
  });
}
$('window').addEventListener('change', () => {
  plot.windowMs = Number($('window').value);
  plot.requestDraw();
});

// ---------- Innenwiderstand ----------
const riStatus = (text) => { $('riStatus').textContent = text; };
const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;

/** Misst `ms` lang so schnell wie möglich, bricht bei Unterspannung oder Abbruch ab. */
async function sampleFor(ms, vmin = null) {
  const end = performance.now() + ms;
  const out = [];
  do {
    if (state.abort) throw new Error('vom Benutzer abgebrochen');
    const m = await load.measureVI();
    addSample(m);
    out.push(m);
    if (vmin !== null && m.v < vmin) {
      throw new Error(`Spannung ${m.v.toFixed(3)} V unter Abbruchgrenze ${vmin} V`);
    }
  } while (performance.now() < end);
  return out;
}

function parseCurrents(text) {
  return text
    .split(/[;\s]+/)
    .filter(Boolean)
    .map((s) => parseFloat(s.replace(',', '.')));
}

/** Lineare Regression U = U0 − Ri·I */
function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  const mi = avg(points, 'i'), mv = avg(points, 'v');
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    sxx += (p.i - mi) ** 2;
    sxy += (p.i - mi) * (p.v - mv);
    syy += (p.v - mv) ** 2;
  }
  if (sxx < 1e-12) return null;
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { r: -slope, v0: mv - slope * mi, r2 };
}

const fmtOhm = (r) => (Math.abs(r) < 1 ? `${(r * 1000).toFixed(1)} mΩ` : `${r.toFixed(3)} Ω`);

function renderRi(points) {
  const tbody = $('riTable').tBodies[0];
  tbody.innerHTML = '';
  const v0 = points[0]?.v;
  for (const p of points) {
    const tr = tbody.insertRow();
    const dv = v0 - p.v;
    const cells = [
      p.set === 0 ? 'Leerlauf' : `${p.set} A`,
      `${p.i.toFixed(3)} A`,
      `${p.v.toFixed(4)} V`,
      p.set === 0 ? '—' : `${(dv * 1000).toFixed(1)} mV`,
      p.set === 0 || p.i <= 0 ? '—' : fmtOhm(dv / p.i),
    ];
    for (const c of cells) tr.insertCell().textContent = c;
  }
  const fit = fitLine(points);
  $('riResult').innerHTML = fit
    ? `Ri = ${fmtOhm(fit.r)}<small>Ausgleichsgerade über ${points.length} Punkte · R² = ${fit.r2.toFixed(4)} · U₀ = ${fit.v0.toFixed(4)} V</small>`
    : '';
  drawXY($('riPlot'), points, fit);
  state.riPoints = points;
}

async function runRi() {
  if (battRunning()) {
    riStatus('Während eines Entladetests nicht möglich.');
    return;
  }
  const currents = parseCurrents($('riCurrents').value);
  const pulse = Number($('riPulse').value) * 1000;
  const pause = Number($('riPause').value) * 1000;
  const vmin = Number($('riVmin').value);
  if (!currents.length || currents.some((i) => !(i > 0 && i <= MODES.CC.max))) {
    riStatus(`Ungültige Prüfströme – erlaubt sind Werte über 0 bis ${MODES.CC.max} A, getrennt mit Semikolon oder Leerzeichen.`);
    return;
  }
  if (!(pulse >= 500) || !(pause >= 500) || !(vmin >= 0)) {
    riStatus('Pulsdauer und Pause müssen mindestens 0,5 s sein, die Abbruchgrenze ≥ 0 V.');
    return;
  }

  state.busy = true;
  state.abort = false;
  updateControls();
  const prevMode = state.mode;
  let prevCC = null;
  try { prevCC = await load.getSetpoint('CC'); } catch {}

  const points = [];
  renderRi(points);
  try {
    riStatus('Leerlaufspannung wird gemessen …');
    await load.setInput(false);
    setInputUI(false);
    const s0 = await sampleFor(pause);
    const v0 = avg(s0.slice(-3), 'v');
    if (v0 < vmin) throw new Error(`Leerlaufspannung ${v0.toFixed(3)} V liegt unter der Abbruchgrenze`);
    points.push({ set: 0, i: 0, v: v0 });
    renderRi(points);

    await load.setMode('CC');
    setModeUI('CC');
    for (const [k, current] of currents.entries()) {
      riStatus(`Puls ${k + 1} von ${currents.length}: ${current} A …`);
      await load.setSetpoint('CC', current);
      await load.setInput(true);
      setInputUI(true);
      let samples;
      try {
        samples = await sampleFor(pulse, vmin);
      } finally {
        await load.setInput(false);
        setInputUI(false);
      }
      // Mittelwert der letzten Messungen am Pulsende (nach dem Einschwingen)
      const last = samples.slice(-3);
      points.push({ set: current, i: avg(last, 'i'), v: avg(last, 'v') });
      renderRi(points);
      if (k < currents.length - 1) {
        riStatus('Erholungspause …');
        await sampleFor(pause);
      }
    }
    riStatus(`Fertig (${new Date().toLocaleTimeString()}).`);
  } catch (e) {
    riStatus(`Abgebrochen: ${e.message}`);
    log('err', `Innenwiderstand: ${e.message}`);
  } finally {
    // Eingang sicher aus, vorherige Einstellungen wiederherstellen
    try { await load.setInput(false); setInputUI(false); } catch {}
    try {
      if (prevCC !== null) await load.setSetpoint('CC', prevCC);
      if (MODES[prevMode]) { await load.setMode(prevMode); setModeUI(prevMode); }
      await refreshSetpoint();
    } catch {}
    state.busy = false;
    state.abort = false;
    updateControls();
    schedulePoll(0);
  }
}

$('btnRi').addEventListener('click', () => {
  if (state.busy) {
    state.abort = true;
    riStatus('Wird abgebrochen …');
  } else {
    runRi();
  }
});

// ---------- Dynamik ----------
const dynMsg = (text) => { $('dynMsg').textContent = text; };

const DYN_LABELS = {
  1: ['Spannung 1', 'Spannung 2'],
  2: ['Strom 1', 'Strom 2'],
  3: ['Widerstand 1', 'Widerstand 2'],
  4: ['Leistung 1', 'Leistung 2'],
  5: ['Grundstrom', 'Pulsstrom'],
  6: ['Strom 1', 'Strom 2'],
};

function updateDynFields() {
  const mode = $('dynMode').value;
  const d = DYN_MODES[mode];
  const m = MODES[d.base];
  const [l1, l2] = DYN_LABELS[mode];
  $('dynL1').textContent = `${l1} (${m.unit})`;
  $('dynL2').textContent = `${l2} (${m.unit})`;
  for (const id of ['dynV1', 'dynV2']) {
    $(id).max = m.max;
    $(id).step = m.step;
  }
  for (const el of document.querySelectorAll('[data-dyn]')) el.hidden = !d[el.dataset.dyn];
  updateControls();
}
$('dynMode').addEventListener('change', updateDynFields);

function fillDynForm(p) {
  $('dynMode').value = String(p.mode);
  $('dynV1').value = p.v1;
  $('dynV2').value = p.v2;
  if (p.freq !== undefined) { $('dynFreq').value = p.freq; $('dynDuty').value = p.duty; }
  if (p.s1 !== undefined) { $('dynS1').value = p.s1; $('dynS2').value = p.s2; }
  if (p.width !== undefined) $('dynWidth').value = p.width;
  updateDynFields();
}

function readDynForm() {
  const mode = Number($('dynMode').value);
  const d = DYN_MODES[mode];
  const m = MODES[d.base];
  const p = {
    v1: Number($('dynV1').value), v2: Number($('dynV2').value),
    freq: Number($('dynFreq').value), duty: Number($('dynDuty').value),
    s1: Number($('dynS1').value), s2: Number($('dynS2').value),
    width: Number($('dynWidth').value),
  };
  const inRange = (x, [a, b]) => x >= a && x <= b;
  const check = (ok, msg) => { if (!ok) throw new Error(msg); };
  check(inRange(p.v1, [0, m.max]) && inRange(p.v2, [0, m.max]), `Die Werte müssen zwischen 0 und ${m.max} ${m.unit} liegen.`);
  if (d.freq) {
    check(inRange(p.freq, DYN_LIMITS.freq), `Die Frequenz muss zwischen ${DYN_LIMITS.freq[0]} und ${DYN_LIMITS.freq[1]} Hz liegen.`);
    check(inRange(p.duty, DYN_LIMITS.duty), `Der Tastgrad muss zwischen ${DYN_LIMITS.duty[0]} und ${DYN_LIMITS.duty[1]} % liegen.`);
  }
  if (d.slopes) {
    check(inRange(p.s1, DYN_LIMITS.slope) && inRange(p.s2, DYN_LIMITS.slope),
      `Die Anstiegsraten müssen zwischen ${DYN_LIMITS.slope[0]} und ${DYN_LIMITS.slope[1]} A/µs liegen.`);
  }
  if (d.width) {
    check(inRange(p.width, DYN_LIMITS.width), `Die Pulsbreite muss zwischen ${DYN_LIMITS.width[0]} und ${DYN_LIMITS.width[1]} s liegen.`);
  }
  return { mode, p };
}

/** Sendet die Einstellung und prüft sie durch Zurücklesen. Gibt true bei Erfolg zurück. */
async function applyDynamic() {
  let form;
  try {
    form = readDynForm();
  } catch (e) {
    dynMsg(e.message);
    return false;
  }
  const { mode, p } = form;
  try {
    if (state.inputOn) {
      await load.setInput(false);
      setInputUI(false);
    }
    await load.setDynamic(mode, p);
    const back = await load.getDynamic();
    const keys = ['v1', 'v2', 'freq', 'duty', 's1', 's2', 'width'].filter((k) => back && back[k] !== undefined);
    if (!back || back.mode !== mode || keys.some((k) => !near(back[k], p[k]))) {
      throw new Error('Das Gerät hat die Einstellung nicht übernommen – liegt ein Wert außerhalb des zulässigen Bereichs?');
    }
    setModeUI('DYNAMIC');
    dynMsg(`${DYN_MODES[mode].label} eingestellt.`);
    return true;
  } catch (e) {
    dynMsg(e.message);
    log('err', `Dynamik: ${e.message}`);
    try { setModeUI(await load.getMode()); } catch {}
    return false;
  }
}

async function readDynamic() {
  const p = await load.getDynamic();
  if (!p) {
    dynMsg('Das Gerät ist nicht im Dynamik-Modus.');
    return;
  }
  fillDynForm(p);
  dynMsg(`Einstellung vom Gerät gelesen: ${DYN_MODES[p.mode].label}.`);
}

$('btnDynApply').addEventListener('click', applyDynamic);
$('btnDynStart').addEventListener('click', async () => {
  if (!(await applyDynamic())) return;
  try {
    await load.setInput(true);
    setInputUI(true);
    dynMsg(`${DYN_MODES[$('dynMode').value].label} läuft${DYN_MODES[$('dynMode').value].trigger ? ' – mit „Trigger auslösen“ schalten' : ''}.`);
  } catch (e) {
    dynMsg(e.message);
  }
});
$('btnDynStop').addEventListener('click', async () => {
  try {
    await load.setInput(false);
    setInputUI(false);
    dynMsg('Eingang aus.');
  } catch (e) {
    dynMsg(e.message);
  }
});
$('btnDynTrig').addEventListener('click', async () => {
  try {
    await load.trigger();
  } catch (e) {
    dynMsg(e.message);
  }
});
$('btnDynRead').addEventListener('click', () => readDynamic().catch((e) => dynMsg(e.message)));

// ---------- Entladetest (interne Batterietest-Funktion) ----------
const battMsg = (text) => { $('battMsg').textContent = text; };
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-3, Math.abs(b) * 1e-3);

function setBattState(text, cls) {
  $('battState').textContent = text;
  $('battState').className = `status ${cls}`;
}

function fmtDuration(minutes) {
  const s = Math.round(minutes * 60);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderBattery() {
  const b = state.batt;
  if (!b) return;
  $('bCap').textContent = b.cap < 1 ? `${(b.cap * 1000).toFixed(1)} mAh` : `${b.cap.toFixed(4)} Ah`;
  $('bEnergy').textContent = `${b.energyWh.toFixed(3)} Wh${b.external ? '*' : ''}`;
  $('bTime').textContent = fmtDuration(b.minutes);
  $('bVolt').textContent = b.vStart === null ? '—' : `${b.vStart.toFixed(3)} / ${b.vEnd.toFixed(3)} V`;
  $('bVavg').textContent = b.cap > 0 && !b.external ? `${(b.energyWh / b.cap).toFixed(3)} V` : '—';
}

function readBattForm() {
  const p = {
    slot: Number($('battSlot').value),
    current: Number($('battCurrent').value),
    cutoff: Number($('battCutoff').value),
    capacity: Number($('battCapacity').value),
    minutes: Number($('battMinutes').value),
  };
  if (!(p.current > 0 && p.current <= MODES.CC.max)) throw new Error(`Der Entladestrom muss zwischen 0 und ${MODES.CC.max} A liegen.`);
  if (!(p.cutoff >= 0 && p.cutoff <= MODES.CV.max)) throw new Error('Ungültige Schlussspannung.');
  if (!(p.capacity > 0)) throw new Error('Die Kapazitätsgrenze muss größer als 0 sein.');
  if (!(p.minutes > 0)) throw new Error('Das Zeitlimit muss größer als 0 sein.');
  return p;
}

function fillBattForm(p) {
  $('battCurrent').value = p.current;
  $('battCutoff').value = p.cutoff;
  $('battCapacity').value = p.capacity;
  $('battMinutes').value = Number(p.minutes.toFixed(2));
}

$('btnBattLoad').addEventListener('click', async () => {
  const slot = Number($('battSlot').value);
  try {
    await load.recallBattery(slot);
    setModeUI(await load.getMode());
    const p = await load.readBattery();
    if (!p) {
      battMsg(`Platz ${slot} ist leer.`);
    } else {
      fillBattForm(p);
      battMsg(`Platz ${slot} geladen (Strombereich ${p.range} A). Die Last steht jetzt im Batterietest-Modus.`);
    }
  } catch (e) {
    battMsg(e.message);
  }
});

async function startBattery() {
  let p;
  try {
    p = readBattForm();
  } catch (e) {
    battMsg(e.message);
    return;
  }
  $('btnBattStart').disabled = true;
  try {
    if (await load.getInput()) throw new Error('Der Eingang ist eingeschaltet – bitte zuerst ausschalten.');
    const ocv = (await load.measureVI()).v;
    if (ocv <= p.cutoff) {
      throw new Error(`Die Leerlaufspannung ${ocv.toFixed(3)} V liegt nicht über der Schlussspannung – ist die Batterie angeschlossen?`);
    }
    battMsg('Parameter werden im Gerät gespeichert …');
    await load.saveBattery(p.slot, p);
    await load.recallBattery(p.slot);
    const back = await load.readBattery();
    if (!back || !near(back.current, p.current) || !near(back.cutoff, p.cutoff) ||
        !near(back.capacity, p.capacity) || !near(back.minutes, p.minutes)) {
      throw new Error(`Das Gerät hat die Parameter nicht wie gewünscht übernommen (gelesen: ${JSON.stringify(back)}).`);
    }
    setModeUI('BATTERY');
    if ($('battClear').checked) $('btnClear').click();

    state.batt = {
      running: true, params: p, ocv, external: false, stopRequested: false,
      lastT: null, energyWh: 0, cap: 0, minutes: 0, vStart: null, vEnd: null,
    };
    await load.setInput(true);
    setInputUI(true);
    setBattState('läuft', 'run');
    battMsg(`Gestartet ${new Date().toLocaleTimeString()} · Leerlauf ${ocv.toFixed(3)} V · ` +
      `${p.current} A bis ${p.cutoff} V / ${p.capacity} Ah / ${p.minutes} min (Platz ${p.slot}).`);
    log('info', `Entladetest gestartet: ${p.current} A, Schluss ${p.cutoff} V`);
    renderBattery();
  } catch (e) {
    battMsg(e.message);
    log('err', `Entladetest: ${e.message}`);
  }
  updateControls();
  schedulePoll(0);
}

/** Wird bei jedem Messzyklus aufgerufen, solange der Test läuft. */
async function updateBattery(m) {
  const b = state.batt;
  const on = await load.getInput();
  setInputUI(on);
  const now = Date.now();
  if (on) {
    if (b.lastT !== null) b.energyWh += (m.p * (now - b.lastT)) / 3_600_000;
    b.lastT = now;
    // nur Messungen unter Last für Start-/Endspannung verwenden
    if (!b.params.current || m.i > 0.5 * b.params.current) {
      if (b.vStart === null) b.vStart = m.v;
      b.vEnd = m.v;
    }
  }
  try {
    b.cap = await load.batteryCapacity();
    b.minutes = await load.batteryMinutes();
  } catch (e) {
    log('err', `Kapazität/Zeit nicht lesbar: ${e.message}`);
  }
  if (!on) finishBattery();
  renderBattery();
}

function finishBattery() {
  const b = state.batt;
  if (!b?.running) return;
  b.running = false;
  const p = b.params;
  let reason, cls = 'done';
  if (b.stopRequested) {
    reason = 'manuell gestoppt';
    cls = 'off';
  } else if (p.capacity && b.cap >= p.capacity * 0.999) {
    reason = 'Kapazitätsgrenze erreicht';
  } else if (p.minutes && b.minutes >= p.minutes * 0.999) {
    reason = 'Zeitlimit erreicht';
  } else if (b.vEnd !== null && p.cutoff >= 0 && b.vEnd <= p.cutoff + Math.max(0.05 * p.cutoff, 0.1)) {
    reason = 'Schlussspannung erreicht';
  } else {
    reason = 'Eingang aus – Schlussspannung erreicht oder am Gerät ausgeschaltet';
    cls = 'fail';
  }
  setBattState('beendet', cls);
  battMsg(`Beendet ${new Date().toLocaleTimeString()}: ${reason}.`);
  log('info', `Entladetest beendet: ${reason} · ${b.cap.toFixed(4)} Ah · ${b.energyWh.toFixed(3)} Wh · ${fmtDuration(b.minutes)}`);
  updateControls();
}

async function stopBattery() {
  const b = state.batt;
  if (!b?.running) return;
  b.stopRequested = true;
  try {
    await load.setInput(false);
    setInputUI(false);
    b.cap = await load.batteryCapacity();
    b.minutes = await load.batteryMinutes();
  } catch (e) {
    log('err', e.message);
  }
  finishBattery();
  renderBattery();
}

/** Beim Verbinden: läuft am Gerät bereits ein Batterietest? Dann weiter beobachten. */
async function attachRunningBattery() {
  const p = await load.readBattery();
  if (p) fillBattForm(p);
  state.batt = {
    running: true, external: true, stopRequested: false,
    params: p ?? { current: 0, cutoff: -1, capacity: 0, minutes: 0 },
    lastT: null, energyWh: 0, cap: await load.batteryCapacity(), minutes: await load.batteryMinutes(),
    vStart: null, vEnd: null,
  };
  setBattState('läuft', 'run');
  battMsg('Laufender Batterietest am Gerät erkannt. Energie (*) wird erst ab jetzt gezählt.');
  updateControls();
  renderBattery();
}

$('btnBattStart').addEventListener('click', startBattery);
$('btnBattStop').addEventListener('click', stopBattery);

// ---------- Konsole ----------
$('consoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('cmd').value.trim();
  if (!cmd) return;
  $('cmd').value = '';
  try {
    if (cmd.endsWith('?')) {
      const r = await load.query(cmd);
      log('info', `${cmd} = ${r}`);
    } else {
      await load.write(cmd);
    }
  } catch (err) {
    log('err', err.message);
  }
});

// ---------- Start ----------
if (!KEL103.supported()) {
  $('unsupported').hidden = false;
  $('btnConnect').disabled = true;
}
updateControls();
setModeUI('CC');
updateDynFields();
renderRi([]);
window.addEventListener('beforeunload', () => {
  // Best effort: Eingang beim Schließen der Seite ausschalten
  if (load.connected && $('offOnDisconnect').checked) load.setInput(false);
});
