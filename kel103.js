// Treiber für die elektronische Last KORAD KEL103 über die Web Serial API.
// Protokoll: SCPI-artige ASCII-Befehle, Abschluss mit "\n", Standard 115200 Baud 8N1.
// Das Gerät verträgt keine schnell aufeinanderfolgenden Befehle – daher werden alle
// Befehle in eine Warteschlange gestellt und mit einer kleinen Pause getrennt.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MODES = {
  CC: { label: 'Konstantstrom (CC)', set: ':CURR', unit: 'A', suffix: 'A', max: 30, step: 0.001 },
  CV: { label: 'Konstantspannung (CV)', set: ':VOLT', unit: 'V', suffix: 'V', max: 120, step: 0.001 },
  CR: { label: 'Konstantwiderstand (CR)', set: ':RES', unit: 'Ω', suffix: 'OHM', max: 7500, step: 0.01 },
  CW: { label: 'Konstantleistung (CW)', set: ':POW', unit: 'W', suffix: 'W', max: 300, step: 0.01 },
};

// Dynamik-Modi (:DYN). Parameterreihenfolge am Gerät geprüft (Firmware V3.21):
//   1/3/4: Wert1, Wert2, Frequenz HZ, Tastgrad %        (Tastgrad = Zeitanteil von Wert 2)
//   2:     Anstieg1 A/uS, Anstieg2 A/uS, I1 A, I2 A, Frequenz HZ, Tastgrad %
//   5:     Anstieg1, Anstieg2, Grundstrom, Pulsstrom, Pulsbreite S   (Auslösen mit *TRG)
//   6:     Anstieg1, Anstieg2, Strom1, Strom2                         (Umschalten mit *TRG)
export const DYN_MODES = {
  1: { label: 'Dynamik CV', base: 'CV', suffix: 'V', slopes: false, freq: true },
  2: { label: 'Dynamik CC', base: 'CC', suffix: 'A', slopes: true, freq: true },
  3: { label: 'Dynamik CR', base: 'CR', suffix: 'OHM', slopes: false, freq: true },
  4: { label: 'Dynamik CW', base: 'CW', suffix: 'W', slopes: false, freq: true },
  5: { label: 'Puls (Trigger)', base: 'CC', suffix: 'A', slopes: true, width: true, trigger: true },
  6: { label: 'Toggle (Trigger)', base: 'CC', suffix: 'A', slopes: true, trigger: true },
};
export const DYN_LIMITS = {
  freq: [0.001, 10000],
  duty: [1, 99],
  slope: [0.001, 1],
  width: [0.001, 100],
};

export class KEL103 {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.waiter = null;
    this.queue = Promise.resolve();
    this.gap = 50; // ms Pause nach jedem Befehl
    this.timeout = 1000; // ms Wartezeit auf eine Antwort
    this.onLog = () => {};
    this.onDisconnect = () => {};
    this._encoder = new TextEncoder();
  }

  static supported() {
    return 'serial' in navigator;
  }

  get connected() {
    return this.port !== null;
  }

  async connect(baudRate = 115200) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this._readLoop();
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this._rejectWaiter(new Error('Verbindung getrennt'));
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await port.close(); } catch {}
    this.reader = this.writer = null;
    this.onDisconnect();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (line) this._onLine(line);
        }
      }
    } catch (e) {
      this.onLog('err', `Lesefehler: ${e.message}`);
    }
    // Gerät abgezogen oder Port geschlossen
    if (this.port) await this.disconnect();
  }

  _onLine(line) {
    this.onLog('rx', line);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(line);
    }
  }

  _rejectWaiter(err) {
    if (!this.waiter) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(err);
  }

  _waitLine(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Zeitüberschreitung – keine Antwort'));
      }, timeout);
      this.waiter = { resolve, reject, timer };
    });
  }

  async _raw(cmd) {
    if (!this.writer) throw new Error('Nicht verbunden');
    this.onLog('tx', cmd);
    await this.writer.write(this._encoder.encode(cmd + '\n'));
  }

  _enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Befehl ohne Antwort senden. */
  write(cmd) {
    return this._enqueue(async () => {
      await this._raw(cmd);
      await sleep(this.gap);
    });
  }

  /** Abfrage senden und die Antwortzeile zurückgeben. */
  query(cmd, timeout = this.timeout) {
    return this._enqueue(async () => {
      const line = this._waitLine(timeout);
      await this._raw(cmd);
      try {
        return await line;
      } finally {
        await sleep(this.gap);
      }
    });
  }

  async queryNumber(cmd) {
    const v = parseFloat(await this.query(cmd));
    if (Number.isNaN(v)) throw new Error(`Ungültige Antwort auf ${cmd}`);
    return v;
  }

  // ---- High-Level-Befehle ----

  identify() {
    return this.query('*IDN?');
  }

  async measure() {
    const v = await this.queryNumber(':MEAS:VOLT?');
    const i = await this.queryNumber(':MEAS:CURR?');
    const p = await this.queryNumber(':MEAS:POW?');
    return { v, i, p };
  }

  /** Schneller: nur Spannung und Strom abfragen, Leistung berechnen. */
  async measureVI() {
    const v = await this.queryNumber(':MEAS:VOLT?');
    const i = await this.queryNumber(':MEAS:CURR?');
    return { v, i, p: v * i };
  }

  setInput(on) {
    return this.write(`:INP ${on ? 'ON' : 'OFF'}`);
  }

  async getInput() {
    const r = (await this.query(':INP?')).toUpperCase();
    return r === 'ON' || r === '1';
  }

  setMode(mode) {
    if (!MODES[mode]) throw new Error(`Unbekannter Modus ${mode}`);
    return this.write(`:FUNC ${mode}`);
  }

  /** Liefert CC/CV/CR/CW, im Batterietest 'BATTERY', sonst die Rohantwort (z. B. Dynamik-/Listenmodus). */
  async getMode() {
    const r = (await this.query(':FUNC?')).toUpperCase();
    if (r.startsWith('BATT')) return 'BATTERY';
    // Dynamik: "CONTINUOUS CC", "PULSE", "TOGGLE"
    if (r.startsWith('CONT') || r.startsWith('PULSE') || r.startsWith('TOGGLE')) return 'DYNAMIC';
    // Manche Firmwares antworten mit "CP" statt "CW"
    if (r.startsWith('CP')) return 'CW';
    return Object.keys(MODES).find((m) => r.startsWith(m)) ?? r;
  }

  setSetpoint(mode, value) {
    const m = MODES[mode];
    if (!m) throw new Error(`Unbekannter Modus ${mode}`);
    if (!(value >= 0 && value <= m.max)) throw new Error(`Wert außerhalb 0…${m.max} ${m.unit}`);
    return this.write(`${m.set} ${value}${m.suffix}`);
  }

  getSetpoint(mode) {
    return this.queryNumber(`${MODES[mode].set}?`);
  }

  // ---- Dynamik ----

  /** p: { v1, v2, freq, duty, s1, s2, width } – nicht benötigte Felder werden ignoriert. */
  setDynamic(mode, p) {
    const d = DYN_MODES[mode];
    if (!d) throw new Error(`Unbekannter Dynamik-Modus ${mode}`);
    const f = (x) => Number(Number(x).toFixed(4));
    const parts = [mode];
    if (d.slopes) parts.push(`${f(p.s1)}A/uS`, `${f(p.s2)}A/uS`);
    parts.push(`${f(p.v1)}${d.suffix}`, `${f(p.v2)}${d.suffix}`);
    if (d.freq) parts.push(`${f(p.freq)}HZ`, `${f(p.duty)}%`);
    if (d.width) parts.push(`${f(p.width)}S`);
    return this.write(`:DYN ${parts.join(',')}`);
  }

  /** Aktuelle Dynamik-Einstellung; null, wenn das Gerät nicht im Dynamik-Modus ist. */
  async getDynamic() {
    let r;
    try {
      r = await this.query(':DYN?', 600);
    } catch {
      return null;
    }
    const parts = r.split(',').map((s) => parseFloat(s));
    const mode = parts.shift();
    const d = DYN_MODES[mode];
    if (!d) return null;
    const p = { mode };
    if (d.slopes) [p.s1, p.s2] = parts.splice(0, 2);
    [p.v1, p.v2] = parts.splice(0, 2);
    if (d.freq) [p.freq, p.duty] = parts.splice(0, 2);
    if (d.width) [p.width] = parts.splice(0, 1);
    return p;
  }

  /** Löst im Puls-/Toggle-Modus einmal aus. */
  trigger() {
    return this.write('*TRG');
  }

  // ---- Interner Batterietest ----
  // Am Gerät geprüft (Firmware V3.21):
  //   :BATT <platz>,<bereich>A,<strom>A,<schlussspannung>V,<kapazität>AH,<zeit>M  speichert Platz 1–10
  //   :RCL:BATT <platz>   ruft den Platz ab (Modus BATTERY, Zähler auf 0)
  //   :RCL:BATT?          -> "3.000A, 0.500A, 4.500V, 0.100AH, 1.000M"
  //   :INP ON             startet den Test – jedes Einschalten beginnt wieder bei 0
  //   :BATT:CAP? / :BATT:TIM?  -> "0.0016AH" / "0.1891M" (nur im Modus BATTERY)
  // Die Last schaltet den Eingang selbst ab, sobald eine Schlussbedingung erreicht ist.

  /** Strombereich: 3 A (feinere Auflösung) oder 30 A */
  static batteryRange(current) {
    return current <= 3 ? 3 : 30;
  }

  saveBattery(slot, { current, cutoff, capacity, minutes }) {
    const range = KEL103.batteryRange(current);
    const f = (x) => Number(x.toFixed(4));
    return this.write(`:BATT ${slot},${range}A,${f(current)}A,${f(cutoff)}V,${f(capacity)}AH,${f(minutes)}M`);
  }

  recallBattery(slot) {
    return this.write(`:RCL:BATT ${slot}`);
  }

  /** Parameter des zuletzt abgerufenen Platzes; null, wenn der Platz leer ist. */
  async readBattery() {
    let r;
    try {
      r = await this.query(':RCL:BATT?', 600);
    } catch {
      return null;
    }
    const parts = r.split(',').map((s) => s.trim());
    if (parts.length < 5) throw new Error(`Unerwartete Antwort auf :RCL:BATT?: ${r}`);
    const [range, current, cutoff, capacity, time] = parts.map(parseFloat);
    const minutes = /S$/i.test(parts[4]) ? time / 60 : time;
    return { range, current, cutoff, capacity, minutes };
  }

  batteryCapacity() {
    return this.queryNumber(':BATT:CAP?'); // Ah
  }

  async batteryMinutes() {
    const r = await this.query(':BATT:TIM?');
    const v = parseFloat(r);
    if (Number.isNaN(v)) throw new Error(`Ungültige Antwort auf :BATT:TIM?: ${r}`);
    return /S$/i.test(r) ? v / 60 : v;
  }
}
