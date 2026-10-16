# Subagents: Modell- und Reasoning-Zuteilung

Diese Datei legt fest, **welches Modell mit welcher Reasoning-Stufe** welche Arbeit in Navify übernimmt und
**welche Arbeitspakete selbstständig bzw. parallel** laufen können.

Grundsatz: **nicht verschwenden, aber auch nicht unterdimensionieren.** Das Modell richtet sich nach der Schwierigkeit
und dem Risiko einer Aufgabe, nicht nach Gewohnheit.

## Stufen

| Stufe | Modell · Reasoning      | Typische Aufgaben                                                                                                                                                  |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1    | Haiku · niedrig         | Mechanisches: Umbenennen, Boilerplate, Format-Fixes, Icons/Assets, i18n-Keys anlegen, Übersetzung DE↔EN                                                            |
| S2    | Sonnet · niedrig–mittel | Recherche und Faktencheck (APIs, Crate-Versionen), Codebase-Suche, Doku/README, einfache Unit-Tests nach klarer Spezifikation                                      |
| S3    | Sonnet · mittel         | Standard-UI-Seiten und -Komponenten, Adapter-Endpunkte nach Faktenblatt, Einstellungsabschnitte                                                                    |
| S4    | Sonnet · hoch           | Komplexe UI (Drag & Drop mit Virtualisierung, Lyrics-Sync, EQ-Kurveneditor), Download-Manager, SQLite-Schema und Statistik-SQL, Jellyfin-Adapter, Wrapped          |
| S5    | Opus · hoch             | Audio-Engine-Kern (Threads, Gapless, Crossfade, Seek), DSP- und EQ-Mathematik, Architekturentscheidungen, Nebenläufigkeits- und Audio-Glitch-Bugs, Security-Review |
| S6    | Opus · xhigh            | Nur Eskalation: kritischer Bug nach gescheitertem S5-Versuch, Abschluss-Architekturreview vor einem Release                                                        |

## Regeln

1. **Eskalation statt Wiederholung:** Scheitert ein Ergebnis in der Review, geht es eine Stufe höher. Dieselbe Stufe wird nicht einfach erneut versucht.
2. **Untergrenze für Kritisches:** Audio-Thread, Echtzeit-Code, Nebenläufigkeit, DB-Migrationen und Sicherheit nie unter S3. Audio-DSP und Engine-Kern sind immer S5.
3. **Audioqualität geht vor:** Alles, was den Klang beeinflusst, wird mit Messtests abgesichert (Frequenzgang, Gapless-Kontinuität, Limiter-Ceiling) und nicht nur „nach Gefühl“ übernommen.
4. **Review:** Jede Subagent-Arbeit wird von der Hauptsitzung mit Build, Lint und Tests geprüft, bevor sie übernommen wird.
5. **Klarer Auftrag:** Jeder Auftrag nennt Dateien, Schnittstellen und Definition of Done. Je klarer die Spezifikation, desto niedriger kann die Stufe sein.
6. **Parallel nur mit festen Schnittstellen:** Parallel arbeiten erst, wenn die gemeinsame Schnittstelle committet ist (siehe unten). Zwei Agents schreiben nie gleichzeitig in dieselben Dateien.

## Arbeitspakete

Legende: **Selbstständig** heißt, das Paket kann nach Erfüllung der Abhängigkeit ohne Rückfragen von einem Agent
(oder in einer eigenen Session) erledigt werden.

### Grundlagen und Server

| Paket                                                                 | Abhängig von | Selbstständig            | Stufe |
| --------------------------------------------------------------------- | ------------ | ------------------------ | ----- |
| M0 Projektgerüst, CI, Updater-Konfiguration                           | –            | nein (Hauptsitzung)      | –     |
| `src/api/provider.ts` – gemeinsames Datenmodell und Interface         | M0           | nein (Architektur)       | S5    |
| Subsonic/OpenSubsonic-Adapter                                         | provider.ts  | ja                       | S3    |
| Subsonic-Adapter-Tests mit MSW und aufgezeichneten Antworten          | Adapter      | ja                       | S2    |
| Jellyfin-Adapter                                                      | provider.ts  | ja, parallel zu Subsonic | S4    |
| Login-/Server-Dialog, Keyring-Anbindung                               | provider.ts  | ja                       | S3    |
| Lokale Testserver (Navidrome, Jellyfin) und Testbibliothek per ffmpeg | M0           | ja                       | S1    |

### Audio-Engine (Rust)

| Paket                                                                   | Abhängig von   | Selbstständig       | Stufe |
| ----------------------------------------------------------------------- | -------------- | ------------------- | ----- |
| `audio/api.rs` – Befehle, Events, `TrackSource`, `EqConfig`             | M0             | nein (Architektur)  | S5    |
| `dsp/biquad`, `dsp/eq/*` inkl. Least-Squares-Grafik-EQ und Frequenzgang | api.rs         | ja                  | S5    |
| `dsp/limiter`, `dsp/bass`, `dsp/stereo`, `dsp/smooth`, Dither           | api.rs         | ja, parallel zu EQ  | S5    |
| `source/http` – Range-Cache, LRU-Index                                  | api.rs         | ja, parallel zu DSP | S5    |
| `decode/worker`, Gapless-Trim, Resampling                               | api.rs         | ja                  | S5    |
| `engine/controller`, Slots, Crossfade, Seek/Flush                       | decode, output | nein (Integration)  | S5    |
| `output/cpal_out`, Gerätewechsel                                        | api.rs         | ja                  | S5    |
| `output/wasapi_exclusive` (bit-perfect)                                 | output-Trait   | ja                  | S5    |
| `media_controls` (SMTC)                                                 | api.rs         | ja                  | S3    |
| `analysis/spectrum` (FFT, Bänder)                                       | api.rs         | ja                  | S4    |
| Test-Fixtures (Sinus-Splits per ffmpeg)                                 | –              | ja                  | S1    |
| DSP-Messtests nach Spezifikation                                        | DSP-Module     | ja                  | S2    |

### Oberfläche

| Paket                                              | Abhängig von          | Selbstständig            | Stufe |
| -------------------------------------------------- | --------------------- | ------------------------ | ----- |
| App-Shell: Layout, resizable Panels, Routing, Zoom | M0                    | nein (Basis für alles)   | S4    |
| Startseite, Album-, Künstler-, Genre-Seite         | Shell, Adapter        | ja                       | S3    |
| Suche mit Live-Ergebnissen                         | Shell, Adapter        | ja                       | S3    |
| Bibliothek links: Filter, Sortierung, Ordner, Pins | Shell                 | ja                       | S4    |
| Playlist-Seite mit Drag & Drop und Virtualisierung | Shell, Adapter        | ja                       | S4    |
| Warteschlange mit Drag & Drop, Shuffle-Algorithmen | Player-Store          | ja                       | S4    |
| Player-Leiste, Now-Playing-Panel                   | Player-Store          | ja                       | S3    |
| EQ-Oberfläche: Kurveneditor, Analyzer, Presets     | `EqConfig`            | ja, parallel zur DSP     | S4    |
| EQ-Preset-Kurven definieren                        | `EqConfig`            | ja (danach Gegenprüfung) | S3    |
| Lyrics: Quellenkette, Vollbildansicht, Panel       | Adapter, Player-Store | ja                       | S4    |
| Downloads: Manager (Rust) und Oberfläche           | Adapter, DB           | ja                       | S4    |
| Miniplayer, Tray, Autostart, Benachrichtigungen    | Player-Store          | ja                       | S3    |
| Statistik-SQL, automatische Playlists              | DB-Schema             | ja                       | S4    |
| Wrapped-Folien, Jahrespaletten, PNG-Export         | Statistik             | ja                       | S4    |
| Einstellungsseite (Abschnitte)                     | jeweilige Features    | ja                       | S3    |
| Übersetzung Englisch, fehlende Keys                | –                     | ja                       | S1    |

### Release

| Paket                                       | Abhängig von | Selbstständig | Stufe |
| ------------------------------------------- | ------------ | ------------- | ----- |
| CI-Workflows, Release mit `tauri-action`    | M0           | ja            | S3    |
| README, Screenshots, Beitragsleitfaden      | Features     | ja            | S2    |
| Security-Review vor dem Open-Source-Release | alles        | nein          | S5    |
| Abschluss-Architekturreview                 | alles        | nein          | S6    |

## Was parallel laufen kann

Sobald die jeweilige Schnittstelle in `main` liegt:

- **Subsonic-Adapter** und **Jellyfin-Adapter**, nach `src/api/provider.ts`
- **Engine-DSP** und **EQ-Oberfläche**, nach `EqConfig` in `audio/api.rs`
- **DSP-Module**, **HTTP-Cache**, **Decoder** und **Ausgabe**, nach `audio/api.rs`
- **Lyrics**, **Statistik/Wrapped** und **Downloads**, nach DB-Schema und Player-Store
- **Übersetzungen** jederzeit
