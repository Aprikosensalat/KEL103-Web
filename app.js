import { KEL103, MODES, DYN_MODES, DYN_LIMITS } from './kel103.js';
import { TimePlot, drawXY } from './plot.js';
import { RunStore, Recorder, runToCsv, fileName, makeZip } from './runs.js';
import { LogViewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const load = new KEL103();
const store = new RunStore();
const storeOpened = store.open(); // sofort öffnen; Schreibzugriffe warten darauf
const rec = new Recorder(store, () => scheduleFilesRefresh());
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
  busy: null, // id des Start-Knopfs des laufenden Website-Tests (Ri, Kurzschluss)
  abort: false,
  batt: null, // interner Batterietest
  list: null, // laufende Sequenz
  flags: null, // letzter :STAT?-Stand (Remote Sense, Trigger, Tastensperre)
  flagCycle: 0,
};
const battRunning = () => state.batt?.running === true;
const listRunning = () => state.list?.running === true;
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-3, Math.abs(b) * 1e-3);
const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

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
  // Routineabfragen nicht ins Log schreiben, sonst läuft es voll
  if (kind !== 'err' && /^:MEAS:|^:BATT:(CAP|TIM)\?|^-?[\d.]+(V|A|W|AH|M)$|^:INP\?$|^(ON|OFF)$/.test(text)) return;
  log(kind, text);
};

// ---------- Reiter ----------
const tabButtons = [...document.querySelectorAll('[data-tab]')];
function showTab(name) {
  if (!tabButtons.some((b) => b.dataset.tab === name)) name = tabButtons[0].dataset.tab;
  for (const b of tabButtons) {
    const active = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(active));
    $(`tab-${b.dataset.tab}`).hidden = !active;
  }
  storageSet('kel103.tab', name);
  if (name === 'ri') renderRi(state.riPoints ?? []); // Canvas braucht sichtbare Breite
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));

const TEST_TABS = { btnRi: 'ri', btnShort: 'short' };
function markRunningTabs() {
  const running = new Set();
  if (battRunning()) running.add('batt');
  if (listRunning()) running.add('list');
  if (state.busy) running.add(TEST_TABS[state.busy]);
  if (['DYNAMIC'].includes(state.mode) && state.inputOn) running.add('dyn');
  for (const b of tabButtons) b.classList.toggle('running', running.has(b.dataset.tab));
}

// ---------- UI-Zustand ----------
function updateControls() {
  const connected = load.connected;
  const anyTest = !!state.busy || battRunning() || listRunning();
  const free = connected && !anyTest;
  $('btnConnect').textContent = connected ? 'Trennen' : 'Verbinden';
  $('status').textContent = connected ? 'verbunden' : 'getrennt';
  $('status').classList.toggle('on', connected);

  // Grundsteuerung bleibt bei Batterietest/Sequenz bedienbar (z. B. Eingang aus = Stopp)
  for (const id of ['btnInput', 'mode', 'setpoint', 'btnApply', 'btnPoll', 'cmd', 'btnSend']) {
    $(id).disabled = !connected || !!state.busy;
  }

  // Website-Tests: der laufende Knopf wird zu „Abbrechen“
  for (const id of Object.keys(TEST_TABS)) {
    const btn = $(id);
    const mine = state.busy === id;
    btn.disabled = !(mine || free);
    btn.textContent = mine ? 'Abbrechen' : btn.dataset.label;
    btn.classList.toggle('primary', !mine);
  }

  for (const id of ['btnDynStart', 'btnDynApply', 'btnDynRead']) $(id).disabled = !free;
  $('btnDynStop').disabled = !connected || !!state.busy;
  $('btnDynTrig').disabled = !free || !DYN_MODES[$('dynMode').value]?.trigger;

  $('btnBattLoad').disabled = !free;
  $('btnBattStart').disabled = !free;
  $('btnBattStop').disabled = !connected || !battRunning();

  $('btnListStart').disabled = !free;
  $('btnListSave').disabled = !free;
  $('btnListStop').disabled = !connected || !listRunning();

  for (const id of ['btnMemSave', 'btnMemRecall', 'sysBeep', 'sysLock', 'sysSenseCb', 'btnSysRead']) $(id).disabled = !free;

  if (!connected) {
    $('idn').textContent = '—';
    $('devFlags').hidden = true;
    $('riSense').hidden = true;
    state.flags = null;
    setInputUI(false);
  }
  markRunningTabs();
}

function setInputUI(on) {
  const was = state.inputOn;
  state.inputOn = on;
  if (!on && rec.run?.endOnInputOff) rec.end('Eingang aus');
  // Eingang ohne laufenden Test eingeschaltet (Knopf oder am Gerät) -> eigene Datei „Manuell“
  if (on && !was && !rec.active && !state.busy && !battRunning() && !listRunning() && load.connected) {
    rec.start('manual', `Manuell – ${modeText()}`, { endOnInputOff: true, params: { Betriebsart: modeText() } });
  }
  const btn = $('btnInput');
  btn.textContent = on ? 'Eingang AUS' : 'Eingang EIN';
  btn.classList.toggle('is-on', on);
  $('inputState').textContent = on ? 'Eingang an' : 'Eingang aus';
  $('inputState').classList.toggle('on', on);
  markRunningTabs();
}

const SPECIAL_MODES = { BATTERY: 'Batterietest (intern)', DYNAMIC: 'Dynamik', LIST: 'Sequenz', SHORT: 'Kurzschluss' };

function modeText() {
  const m = MODES[state.mode];
  if (!m) return SPECIAL_MODES[state.mode] ?? state.mode;
  const set = $('curSet').textContent;
  return set && set !== '—' ? `${state.mode} ${set}` : state.mode;
}

function setModeUI(mode) {
  state.mode = mode;
  const m = MODES[mode];
  if (!m) {
    $('mode').value = SPECIAL_MODES[mode] ? mode : '';
    $('unit').textContent = '—';
    $('curSet').textContent = '—';
    markRunningTabs();
    return;
  }
  $('mode').value = mode;
  $('unit').textContent = m.unit;
  $('setpoint').max = m.max;
  $('setpoint').step = m.step;
  markRunningTabs();
}

function addOptions(select, entries, disabled = false) {
  for (const [value, text] of entries) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    opt.disabled = disabled;
    select.appendChild(opt);
  }
}
addOptions($('mode'), Object.entries(MODES).map(([k, m]) => [k, m.label]));
addOptions($('mode'), Object.entries(SPECIAL_MODES), true);
addOptions($('dynMode'), Object.entries(DYN_MODES).map(([k, d]) => [k, d.label]));
$('dynMode').value = '2';
addOptions($('battSlot'), Array.from({ length: 10 }, (_, i) => [i + 1, i + 1]));
$('battSlot').value = '10';
addOptions($('listSlot'), Array.from({ length: 7 }, (_, i) => [i + 1, i + 1]));
$('listSlot').value = '7';

// ---------- Verbindung ----------
async function connect() {
  try {
    await load.connect(Number($('baud').value), { usb: $('transport').value === 'usb' });
  } catch (e) {
    if (e.name !== 'NotFoundError') log('err', `Verbinden fehlgeschlagen: ${e.message}`);
    return;
  }
  log('info', 'Port geöffnet');
  // Bedienung sperren, bis der Gerätezustand eingelesen ist (sonst können veraltete Werte Klicks überschreiben)
  state.busy = 'connect';
  updateControls();
  try {
    $('idn').textContent = await load.identify();
    const on = await load.getInput();
    const mode = await load.getMode();
    setModeUI(mode);
    await refreshSetpoint();
    // laufende Abläufe erkennen, bevor der Eingangsstatus eine „Manuell“-Datei anlegt
    if (mode === 'BATTERY' && on) await attachRunningBattery();
    if (mode === 'LIST' && on) attachRunningList();
    setInputUI(on);
    if (mode === 'DYNAMIC') await readDynamic();
  } catch (e) {
    log('err', `${e.message} – richtiger Port gewählt? Bei RS232 muss die Baudrate passen (am Gerät: Shift + 0).`);
  }
  try {
    await readSystem();
  } catch (e) {
    log('err', `Systemwerte nicht lesbar: ${e.message}`);
  }
  state.busy = null;
  updateControls();
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
  const kept = $('offOnDisconnect').checked
    ? 'der Eingang wurde ausgeschaltet.'
    : 'der Ablauf läuft am Gerät weiter. Zum Weiterverfolgen neu verbinden.';
  if (battRunning()) {
    state.batt.running = false;
    setBattState('getrennt', 'fail');
    battMsg(`Verbindung getrennt – ${kept}`);
  }
  if (listRunning()) {
    state.list.running = false;
    setListState('getrennt', 'fail');
    listMsg(`Verbindung getrennt – ${kept}`);
  }
  rec.end('Verbindung getrennt');
  updateControls();
  log('info', 'Port geschlossen');
};

$('btnConnect').addEventListener('click', () => (load.connected ? disconnect() : connect()));

// ---------- Grundsteuerung ----------
$('btnInput').addEventListener('click', async () => {
  if (battRunning() && state.inputOn) return stopBattery();
  if (listRunning() && state.inputOn) return stopList();
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
    rec.event(`Betriebsart ${mode}`);
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
    rec.event(`Sollwert ${value} ${MODES[state.mode]?.unit ?? ''}`.trim());
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
  // Während eines Website-Tests liefert der Test selbst die Messwerte
  if (state.busy) return schedulePoll();
  const started = performance.now();
  try {
    // Leistung aus U·I: passt in jeder Zeile zu Spannung und Strom (und spart eine Abfrage)
    const m = await load.measureVI();
    if (battRunning()) {
      const info = await readBatteryInfo();
      addSample(m, { kapazitaet_mAh: info.cap * 1000, testzeit_min: info.minutes });
      processBattery(m, info);
    } else {
      addSample(m);
      if (listRunning()) {
        await updateList();
      } else if (state.cycle++ % 5 === 0 || rec.active) {
        // Eingangsstatus nachlesen (könnte am Gerät umgeschaltet worden sein)
        setInputUI(await load.getInput());
      }
    }
    // Remote Sense / Triggerung / Tastensperre gelegentlich nachlesen (am Gerät umschaltbar)
    if (state.flagCycle++ % 10 === 9) await refreshFlags();
  } catch (e) {
    if (load.connected) log('err', e.message);
  }
  const elapsed = performance.now() - started;
  schedulePoll(Math.max(0, Number($('interval').value) - elapsed));
}

function addSample({ v, i, p }, extra = {}) {
  const t = Date.now();
  const prev = state.history[state.history.length - 1];
  if (prev) {
    const dtH = (t - prev.t) / 3_600_000;
    state.energyWh += ((p + prev.p) / 2) * dtH;
    state.chargeAh += ((i + prev.i) / 2) * dtH;
  }
  state.history.push({ t, v, i, p, test: rec.run?.meta.name ?? '' });
  rec.add(t, v, i, p, extra);
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

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const csvFormat = () => $('csvFormat').value;
$('csvFormat').value = storageGet('kel103.csv') ?? 'de';
$('csvFormat').addEventListener('change', () => storageSet('kel103.csv', csvFormat()));

$('btnCsv').addEventListener('click', () => {
  if (!state.history.length) return;
  const meta = {
    name: 'Gesamtverlauf', startT: state.history[0].t, endT: state.history[state.history.length - 1].t,
    params: {}, extraCols: [{ key: 'test', text: true }], noInfo: true,
  };
  const csv = runToCsv(meta, state.history, csvFormat());
  downloadBlob(new Blob([csv], { type: 'text/csv' }), fileName(meta));
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

// ---------- Gemeinsamer Rahmen für Website-Tests ----------

/**
 * Misst `ms` lang so schnell wie möglich.
 * vmin: Abbruch mit Fehler bei Unterspannung; stopIf(m): vorzeitig (ohne Fehler) beenden.
 */
async function sampleFor(ms, { vmin = null, stopIf = null } = {}) {
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
    if (stopIf?.(m)) break;
  } while (performance.now() < end);
  return out;
}

/**
 * Führt einen Test exklusiv aus: Messschleife pausiert, Eingang am Ende sicher aus,
 * Betriebsart und CC/CW-Sollwerte werden wiederhergestellt.
 * Ein zweiter Klick auf denselben Knopf bricht ab.
 */
async function runExclusive(btnId, fn, onError) {
  if (state.busy) {
    if (state.busy === btnId) state.abort = true;
    return;
  }
  if (!load.connected || battRunning() || listRunning()) return;
  state.busy = btnId;
  state.abort = false;
  updateControls();

  const saved = {};
  try { saved.mode = await load.getMode(); } catch {}
  try { saved.cc = await load.getSetpoint('CC'); } catch {}
  try { saved.cw = await load.getSetpoint('CW'); } catch {}

  try {
    await fn();
  } catch (e) {
    onError?.(e);
    log('err', e.message);
  } finally {
    try { await load.setInput(false); setInputUI(false); } catch {}
    try {
      if (saved.cc !== undefined) await load.setSetpoint('CC', saved.cc);
      if (saved.cw !== undefined) await load.setSetpoint('CW', saved.cw);
      await load.setMode(MODES[saved.mode] ? saved.mode : 'CC');
      setModeUI(await load.getMode());
      await refreshSetpoint();
    } catch {}
    state.busy = null;
    state.abort = false;
    updateControls();
    schedulePoll(0);
  }
}

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

const inRange = (x, [a, b]) => x >= a && x <= b;
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

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
function dynParams() {
  const mode = $('dynMode').value;
  const d = DYN_MODES[mode];
  const unit = MODES[d.base].unit;
  const [l1, l2] = DYN_LABELS[mode];
  const p = { Modus: d.label, [l1]: `${$('dynV1').value} ${unit}`, [l2]: `${$('dynV2').value} ${unit}` };
  if (d.freq) { p.Frequenz = `${$('dynFreq').value} Hz`; p['Tastgrad Wert 2'] = `${$('dynDuty').value} %`; }
  if (d.width) p.Pulsbreite = `${$('dynWidth').value} s`;
  if (d.slopes) { p['Anstieg 1'] = `${$('dynS1').value} A/µs`; p['Anstieg 2'] = `${$('dynS2').value} A/µs`; }
  return p;
}

$('btnDynStart').addEventListener('click', async () => {
  if (!(await applyDynamic())) return;
  try {
    const params = dynParams();
    const vals = Object.values(params).slice(1, 3).join(' / ');
    rec.start('dyn', `Dynamik – ${params.Modus} ${vals}`, { params, endOnInputOff: true });
    await load.setInput(true);
    setInputUI(true);
    const d = DYN_MODES[$('dynMode').value];
    dynMsg(`${d.label} läuft${d.trigger ? ' – mit „Trigger auslösen“ schalten' : ''}.`);
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
    rec.event('Trigger');
  } catch (e) {
    dynMsg(e.message);
  }
});
$('btnDynRead').addEventListener('click', () => readDynamic().catch((e) => dynMsg(e.message)));

// ---------- Sequenz ----------
const listMsg = (text) => { $('listMsg').textContent = text; };
const LIST_LIMITS = { steps: 84, slope: [0.001, 1], seconds: [0.01, 999], repeat: [1, 999] };

function setListState(text, cls) {
  $('listState').textContent = text;
  $('listState').className = `status ${cls}`;
}

function addListRow(step = { current: 0.5, slope: 0.1, seconds: 1 }) {
  const tbody = $('listTable').tBodies[0];
  if (tbody.rows.length >= LIST_LIMITS.steps) return;
  const tr = tbody.insertRow();
  tr.insertCell();
  for (const [key, stepAttr] of [['current', '0.001'], ['slope', '0.001'], ['seconds', '0.01']]) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = stepAttr;
    input.value = step[key];
    input.dataset.key = key;
    input.addEventListener('input', updateListInfo);
    tr.insertCell().appendChild(input);
  }
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Stufe entfernen';
  del.addEventListener('click', () => {
    if (tbody.rows.length > 1) tr.remove();
    updateListInfo();
  });
  tr.insertCell().appendChild(del);
  updateListInfo();
}

function readListForm() {
  const range = Number($('listRange').value);
  const repeat = Number($('listRepeat').value);
  const steps = [...$('listTable').tBodies[0].rows].map((tr) => {
    const get = (k) => Number(tr.querySelector(`[data-key="${k}"]`).value);
    return { current: get('current'), slope: get('slope'), seconds: get('seconds') };
  });
  return { range, repeat, steps };
}

function validateList({ range, repeat, steps }) {
  check(steps.length >= 1 && steps.length <= LIST_LIMITS.steps, `1 bis ${LIST_LIMITS.steps} Stufen erlaubt.`);
  check(Number.isInteger(repeat) && inRange(repeat, LIST_LIMITS.repeat), `Durchläufe: ${LIST_LIMITS.repeat[0]} bis ${LIST_LIMITS.repeat[1]}.`);
  steps.forEach((s, k) => {
    check(inRange(s.current, [0, range]), `Stufe ${k + 1}: Strom muss zwischen 0 und ${range} A liegen (Strombereich).`);
    check(inRange(s.slope, LIST_LIMITS.slope), `Stufe ${k + 1}: Anstieg muss zwischen ${LIST_LIMITS.slope[0]} und ${LIST_LIMITS.slope[1]} A/µs liegen.`);
    check(inRange(s.seconds, LIST_LIMITS.seconds), `Stufe ${k + 1}: Dauer muss zwischen ${LIST_LIMITS.seconds[0]} und ${LIST_LIMITS.seconds[1]} s liegen.`);
  });
}

function listDuration({ repeat, steps }) {
  return steps.reduce((s, x) => s + x.seconds, 0) * repeat;
}

function fmtSeconds(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s - h * 3600 - m * 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${Math.round(sec)} s` : `${sec.toFixed(sec < 10 ? 2 : 0)} s`;
}

function updateListInfo() {
  const form = readListForm();
  const n = form.steps.length;
  $('btnListAdd').disabled = n >= LIST_LIMITS.steps;
  [...$('listTable').tBodies[0].rows].forEach((tr, k) => { tr.cells[0].textContent = k + 1; });
  const per = listDuration({ ...form, repeat: 1 });
  $('listInfo').textContent = `${n} Stufe${n === 1 ? '' : 'n'} · ${fmtSeconds(per)} pro Durchlauf · gesamt ${fmtSeconds(per * form.repeat)}`;
}

function fillListForm({ range, repeat, steps }) {
  $('listRange').value = String(range);
  $('listRepeat').value = repeat;
  $('listTable').tBodies[0].innerHTML = '';
  for (const s of steps) addListRow(s);
  updateListInfo();
}

function loadListFromBrowser() {
  const saved = storageGet(`kel103.list.${$('listSlot').value}`);
  if (saved) {
    fillListForm(saved);
    listMsg(`Zuletzt auf Platz ${$('listSlot').value} gespeicherte Sequenz (aus dem Browser) geladen.`);
  } else {
    listMsg(`Für Platz ${$('listSlot').value} ist im Browser nichts gespeichert – die Tabelle zeigt die aktuelle Eingabe.`);
  }
}
$('listSlot').addEventListener('change', loadListFromBrowser);
$('listRepeat').addEventListener('input', updateListInfo);
$('listRange').addEventListener('change', updateListInfo);
$('btnListAdd').addEventListener('click', () => addListRow());

async function saveList(start) {
  let form;
  try {
    form = readListForm();
    validateList(form);
  } catch (e) {
    listMsg(e.message);
    return;
  }
  const slot = Number($('listSlot').value);
  try {
    if (state.inputOn) {
      await load.setInput(false);
      setInputUI(false);
    }
    await load.saveList(slot, form);
    storageSet(`kel103.list.${slot}`, form);
    if (!start) {
      listMsg(`Sequenz auf Platz ${slot} gespeichert.`);
      return;
    }
    await load.recallList(slot);
    const mode = await load.getMode();
    setModeUI(mode);
    if (mode !== 'LIST') throw new Error(`Die Last ist nicht in den Sequenz-Modus gewechselt (Modus: ${mode}).`);
    state.list = { running: true, slot, startT: Date.now(), total: listDuration(form) };
    rec.start('list', `Sequenz – Platz ${slot}, ${form.steps.length} Stufen × ${form.repeat}`, {
      params: {
        Speicherplatz: slot,
        Strombereich: `${form.range} A`,
        Durchläufe: form.repeat,
        Stufen: form.steps.map((s) => `${s.current} A/${s.slope} A/µs/${s.seconds} s`).join(' · '),
      },
    });
    await load.setInput(true);
    setInputUI(true);
    setListState('läuft', 'run');
    listMsg(`Sequenz von Platz ${slot} läuft (voraussichtlich ${fmtSeconds(state.list.total)}).`);
    log('info', `Sequenz gestartet: Platz ${slot}, ${form.steps.length} Stufen × ${form.repeat}`);
  } catch (e) {
    listMsg(e.message);
    log('err', `Sequenz: ${e.message}`);
    if (listRunning()) {
      state.list.running = false;
      rec.end(`Fehler: ${e.message}`);
    }
  }
  updateControls();
  schedulePoll(0);
}

async function updateList() {
  const on = await load.getInput();
  setInputUI(on);
  const l = state.list;
  if (!on) {
    finishList('beendet', 'done', 'Sequenz abgeschlossen.');
    return;
  }
  if (l.total) {
    const elapsed = (Date.now() - l.startT) / 1000;
    listMsg(`Sequenz läuft: ${fmtSeconds(elapsed)} von ca. ${fmtSeconds(l.total)} (${Math.min(100, (100 * elapsed) / l.total).toFixed(0)} %).`);
  }
}

function finishList(text, cls, msg) {
  if (!listRunning()) return;
  state.list.running = false;
  setListState(text, cls);
  listMsg(`${msg} (${new Date().toLocaleTimeString()})`);
  log('info', msg);
  if (rec.run?.meta.type === 'list') rec.end(msg);
  updateControls();
}

async function stopList() {
  try {
    await load.setInput(false);
    setInputUI(false);
  } catch (e) {
    log('err', e.message);
  }
  finishList('gestoppt', 'off', 'Sequenz gestoppt.');
}

function attachRunningList() {
  state.list = { running: true, slot: null, startT: Date.now(), total: 0 };
  rec.start('list', 'Sequenz (laufend am Gerät erkannt)');
  setListState('läuft', 'run');
  listMsg('Laufende Sequenz am Gerät erkannt.');
  updateControls();
}

$('btnListSave').addEventListener('click', () => saveList(false));
$('btnListStart').addEventListener('click', () => saveList(true));
$('btnListStop').addEventListener('click', stopList);

// ---------- Entladetest (interne Batterietest-Funktion) ----------
const battMsg = (text) => { $('battMsg').textContent = text; };

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
  check(p.current > 0 && p.current <= MODES.CC.max, `Der Entladestrom muss zwischen 0 und ${MODES.CC.max} A liegen.`);
  check(p.cutoff >= 0 && p.cutoff <= MODES.CV.max, 'Ungültige Schlussspannung.');
  check(p.capacity > 0, 'Die Kapazitätsgrenze muss größer als 0 sein.');
  check(p.minutes > 0, 'Das Zeitlimit muss größer als 0 sein.');
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
    const sense = await senseParam();

    state.batt = {
      running: true, params: p, ocv, external: false, stopRequested: false,
      lastT: null, energyWh: 0, cap: 0, minutes: 0, vStart: null, vEnd: null,
    };
    rec.start('batt', `Entladetest – ${p.current} A bis ${p.cutoff} V`, {
      params: {
        Speicherplatz: p.slot,
        Entladestrom: `${p.current} A`,
        Schlussspannung: `${p.cutoff} V`,
        Kapazitätsgrenze: `${p.capacity} Ah`,
        Zeitlimit: `${p.minutes} min`,
        Leerlaufspannung: `${ocv.toFixed(4)} V`,
        'Remote Sense': sense,
      },
      extraCols: BATT_COLS,
    });
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
    if (battRunning()) {
      state.batt.running = false;
      rec.end(`Fehler: ${e.message}`);
    }
  }
  updateControls();
  schedulePoll(0);
}

const BATT_COLS = [{ key: 'kapazitaet_mAh', digits: 2 }, { key: 'testzeit_min', digits: 3 }];

/** Eingangsstatus, Kapazität und Testzeit vom Gerät lesen. */
async function readBatteryInfo() {
  const b = state.batt;
  const info = { on: await load.getInput(), cap: b.cap, minutes: b.minutes };
  try {
    info.cap = await load.batteryCapacity();
    info.minutes = await load.batteryMinutes();
  } catch (e) {
    log('err', `Kapazität/Zeit nicht lesbar: ${e.message}`);
  }
  return info;
}

/** Wird bei jedem Messzyklus aufgerufen, solange der Test läuft (nach addSample). */
function processBattery(m, { on, cap, minutes }) {
  const b = state.batt;
  if (!b?.running) return; // während des Abfragens gestoppt – Werte sind veraltet
  setInputUI(on);
  b.cap = cap;
  b.minutes = minutes;
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
  if (rec.run?.meta.type === 'batt') {
    rec.end(reason, {
      'Ergebnis Kapazität': `${(b.cap * 1000).toFixed(1)} mAh`,
      'Ergebnis Energie': `${b.energyWh.toFixed(3)} Wh${b.external ? ' (erst ab Wiederverbinden gezählt)' : ''}`,
      'Ergebnis Dauer': fmtDuration(b.minutes),
      'Spannung Start/Ende': b.vStart === null ? '—' : `${b.vStart.toFixed(3)} / ${b.vEnd.toFixed(3)} V`,
    });
  }
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
  rec.start('batt', 'Entladetest (laufend am Gerät erkannt)', {
    params: p ? {
      Entladestrom: `${p.current} A`, Schlussspannung: `${p.cutoff} V`,
      Kapazitätsgrenze: `${p.capacity} Ah`, Zeitlimit: `${p.minutes.toFixed(2)} min`,
    } : {},
    extraCols: BATT_COLS,
  });
  setBattState('läuft', 'run');
  battMsg('Laufender Batterietest am Gerät erkannt. Energie (*) wird erst ab jetzt gezählt.');
  updateControls();
  renderBattery();
}

$('btnBattStart').addEventListener('click', startBattery);
$('btnBattStop').addEventListener('click', stopBattery);

// ---------- Innenwiderstand ----------
const riStatus = (text) => { $('riStatus').textContent = text; };

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
  if (!$('tab-ri').hidden) drawXY($('riPlot'), points, fit);
  state.riPoints = points;
}

async function runRi() {
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
  const points = [];
  renderRi(points);

  await runExclusive('btnRi', async () => {
    const sense = await senseParam();
    rec.start('ri', `Innenwiderstand – ${currents.join(' / ')} A`, {
      params: {
        Prüfströme: `${currents.join(' / ')} A`,
        Pulsdauer: `${pulse / 1000} s`,
        Pause: `${pause / 1000} s`,
        Abbruchgrenze: `${vmin} V`,
        'Remote Sense': sense,
      },
    });
    riStatus('Leerlaufspannung wird gemessen …');
    rec.setPhase('Leerlauf');
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
      rec.setPhase(`Puls ${k + 1}: ${current} A`);
      await load.setSetpoint('CC', current);
      await load.setInput(true);
      setInputUI(true);
      let samples;
      try {
        samples = await sampleFor(pulse, { vmin });
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
        rec.setPhase('Pause');
        await sampleFor(pause);
      }
    }
    riStatus(`Fertig (${new Date().toLocaleTimeString()}).`);
  }, (e) => riStatus(`Abgebrochen: ${e.message}`));

  if (rec.run?.meta.type === 'ri') {
    const fit = fitLine(points);
    const result = { Messpunkte: points.map((p) => `${p.i.toFixed(3)} A → ${p.v.toFixed(4)} V`).join(' · ') };
    if (fit) Object.assign(result, { 'Ergebnis Ri': fmtOhm(fit.r), 'Ergebnis U0': `${fit.v0.toFixed(4)} V`, 'R²': fit.r2.toFixed(4) });
    rec.end($('riStatus').textContent, result);
  }
}
$('btnRi').addEventListener('click', () => (state.busy === 'btnRi' ? runExclusive('btnRi') : runRi()));

// ---------- Kurzschluss ----------
async function runShort() {
  const msg = (t) => { $('shortMsg').textContent = t; };
  const dur = Number($('shortDur').value);
  if (!inRange(dur, [0.5, 60])) {
    msg('Die Dauer muss zwischen 0,5 und 60 s liegen.');
    return;
  }
  if (!confirm(`Eingang für ${dur} s kurzschließen?\n\nNur bei kurzschlussfesten Quellen (z. B. Netzteil mit Strombegrenzung) – niemals an Akkus oder Batterien!`)) return;
  $('shortResult').textContent = '';

  await runExclusive('btnShort', async () => {
    rec.start('short', `Kurzschluss – ${dur} s`, { params: { Dauer: `${dur} s` } });
    await load.setInput(false);
    setInputUI(false);
    await load.setShort();
    const mode = await load.getMode();
    setModeUI(mode);
    if (mode !== 'SHORT') throw new Error(`Die Last ist nicht in den Kurzschluss-Modus gewechselt (Modus: ${mode}).`);
    msg('Kurzschluss aktiv …');
    rec.setPhase('Kurzschluss');
    await load.setInput(true);
    setInputUI(true);
    let samples;
    try {
      samples = await sampleFor(dur * 1000);
    } finally {
      await load.setInput(false);
      setInputUI(false);
    }
    rec.setPhase('');
    const tail = samples.slice(-3);
    const iMax = Math.max(...samples.map((m) => m.i));
    $('shortResult').innerHTML = `Kurzschlussstrom ${avg(tail, 'i').toFixed(3)} A` +
      `<small>Restspannung ${avg(tail, 'v').toFixed(3)} V · Höchstwert ${iMax.toFixed(3)} A · ${samples.length} Messungen</small>`;
    rec.setParam('Ergebnis Kurzschlussstrom', `${avg(tail, 'i').toFixed(3)} A`);
    rec.setParam('Ergebnis Restspannung', `${avg(tail, 'v').toFixed(3)} V`);
    msg(`Fertig (${new Date().toLocaleTimeString()}).`);
  }, (e) => msg(`Abgebrochen: ${e.message}`));
  if (rec.run?.meta.type === 'short') rec.end($('shortMsg').textContent);
}
$('btnShort').addEventListener('click', () => (state.busy === 'btnShort' ? runExclusive('btnShort') : runShort()));

// ---------- Speicher & System ----------
const memMsg = (t) => { $('memMsg').textContent = t; };

function memSlot() {
  const n = Number($('memSlot').value);
  check(Number.isInteger(n) && inRange(n, [1, 100]), 'Platz muss zwischen 1 und 100 liegen.');
  return n;
}

$('btnMemSave').addEventListener('click', async () => {
  try {
    const n = memSlot();
    await load.saveMemory(n);
    memMsg(`Aktuelle Einstellung auf Platz ${n} gespeichert.`);
  } catch (e) {
    memMsg(e.message);
  }
});

$('btnMemRecall').addEventListener('click', async () => {
  try {
    const n = memSlot();
    if (state.inputOn) {
      await load.setInput(false);
      setInputUI(false);
    }
    await load.recallMemory(n);
    const mode = await load.getMode();
    setModeUI(mode);
    $('curSet').textContent = 'abgerufen (Abfrage zeigt ggf. alten Wert)';
    memMsg(`Platz ${n} abgerufen – Betriebsart ${MODES[mode]?.label ?? mode}.`);
  } catch (e) {
    memMsg(e.message);
  }
});

function setFlag(id, on, onText, offText, onCls = 'on') {
  $(id).textContent = on ? onText : offText;
  $(id).className = `status ${on ? onCls : 'off'}`;
}

function renderFlags(st) {
  state.flags = st;
  $('devFlags').hidden = false;
  setFlag('flagSense', st.sense, 'Remote Sense an', 'Remote Sense aus');
  setFlag('flagTrig', st.extTrigger, 'Ext. Trigger an', 'Ext. Trigger aus');
  setFlag('flagLock', st.lock, 'Tasten gesperrt', 'Tasten frei', 'warn');
  $('sysSense').textContent = st.sense ? 'an (Spannung wird an den Sense-Klemmen gemessen)' : 'aus';
  $('sysTrig').textContent = st.extTrigger ? 'an' : 'aus';
  $('sysBeep').checked = st.beep;
  $('sysLock').checked = st.lock;
  $('sysSenseCb').checked = st.sense;
  $('sysBaud').textContent = st.baud ? `${st.baud} Baud` : '—';
  const hint = $('riSense');
  hint.hidden = false;
  hint.className = st.sense ? 'hint ok' : 'hint';
  hint.textContent = st.sense
    ? 'Remote Sense ist an – die Spannung wird direkt an den Sense-Klemmen gemessen, Leitungswiderstände fallen heraus.'
    : 'Remote Sense ist aus – der Widerstand von Lastleitungen und Klemmen wird mitgemessen. Für genaue Werte Sense-Leitungen anschließen und Remote Sense im Reiter „Speicher & System“ einschalten.';
}

async function refreshFlags() {
  try {
    renderFlags(await load.status());
  } catch (e) {
    log('err', `Status nicht lesbar: ${e.message}`);
  }
}

/** Sense-Zustand für Messdateien (frisch abgefragt). */
async function senseParam() {
  try {
    const st = await load.status();
    renderFlags(st);
    return st.sense ? 'an' : 'aus (Leitungswiderstand wird mitgemessen)';
  } catch {
    return 'unbekannt';
  }
}

async function readSystem() {
  const st = await load.status();
  renderFlags(st);
  const lim = await load.limits();
  const fmt = ([lo, hi], unit) => `${lo} … ${hi} ${unit}`;
  $('limV').textContent = fmt(lim.V, 'V');
  $('limI').textContent = fmt(lim.I, 'A');
  $('limR').textContent = fmt(lim.R, 'Ω');
  $('limP').textContent = fmt(lim.P, 'W');
}

$('sysBeep').addEventListener('change', async () => {
  try {
    await load.setBeep($('sysBeep').checked);
    $('sysBeep').checked = await load.getBeep();
  } catch (e) {
    log('err', e.message);
  }
});
$('sysLock').addEventListener('change', async () => {
  try {
    await load.setLock($('sysLock').checked);
    $('sysLock').checked = await load.getLock();
    await refreshFlags();
  } catch (e) {
    log('err', e.message);
  }
});
$('sysSenseCb').addEventListener('change', async () => {
  const want = $('sysSenseCb').checked;
  try {
    if (state.inputOn) {
      alert('Remote Sense bitte nur bei ausgeschaltetem Eingang umschalten.');
      $('sysSenseCb').checked = !want;
      return;
    }
    if (want && !confirm('Remote Sense einschalten?\n\nNur wenn Lastleitungen UND Sense-Leitungen angeschlossen sind (Plus an Plus, Minus an Minus). Sense-Leitungen nie ohne Lastleitungen verbinden.')) {
      $('sysSenseCb').checked = false;
      return;
    }
    await load.setSense(want);
    $('sysSenseCb').checked = await load.getSense();
    rec.event(`Remote Sense ${$('sysSenseCb').checked ? 'an' : 'aus'}`);
    await refreshFlags();
  } catch (e) {
    log('err', e.message);
  }
});
$('btnSysRead').addEventListener('click', () => readSystem().catch((e) => log('err', e.message)));

// ---------- Messdateien ----------
let fileList = [];
const selectedFiles = new Set();
let filesTimer = null;

function scheduleFilesRefresh() {
  if (filesTimer) return;
  filesTimer = setTimeout(() => { filesTimer = null; refreshFiles(); }, 200);
}

async function refreshFiles() {
  try {
    fileList = await store.list();
  } catch (e) {
    log('err', `Messdateien nicht lesbar: ${e.message}`);
    fileList = [];
  }
  // laufende Datei mit aktuellem Stand aus dem Speicher anzeigen
  const active = rec.run?.meta;
  if (active) {
    fileList = fileList.filter((m) => m.id !== active.id);
    fileList.push(active);
  }
  fileList.sort((a, b) => b.startT - a.startT);
  for (const id of [...selectedFiles]) if (!fileList.some((m) => m.id === id)) selectedFiles.delete(id);
  renderFiles();
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function renderFiles() {
  const tbody = $('filesTable').tBodies[0];
  tbody.innerHTML = '';
  const activeId = rec.run?.meta.id;
  for (const meta of fileList) {
    const tr = tbody.insertRow();
    const isActive = meta.id === activeId;
    tr.classList.toggle('active', isActive);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedFiles.has(meta.id);
    cb.setAttribute('aria-label', `${meta.name} auswählen`);
    cb.addEventListener('change', () => {
      cb.checked ? selectedFiles.add(meta.id) : selectedFiles.delete(meta.id);
      updateFileButtons();
    });
    tr.insertCell().appendChild(cb);

    const name = tr.insertCell();
    const title = document.createElement('span');
    title.className = 'fname';
    title.textContent = meta.name;
    const sub = document.createElement('span');
    sub.className = 'fsub';
    sub.textContent = isActive ? 'läuft …' : meta.endT ? meta.endReason || '' : 'nicht abgeschlossen (Seite geschlossen oder Absturz)';
    name.append(title, sub);

    tr.insertCell().textContent = new Date(meta.startT).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
    const endT = meta.endT ?? (isActive ? Date.now() : meta.lastT ?? meta.startT);
    tr.insertCell().textContent = fmtDur(endT - meta.startT);
    tr.insertCell().textContent = meta.count.toLocaleString('de-DE');

    const actions = tr.insertCell();
    const view = document.createElement('button');
    view.textContent = 'Ansehen';
    view.title = 'Im Diagramm ansehen (Zoom, Cursor)';
    view.addEventListener('click', () => viewer.open(meta).catch((e) => log('err', `Messdatei nicht lesbar: ${e.message}`)));
    const dl = document.createElement('button');
    dl.textContent = 'CSV';
    dl.title = 'Als CSV herunterladen';
    dl.addEventListener('click', () => downloadFiles([meta.id]));
    const del = document.createElement('button');
    del.textContent = 'Löschen';
    del.disabled = isActive;
    del.addEventListener('click', () => deleteFiles([meta.id]));
    actions.append(view, dl, del);
  }
  $('filesEmpty').hidden = fileList.length > 0;
  $('filesInfo').textContent = `${fileList.length} Datei${fileList.length === 1 ? '' : 'en'}` +
    (store.persistent ? '' : ' · nur bis zum Neuladen (Browser-Speicher nicht verfügbar)');
  updateFileButtons();
}

function updateFileButtons() {
  const n = selectedFiles.size;
  $('btnFilesDl').disabled = n === 0;
  $('btnFilesDl').textContent = n ? `${n} ausgewählte herunterladen` : 'Ausgewählte herunterladen';
  $('btnFilesDel').disabled = n === 0;
  $('btnFilesAll').disabled = fileList.length === 0;
  $('filesAllCb').checked = n > 0 && n === fileList.length;
  $('filesAllCb').indeterminate = n > 0 && n < fileList.length;
}

async function fileCsv(meta) {
  if (meta.id === rec.run?.meta.id) await rec.flushNow();
  const rows = await store.rows(meta.id);
  return runToCsv(meta, rows, csvFormat());
}

async function downloadFiles(ids) {
  const metas = fileList.filter((m) => ids.includes(m.id));
  if (!metas.length) return;
  try {
    if (metas.length === 1) {
      downloadBlob(new Blob([await fileCsv(metas[0])], { type: 'text/csv' }), fileName(metas[0]));
      return;
    }
    const files = [];
    for (const meta of metas) files.push({ name: fileName(meta), data: await fileCsv(meta) });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(makeZip(files), `kel103_messdateien_${stamp}_${metas.length}.zip`);
  } catch (e) {
    log('err', `Download fehlgeschlagen: ${e.message}`);
  }
}

async function deleteFiles(ids) {
  const activeId = rec.run?.meta.id;
  const del = ids.filter((id) => id !== activeId);
  if (!del.length) return;
  if (!confirm(`${del.length === 1 ? 'Messdatei' : `${del.length} Messdateien`} endgültig löschen?`)) return;
  for (const id of del) {
    try { await store.remove(id); } catch (e) { log('err', e.message); }
    selectedFiles.delete(id);
    if (viewer.id === id) viewer.close();
  }
  refreshFiles();
}

// ---------- Betrachter für Messdateien ----------
const viewer = new LogViewer($('viewerCard'), {
  load: async (meta) => {
    if (meta.id === rec.run?.meta.id) await rec.flushNow();
    return store.rows(meta.id);
  },
});
// laufende Aufzeichnung im Betrachter regelmäßig nachladen
setInterval(() => {
  if (viewer.id && viewer.id === rec.run?.meta.id) viewer.reload().catch(() => {});
}, 5000);

$('filesAllCb').addEventListener('change', () => {
  if ($('filesAllCb').checked) fileList.forEach((m) => selectedFiles.add(m.id));
  else selectedFiles.clear();
  renderFiles();
});
$('btnFilesDl').addEventListener('click', () => downloadFiles([...selectedFiles]));
$('btnFilesAll').addEventListener('click', () => downloadFiles(fileList.map((m) => m.id)));
$('btnFilesDel').addEventListener('click', () => deleteFiles([...selectedFiles]));
// Dauer/Anzahl der laufenden Datei regelmäßig aktualisieren
setInterval(() => { if (rec.active) renderFiles(); }, 2000);

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
// Schnittstelle: Web Serial am Desktop, WebUSB unter Android (dort kann Web Serial nur Bluetooth)
{
  const hasSerial = 'serial' in navigator, hasUsb = 'usb' in navigator;
  const android = /Android/i.test(navigator.userAgent);
  for (const opt of $('transport').options) opt.hidden = opt.value === 'usb' ? !hasUsb : !hasSerial;
  const saved = storageGet('kel103.transport');
  $('transport').value = (saved === 'usb' && hasUsb) || (saved === 'serial' && hasSerial) ? saved
    : (android || !hasSerial) && hasUsb ? 'usb' : 'serial';
  $('transport').addEventListener('change', () => storageSet('kel103.transport', $('transport').value));
}
fillListForm({ range: 3, repeat: 1, steps: [{ current: 0.2, slope: 0.1, seconds: 1 }, { current: 0.6, slope: 0.1, seconds: 1 }] });
loadListFromBrowser();
updateDynFields();
setModeUI('CC');
showTab(storageGet('kel103.tab') ?? 'dyn');
updateControls();
storeOpened.then(() => {
  navigator.storage?.persist?.().catch(() => {}); // Browser bitten, die Messdateien nicht automatisch zu löschen
  refreshFiles();
});
window.addEventListener('beforeunload', () => {
  // Best effort: Eingang beim Schließen der Seite ausschalten
  if (load.connected && $('offOnDisconnect').checked) load.setInput(false);
});
