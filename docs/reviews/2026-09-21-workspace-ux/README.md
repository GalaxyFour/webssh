# WebSSH: Usability und Alltagstauglichkeit

**Prüfung vom 21. September 2026.** Grundlage sind die aktuelle lokale Anwendung,
DOM-/Accessibility-Zustände, gezielte Codeprüfung und eine echte, isolierte
OpenSSH-/SFTP-Testverbindung. Die Oberfläche wurde bei
1280 Pixeln, bei 876 Pixeln und als Smartphone-Viewport mit 390 × 844 Pixeln
betrachtet. Das ist ein Expertenreview, keine Nutzerstudie und keine vollständige
WCAG-Prüfung.

## Nachtrag: kompakter Dateibereich

Auf Nutzerfeedback wurde der Kopfbereich auf eine
kompakte Zeile reduziert: **„Ordner mit Terminal synchronisieren“**. Die
zusätzlichen Überschriften „Aktive Sitzung“ und „SFTP“, der dauerhafte Erklärungstext
und Statusmeldungen entfallen. Eine Erklärung bleibt im Tooltip; vorübergehende
Probeprobleme werden still erneut versucht.

## Nachtrag: kleine Verbesserungen direkt umgesetzt

Aus den offenen Punkten wurden fünf begrenzte Änderungen übernommen:

- **Kompakte Dateiaktionen (P2):** sieben Aktionen in einer Zeile statt zwei
  Toolbar-Zeilen; Aktualisieren bleibt einmal neben dem Pfad. Bezeichnungen
  bleiben als Tooltips und zugängliche Namen erhalten.
- **Pfadorientierung (Teil von P1):** lange Pfade zeigen unfokussiert ihr Ende;
  der vollständige Pfad steht im Tooltip und bleibt im beschrifteten Eingabefeld
  editierbar und mit Strg/Cmd+A auswählbar. Eine zusätzliche Breadcrumb-Zeile
  wurde nicht eingeführt.
- **Konsistente Begriffe (Teil von P1/P2):** mobile Werkzeuge heißen wie auf dem
  Desktop „Dateien“ und „Diagnostik“. „Connection resources“ ist jetzt in allen
  sechs Sprachen übersetzt.
- **Mobile Dateien (Teil von P2):** der schwebende Terminal-Tastaturknopf wird
  in dieser Ansicht ausgeblendet. Ein bereits geöffnetes mobiles Eingabefeld
  wird beim Wechsel zu Dateien geschlossen; sein Text wird nicht gelöscht.
- **Notizzuordnung (Teil von P2):** der vorhandene Hinweis sagt ausdrücklich,
  dass die privaten Notizen für alle eigenen Sitzungen gemeinsam gelten. Das
  entspricht der bestehenden Speicherung pro Nutzer; Autosave bleibt unverändert.

Prüfung: JS-Lint, alle 59 JS-Testdateien und die vollständige Python-Testsammlung
bestanden. Die 24 fokussierten Directory-Sync-Tests sind darin enthalten.
Die echten Dateibrowser-Komponenten wurden zusätzlich in einer isolierten
Layoutvorschau mit Testdateien im Browser bei 1280 und 390 Pixeln geprüft:
alle sieben Aktionen in derselben Zeile, Pfadende sichtbar, vollständiger Pfad
per Tastatur auswählbar und kein überlagernder Tastaturknopf bei mobiler Breite.
Die Vorschau testet die Darstellung, keine neue SSH-Verbindung.

Die übrigen Punkte unten bleiben Vorschläge; insbesondere vollständige
Datei-Tastaturnavigation, Breadcrumbs, Sitzungswiederaufnahme, Befehlspriorisierung
und Diagnostikaufbau benötigen eigene Änderungen und gezielte Integrationstests.

## Einschätzung

WebSSH hat eine gute Grundidee für tägliche Administration: Terminal, Dateien,
Befehle und Diagnostik bleiben nahe beieinander. Favoriten, Hostsuche,
Sitzungswerkzeuge und explizite Transferquellen sind nützlich. Der größte Hebel
ist weniger eine neue Optik als **weniger Kontextwechsel, mehr nutzbarer Platz
und eine eindeutige Antwort auf „Wo arbeite ich gerade?“**.

Die Oberfläche ist funktional reichhaltig, verlangt aber noch unnötig viel
Orientierung: ähnliche Bereiche heißen unterschiedlich, Aktionen sind teilweise
nur durch Icons erkennbar und lange Pfade verlieren ausgerechnet ihren letzten,
entscheidenden Ordnernamen. Das trifft gelegentliche Nutzer besonders stark.

## In diesem Änderungsstand bereits umgesetzt

1. **Ordner-Sync unter Workspaces → Dateien.** Der Haken sitzt rechts im
   kompakten Kopf des eingebetteten Dateibrowsers. Er gilt einzeln pro SSH-Sitzung und
   ist standardmäßig an. Die persönliche Vorgabe ist unter
   Einstellungen → Voreinstellungen → Terminal abschaltbar. Der eigenständige Dateimanager erhält keinen Sync-Haken.
2. **Beide Navigationsrichtungen.** Beim Einschalten übernimmt Dateien den
   Terminal-Ordner. Terminal-Navigation wird über das tatsächliche Prozessverzeichnis
   erfasst, nicht aus eingegebenen `cd`-Zeilen erraten. Ordneröffnung, Hoch,
   Home und absolute Pfade rechts wechseln per zitiertem `cd` das zugehörige
   Terminal. Dateiauswahl und Vorschau führen keine Datei aus.
3. **Verständliche Zustände.** Der Haken zeigt die aktivierte Kopplung. Vorübergehende
   Probeprobleme werden ohne zusätzliche Statuszeile erneut versucht. Bei angefangener
   Eingabe oder einer laufenden Anwendung wird kein später automatisch auszuführender
   Ordnerwechsel eingereiht.
4. **Mehr Platz in schmalen Workspaces.** Ein übernommenes Zwei-Zeilen-Raster
   reservierte Platz für den versteckten zweiten Dateibereich. Das eingebettete
   Raster hat jetzt genau eine Zeile. Bei identischem 876-Pixel-Viewport wuchs die
   gemessene Dateiliste von ungefähr **61 auf 221 Pixel Höhe**.
5. **Zugängliche Namen für die eingebetteten Dateiaktionen.** Aktualisieren,
   neuer Ordner, Download, Vorschau, Umbenennen und Löschen haben explizite,
   übersetzbare Accessible Names. Vorher wurden unter anderem
   `create_new_folder` und `drive_file_rename_outline` vorgelesen.

Der Sync arbeitet derzeit auf geeigneten **Linux-Zielhosts** mit `/proc`,
`readlink` und `ps`. WebSSH-tmux-Sitzungen werden unterstützt. Es werden keine
Shell-Konfigurationsdateien geändert. Das Abfragen läuft nur bei aktivierter,
sichtbarer Workspace-Dateiansicht, üblicherweise im Abstand von 1,5 Sekunden. Die persönliche Vorgabe gilt beim
Öffnen oder Neuladen des Workspace; einzelne Sitzungen bleiben direkt über den
Haken umschaltbar.
Bash/Zsh-/Readline-artige Prompt-Signale und ein erkannter Shell-Vordergrundprozess
begrenzen automatische Terminaleingaben. Bei fehlenden Signalen bleibt diese
Richtung pausiert. Benutzerdefinierte Prompts und gleichzeitig eingreifende
andere Clients sind keine vollständig atomar beherrschbare Shell-Schnittstelle.
Siehe die [Nutzungsdokumentation](../../wiki/SFTP-File-Workspace-and-Transfers.md#sync-the-workspace-file-browser-with-the-terminal).

## Geprüfter Ablauf und Evidenz

Englische Test-Hostnamen sind Testdaten; sie werden nicht als Übersetzungsfehler
gewertet.

### 1. Workspace-Einstieg — gut, mit unnötiger Ablenkung

Hostsuche, Favoriten und Hinweise wie „Kennwort erforderlich“ helfen beim Start.
Der persönliche Notizblock nimmt im erfassten Zustand bereits vor der ersten
Verbindung einen großen Teil der Fläche ein. Eine kompaktere Ausgangsansicht
würde den Verbindungsaufbau stärker in den Vordergrund rücken.

### 2. Schnellverbindung — klar, aber vertikal aufwendig

Die wesentlichen Felder und die feste Schaltfläche „Verbinden“ sind verständlich.
In der schmaleren Darstellung benötigt bereits der Grundbereich fast die gesamte
Höhe; letzte Verbindungen und erweiterte Optionen liegen darunter. Ein kompakter
Zielblock und eine kleinere Darstellung der letzten Verbindungen würden helfen.

### 3. Hostverwaltung — solide Informationsstruktur

Suche, Gruppen, Favoriten und eine direkte Verbinden-Aktion sind gut auffindbar.
„CONNECTION RESOURCES“ bleibt in der deutschen Oberfläche Englisch. Die
verschachtelte Navigation „Hosts → Hosts“ verbraucht Raum, ohne viel Orientierung
hinzuzufügen. Gruppenaktionen, Tastaturbedienung beim Umordnen und lange Hostnamen
verdienen einen eigenen Anschluss-Test.

### 4. Workspace-Dateien und Terminal — wesentliche Verbesserung umgesetzt

Der neue Haken ist direkt beim betroffenen Bereich. Der Praxistest zeigte:
Aktivieren übernimmt das Terminal-Verzeichnis; Ordneröffnung rechts führt links
zum passenden `cd`; laufendes `sleep` pausiert den Wechsel. Ein separates
Dateimanager-Fenster wird dabei nicht gekoppelt.

### 5. Schmaler Desktop — Layoutfehler behoben, Orientierung noch verbesserbar

Vorher reservierte das Dateiraster trotz nur eines sichtbaren Bereichs zwei
Zeilen. Nach der Korrektur kann die Liste den freien Platz nutzen. Weiterhin
sind bei dieser Breite die Hauptnavigation nur durch Icons und einige
Werkzeug-Reiter nur gekürzt sichtbar.

### 6. Smartphone-Dateiansicht — benutzbar, mit hoher Informationsdichte

Der Haken bleibt sichtbar und bedienbar. Die Dateiliste nutzt den verbleibenden
Platz. Oben „Files“, darunter „SFTP“ und unten erneut „SFTP“ benennen denselben
Kontext unterschiedlich. Entsprechend wechseln „Diagnostics“ und „Metrics“.
Der schwebende Tastaturknopf überlagert einen Teil des Transferbereichs; seine
Position sollte für dateiorientierte Ansichten überdacht werden.

### 7. Eigenständiger Dateimanager — guter Leerzustand, Kontextübergang ausbaufähig

„Quelle öffnen“ ist eine klare nächste Aktion. Beim Wechsel aus einer bereits
verbundenen Workspace-Sitzung startet dieser Bereich trotzdem ohne Quelle. Das
ist wegen unabhängiger Quellen grundsätzlich sinnvoll, sollte aber durch
„Aktuelle SSH-Sitzung hier öffnen“ ergänzt werden. Die unabhängige Arbeitsweise
muss verständlich bleiben.

### 8. Befehlswerkzeuge — gutes Einfügeprinzip, zu wenig Vorauswahl

Positiv: Zielhost, Vorschau und „Einfügen; Enter zum Ausführen“ sind explizit.
Die erfasste Auswahl enthält sehr viele unterschiedliche Befehle; selbst auf dem
Linux-Testziel erscheinen macOS-/Homebrew-Einträge. Eine kleinere, kontextbezogene
Startauswahl plus Suche wäre alltagstauglicher als eine lange Gesamtliste.

### 9. Diagnostik — wertvolle Rückmeldung, platzintensive Darstellung

Live-Zustand, Aktualisierungszeit und die konkrete Erklärung fehlender
Docker-Berechtigung stärken das Vertrauen. Große Einzelkarten verdrängen jedoch
andere Kennzahlen unter die Scrollgrenze. Die Warnung sollte auf ihren betroffenen
Bereich begrenzt bleiben, während die wichtigsten verfügbaren Werte kompakt
nebeneinander stehen.

### 10. Notizen — angenehm einfach, Geltungsbereich erklärungsbedürftig

Die Begriffe „Personal workspace“ und „Personal scratchpad“ deuten den persönlichen
Geltungsbereich an, gleichzeitig verspricht der Text Nähe zur aktiven Sitzung.
Für Nutzer sollte ohne Nachdenken erkennbar sein, ob eine Notiz global, pro Host
oder pro Sitzung gilt. Speicherung und Fehlerfeedback sollten beim Schreiben
geprüft werden; in diesem Schritt wurden keine Notizen verändert.

### 11. Einstellungen — verständliche Gruppen, wichtige Betriebsoptionen versteckt

Design, Sprache und Sitzungsverhalten sind sauber gruppiert. Die Oberfläche
erklärt ausdrücklich, dass die Anmeldung standardmäßig nach 30 Minuten auch
bei aktiver SSH-Sitzung abläuft. Das ist eine relevante Arbeitsunterbrechung,
deren Vorwarnung und Wiederaufnahme gezielt getestet werden sollten. Das Review
hat keinen 30-minütigen Ablauf absichtlich ausgelöst.

## Priorisierte nächste Verbesserungen

**P1** bedeutet hoher unmittelbarer Alltagsnutzen, **P2** weitere Verbesserung.
Die Aufwände sind relative Einschätzungen, keine Zusagen.

| Priorität | Verbesserung | Beleg und Nutzen | Abnahmekriterium | Aufwand |
|---|---|---|---|---|
| P1 | Pfad als Breadcrumb plus bearbeitbares Feld; letzten Ordner priorisieren | Schritte 4–6: lange absolute Pfade sind rechts abgeschnitten. Nutzer müssen ihren tatsächlichen Arbeitsort erkennen. | Aktueller Ordner ohne horizontales Scrollen lesbar; vollständiger Pfad kopierbar; Pfadeingabe per Tastatur erreichbar. | Mittel |
| P1 | Begriffe und Sprache vereinheitlichen | Schritte 1, 3, 5, 6: Dateien/Files/SFTP, Diagnostik/Metrics sowie deutsche und englische Bedienbegriffe. | Eine konsistente Begriffsliste für Desktop, Mobil, Menüs, Tooltips und Accessible Names. | Klein–mittel |
| P1 | Dateioperationen über Tastatur vollständig nutzbar machen | Schritt 4: Dateizeilen erscheinen im DOM als generische Container; der Doppelklick ist nicht selbstbeschreibend. | Ordner mit Enter öffnen, Auswahl mit Space, nachvollziehbarer Fokus nach Navigation; Screenreader-Test mit tatsächlichem Hilfsmittel. | Mittel |
| P1 | Sitzungsziel deutlicher am Arbeitsbereich anzeigen | Schritte 4, 5: kompakte Tabs und kleine Hostangabe am Listenfuß. Bei vielen Verbindungen steigt der Orientierungsaufwand. | Anzeigename und `user@host` unmittelbar über Terminal/Dateien; aktive Sitzung visuell und semantisch eindeutig. | Mittel |
| P1 | Ablauf der Anmeldung und Wiederaufnahme praktisch prüfen | Schritt 11: dokumentierter Ablauf auch bei aktiver Arbeit. | Vorwarnung, erkennbare Unterscheidung Web-Anmeldung/SSH-Abbruch, Notiz- und Editorerhalt sowie Wiederanmeldung im Integrationstest. | Mittel |
| P2 | „Aktuelle Sitzung im Dateimanager öffnen“ | Schritt 7: leere Quellenansicht trotz laufender SSH-Sitzung. | Ein Klick übernimmt Quelle und aktuellen Pfad in einen unabhängigen Dateimanager-Tab. | Mittel |
| P2 | Befehle nach Betriebssystem, Favoriten und zuletzt verwendet priorisieren | Schritt 8: sehr lange, breite Befehlsauswahl. | Häufige passende Befehle zuerst; Gesamtbibliothek weiterhin durchsuchbar; Einfügen/Ausführen weiterhin klar getrennt. | Mittel |
| P2 | Diagnostik mit kompakter Übersicht beginnen | Schritt 9: große CPU-Karte und Warnungsblock beanspruchen fast die ganze Seitenleiste. | CPU, RAM, Datenträger und Aktualität in der ersten Ansicht; Details aufklappbar; fehlende Teilwerte klar markiert. | Mittel |
| P2 | Notizzuordnung und Speicherstatus explizit machen | Schritt 10: persönlicher und sitzungsbezogener Kontext können verwechselt werden. | Sichtbare Zuordnung, „Gespeichert“-Rückmeldung, prüfbare Fehlerwiederherstellung. Bestehenden Autosave zunächst funktional prüfen. | Klein–mittel |
| P2 | Mobile Dateiansicht auf echten Geräten prüfen | Schritt 6: Bezeichnungen und überlagernder Tastaturknopf wurden bereinigt; die Prüfung erfolgte bisher im Browser-Viewport. | Touchprüfung auf mindestens einem echten kleinen Gerät, einschließlich Drehen und Bildschirmtastatur. | Klein |
| P2 | Verbinden-Dialog verdichten | Schritt 2: hoher vertikaler Aufwand vor erweiterten Optionen. | Grundverbindung bei üblicher Laptop-Höhe ohne Scrollen erfassbar; Erweiterungen bleiben auffindbar. | Klein–mittel |

Für Nutzergefallen würde ich zuerst die vier regelmäßig spürbaren Dinge
adressieren: **Arbeitsort sofort verstehen, weniger scrollen, zuverlässig per
Tastatur arbeiten, häufige Aktionen schneller erreichen.** Weitere Themes oder
Animationen haben gegenüber diesen Verbesserungen geringere Priorität.

Als nächste qualitative Prüfung eignen sich fünf reale Aufgaben: Host finden
und verbinden; Ordner links und rechts wechseln; Datei bearbeiten und einen
Konflikt lösen; nach Verbindungsunterbrechung weiterarbeiten; dieselben Aufgaben
auf einem kleinen Bildschirm erledigen. Beobachtet werden Zeit bis zur ersten
erfolgreichen Aktion, Fehlwechsel, notwendige Rückfragen und Vertrauen in den
aktuellen Zustand. Dafür wurden hier noch keine Nutzerkennzahlen erhoben.

## Technische Prüfung und Grenzen

- JavaScript-Lint und die komplette vorhandene JS-Testsammlung inklusive neuer
  Sync-Tests bestanden; der Runner meldet 59 erfolgreiche Testdateien.
- 3221 Python-Tests bestanden, zwei plattformabhängige Tests wurden übersprungen.
  Darin enthalten sind Directory-Probe, Socket-Berechtigungen, Lebenszyklus,
  Paramiko-Kanäle, Übersetzungen und bestehende Dateimanager-Verträge.
- Echte OpenSSH-Verbindung: Terminal → Dateien, Dateien → Terminal und Pause
  während eines laufenden Befehls im Browser geprüft.
- Echte temporäre tmux-Sitzung: aktive Pane, aktueller Ordner und laufender
  Vordergrundprozess geprüft. Die Testsession wurde anschließend entfernt.
- Ein automatisierter Linux-PTY-Test prüft auch eine verschachtelte Bash und
  einen Ordner mit Apostroph, Leerzeichen und Dollarzeichen.
- Zusätzliche Tests prüfen deaktivierten Sync, abgelöste Antworten,
  Sitzung-/Quellenwechsel, gleichzeitige Eingabe, Alternativbildschirm,
  nicht unterstützte Antworten, Pfadquotierung, Zeit- und Größenlimits.
- Der enge Desktop-Breakpoint und der Smartphone-Viewport wurden visuell
  geprüft. Ein Viewport-Test ersetzt kein echtes Touch-Gerät.
- Kein vollständiger Release-/Container-/Multi-Browser-Lauf. Keine umfassende
  Sicherheitsprüfung, keine Messung aller Farbkontraste und kein vollständiger
  Screenreader-Test.
- SMB, große Übertragungen, Editor-Speicherkonflikte, OIDC/LDAP/MFA, Wiederherstellung
  aus Backups und Ausfälle über längere Zeit wurden hier nicht Ende-zu-Ende
  durchgespielt. Aussagen dazu bleiben bewusst begrenzt.
