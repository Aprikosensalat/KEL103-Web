# KEL103 Web-Steuerung

Browser-Oberfläche zur Steuerung der elektronischen Last **KORAD KEL103** über die
serielle Schnittstelle (USB) mit der [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API).
Kein Build-Schritt, keine Abhängigkeiten – reines HTML/CSS/JavaScript.

## Funktionen

- Verbinden über USB-Seriell (Baudrate wählbar, Standard 115200), unter Android über WebUSB
- Live-Anzeige von Spannung, Strom und Leistung mit Verlaufsdiagramm (Zeitfenster, Fadenkreuz)
- Sonderfunktionen in Reitern:
  - Dynamik: dynamisches CV/CC/CR/CW, Puls und Toggle mit Trigger
  - Sequenz: bis zu 84 Stromstufen mit Anstieg, Dauer und Wiederholungen (Plätze 1–7)
  - Entladetest über die interne Batterietest-Funktion der Last (Abschaltung im Gerät)
  - Innenwiderstandsmessung von Batterien mit mehreren Strompulsen
  - Kurzschluss mit Zeitbegrenzung
  - Speicherplätze 1–100, Summer, Gerätegrenzen
- Eingang ein-/ausschalten
- Betriebsart CC / CV / CR / CW wählen und Sollwert setzen
- Aufzeichnung mit Energie- (Wh) und Ladungszähler (Ah), CSV-Export
- Messdateien: Jeder Test und jedes Einschalten des Eingangs bekommt eine eigene Datei mit
  Testname, Parametern, Ergebnis und Ablauf (Spalte `info`, z. B. „Puls 2: 1 A“, „Trigger“,
  „Sollwert 0.4 A“); beim Entladetest zusätzlich `kapazitaet_mAh` und `testzeit_min`.
  Die Dateien liegen im Browser (IndexedDB, alle 5 s gesichert) und lassen sich einzeln als CSV
  oder gesammelt als ZIP herunterladen.
- **Messdatei-Betrachter** („Ansehen“): gespeicherte Dateien als Diagramm mit Zoom (Mausrad, Bereich
  aufziehen, Tasten + / −), Verschieben (Umschalt + Ziehen oder rechte Maustaste) und zwei Messcursorn A/B;
  die Tabelle zeigt Werte an A und B, Differenz, Min/Max/Mittel sowie Ladung, Energie und |ΔU/ΔI| dazwischen
- CSV wahlweise für deutsches Excel (`;`, Dezimalkomma, Ortszeit) oder international (`,`, Dezimalpunkt)
- Konsole für beliebige SCPI-Befehle
- Optional: Eingang beim Trennen automatisch ausschalten

## Andere Lasten

Über **Gerät** lässt sich auch die ITECH IT8514C+ (und ein Simulator) aus der gemeinsamen Geräteschicht
(`devices/`, wie in *Effizienzmessung-Web*) steuern: Betriebsarten CC/CV/CR/CW, Sollwert, Eingang, Messung,
Verlauf, Messdateien, Konsole und Remote Sense. Dynamik, Sequenz, Entladetest, Innenwiderstand, Kurzschluss und
Speicher bleiben der KEL103 vorbehalten. Die IT8514C+ ist nach Handbuch umgesetzt, nicht an der Hardware geprüft.

## Starten

**Online:** <https://aprikosensalat.github.io/KEL103-Web/> in Chrome oder Edge öffnen,
**Verbinden** klicken und den COM-Port der Last wählen. Die Messdateien bleiben dabei lokal im Browser.

**Android:** Chrome unter Android kann mit Web Serial nur Bluetooth-Geräte öffnen. Für das USB-Kabel
(OTG-Adapter) unter **Schnittstelle** „USB direkt (WebUSB, Android)“ wählen – unter Android ist das
voreingestellt. Die Website spricht dann das USB-Protokoll des Seriell-Chips selbst (`usbserial.js`):
USB-CDC (KORAD, VID 0x0416 / PID 0x5011 – am Gerät geprüft), Prolific PL2303 (ITECH IT8514C+) und FTDI
(R&S HMP mit HO720/HO730) – die beiden letzten nach den Linux-Treibern umgesetzt, nicht an Hardware geprüft.
Unter Windows hält der COM-Port-Treiber das Gerät, dort weiter „Seriell“ verwenden.

**Lokal:** Web Serial gibt es nur in **Chrome / Edge (Desktop)** und nur in sicherem Kontext
(`https://` oder `http://localhost`). Ein Doppelklick auf `index.html` (`file://`) reicht
nicht, weil der Browser dort keine JavaScript-Module lädt – also kurz einen lokalen Server starten:

```sh
# im Projektordner
python -m http.server 8000
```

Dann <http://localhost:8000> öffnen, **Verbinden** klicken und den COM-Port der Last wählen.

> Über USB spielt die Baudrate in der Regel keine Rolle. Bei RS232 muss sie mit der Einstellung
> im Gerät übereinstimmen (am Gerät: Shift + 0).

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
| Sequenz | `:LIST 7,3A,2,0.2A,0.1A/uS,1S,0.6A,0.1A/uS,1S,3` (Platz, Bereich, Anzahl, je Stufe I/Anstieg/Dauer, Durchläufe), `:RCL:LIST 7` |
| Kurzschluss | `:FUNC SHOR` (nicht `SHORT`!), `:FUNC?` → `SHORt` |
| Speicher | `*SAV 1`…`*SAV 100`, `*RCL n` |
| System | `:SYST:BEEP ON\|OFF`, `:SYST:BEEP?`, `:SYST:LOCK ON\|OFF`, `:SYST:LOCK?` (Tastensperre) |
| Remote Sense | `:SYST:COMP ON\|OFF`, `:SYST:COMP?` (entspricht Shift + CW, „COMM“) |
| Status | `:STAT?` → `0,3,0,0,1,0`: Summer · RS232-Baudindex · Tastensperre · ext. Triggerung · Remote Sense · ? |
| Grenzen | `:VOLT:UPP?` `:VOLT:LOW?` (ebenso `CURR`, `RES`, `POW`) |

### Einschränkungen der Firmware V3.21 (am Gerät geprüft)

- `:RCL:LIST?` antwortet nie, auch nicht nach `:FUNC LIST` – die Website merkt sich gespeicherte
  Sequenzen deshalb im Browser. `:RCL:LIST n` schaltet von selbst in den Modus `LIST`; `:FUNC LIST`
  wird ignoriert und ist nicht nötig. Es gibt nur die Plätze 1–7 (8–10 werden nicht angenommen).
  Sequenzen bis 84 Stufen, ab 0,01 s je Stufe und bis 999 Durchläufe werden angenommen.
- `:OCP …` / `:OPP …` werden nicht übernommen, auch nicht in der Form aus der Befehlsliste;
  `:RCL:OCP n` lässt die Last kurz verstummen. OCP- und OPP-Test sind deshalb nicht eingebaut.
- Nach `*RCL n` liefern `:CURR?` usw. teils noch den alten Sollwert, aktiv ist aber der abgerufene.
- Nach dem Abruf eines leeren Speicherplatzes antwortet die Last kurz nicht.
- Nur am Gerät umschaltbar: externe Triggerung (Shift + CR) und RS232-Baudrate (Shift + 0).
  Die Triggerung lässt sich über `:STAT?` abfragen. Remote Sense ist per `:SYST:COMP` schaltbar;
  die Website zeigt den Zustand an und vermerkt ihn in den Messdateien von Innenwiderstand und Entladetest.

### Remote Sense

Mit Sense-Leitungen misst die Last die Spannung direkt am Prüfling; der Spannungsabfall auf den
Lastleitungen fällt heraus (wichtig für die Innenwiderstandsmessung). Reihenfolge: zuerst Lastleitungen,
dann Sense-Leitungen (Plus an Plus) direkt an die Pole, dann Remote Sense einschalten (Website oder
Shift + CW, „COMM“). Abbauen umgekehrt.
Laut Anleitung die Sense-Leitungen nie ohne angeschlossene Lastleitungen verbinden.

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
- `runs.js` – Messdateien: Speicherung (IndexedDB), CSV- und ZIP-Erzeugung ohne externe Bibliothek
- `usbserial.js` – serielle Verbindung über WebUSB (CDC, PL2303, FTDI) für Android; identisch in KWR103-Web
- `viewer.js` – Betrachter für Messdateien (Zoom, Verschieben, Cursor A/B); identisch in KWR103-Web

Hersteller-PDFs im Ordner sind per `.gitignore` vom Repository ausgeschlossen.
