# KEL103 Web-Steuerung

Browser-Oberfläche zur Steuerung der elektronischen Last **KORAD KEL103** über die
serielle Schnittstelle (USB) mit der [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API).
Kein Build-Schritt, keine Abhängigkeiten – reines HTML/CSS/JavaScript.

## Funktionen

- Verbinden über USB-Seriell (Baudrate wählbar, Standard 115200)
- Live-Anzeige von Spannung, Strom und Leistung mit Verlaufsdiagramm (Zeitfenster, Fadenkreuz)
- Dynamik-Funktionen: dynamisches CV/CC/CR/CW, Puls und Toggle mit Trigger
- Entladetest über die interne Batterietest-Funktion der Last (Abschaltung im Gerät)
- Innenwiderstandsmessung von Batterien mit mehreren Strompulsen
- Eingang ein-/ausschalten
- Betriebsart CC / CV / CR / CW wählen und Sollwert setzen
- Aufzeichnung mit Energie- (Wh) und Ladungszähler (Ah), CSV-Export
- Konsole für beliebige SCPI-Befehle
- Optional: Eingang beim Trennen automatisch ausschalten

## Starten

Web Serial gibt es nur in **Chrome / Edge (Desktop)** und nur in sicherem Kontext
(`https://` oder `http://localhost`). Ein Doppelklick auf `index.html` (`file://`) reicht
nicht, weil der Browser dort keine JavaScript-Module lädt – also kurz einen lokalen Server starten:

```sh
# im Projektordner
python -m http.server 8000
```

Dann <http://localhost:8000> öffnen, **Verbinden** klicken und den COM-Port der Last wählen.

> Die Baudrate muss mit der Einstellung im Gerät übereinstimmen (Menü *System → Baudrate*).

## Verwendete Befehle

| Zweck | Befehl |
|---|---|
| Identifikation | `*IDN?` |
| Messwerte | `:MEAS:VOLT?` `:MEAS:CURR?` `:MEAS:POW?` |
| Eingang | `:INP ON` / `:INP OFF` / `:INP?` |
| Betriebsart | `:FUNC CC\|CV\|CR\|CW` / `:FUNC?` |
| Sollwerte | `:CURR 1.5A` `:VOLT 12V` `:RES 10OHM` `:POW 50W` (jeweils auch mit `?`) |
| Batterietest speichern | `:BATT 10,3A,0.5A,4.5V,10AH,600M` (Platz, Bereich, Strom, Schlussspannung, Kapazität, Zeit in min) |
| Batterietest abrufen | `:RCL:BATT 10`, Parameter lesen mit `:RCL:BATT?` |
| Batterietest Ergebnis | `:BATT:CAP?` → `0.0016AH`, `:BATT:TIM?` → `0.1891M` |

| Dynamik CV/CR/CW | `:DYN 1,1V,2V,1HZ,40%` (`3` mit `OHM`, `4` mit `W`) |
| Dynamik CC | `:DYN 2,0.1A/uS,0.1A/uS,0.2A,0.6A,1HZ,50%` (Anstieg 1, Anstieg 2, I1, I2, f, Tastgrad) |
| Puls / Toggle | `:DYN 5,0.1A/uS,0.1A/uS,0.2A,0.6A,0.5S` / `:DYN 6,0.1A/uS,0.1A/uS,0.2A,0.6A`, auslösen mit `*TRG` |
| Dynamik lesen | `:DYN?` (antwortet nur im Dynamik-Modus) |

### Dynamik (am Gerät geprüft)

- Tastgrad = Zeitanteil von Wert 2. Grenzen: 0,001–10000 Hz, 1–99 %, Anstieg 0,001–1 A/µs, Pulsbreite 0,001–100 s (nur Einheit `S`).
- `:FUNC?` liefert `CONTINUOUS CC` usw., `PULSE` oder `TOGGLE`.
- Ein fehlerhaft aufgebauter `:DYN`-Befehl wird stillschweigend verworfen – die Website liest deshalb jede Einstellung zurück.
- Die Messwerte der Last werden nur etwa alle 200 ms aktualisiert.

### Verhalten des internen Batterietests (am Gerät geprüft, Firmware V3.21)

- `:RCL:BATT n` schaltet in den Modus `BATTERY` (`:FUNC?` → `BATTERY`) und setzt Kapazität/Zeit auf 0.
- `:INP ON` startet den Test. **Jedes** erneute Einschalten beginnt wieder bei 0 – es gibt keine Pause.
- Die Last schaltet den Eingang selbst ab, wenn Schlussspannung, Kapazität oder Zeit erreicht sind.
  Kapazität und Zeit bleiben danach lesbar, bis die Betriebsart gewechselt wird.
- `:RCL:BATT?` während eines laufenden Tests stört den Test nicht.

Das Gerät verarbeitet Befehle nicht zuverlässig, wenn sie zu schnell hintereinander
kommen. `kel103.js` stellt deshalb alle Befehle in eine Warteschlange und lässt nach
jedem Befehl 50 ms Pause.

## Dateien

- `index.html` – Oberfläche
- `style.css` – Gestaltung (helles/dunkles Farbschema)
- `kel103.js` – Treiber: serielle Verbindung, Befehlswarteschlange, KEL103-Befehle
- `app.js` – UI-Logik, Messschleife, Entladetest, Innenwiderstand, CSV-Export
- `plot.js` – Diagramme (Zeitverlauf, U-I-Kennlinie) ohne externe Bibliothek

Hersteller-PDFs im Ordner sind per `.gitignore` vom Repository ausgeschlossen.
