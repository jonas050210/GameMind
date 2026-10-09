# GameMind – Technischer Projektplan

- **Status:** Architekturgrundlage; ein kleiner Minecraft-Beobachtungs-/Skill-/Task-Regelkreis ist in `src/` umgesetzt. Ein einfaches, modulares Prioritätsmodell ist enthalten; RL/Training und GUI sind nicht implementiert.
- **Stand:** 9. Oktober 2026
- **Zweck dieses Dokuments:** Eine belastbare Grundlage für MVP, Architekturentscheidungen und spätere Erweiterungen schaffen.

> **Ausgangslage:** Zu Beginn der Konzeptphase enthielt das Repository nur eine minimale README-Datei. Die Architektur in diesem Dokument ist die genehmigte Leitlinie; die Umsetzung ist weiterhin ein enger Schnitt: Minecraft-Adapter, strukturierter Beobachtungs-/Action-Kern, sichere Skill-Ausführung, ein kleines Prioritätsmodell, ein begrenzter Task-Loop, Traces und deterministische Offline-Tests. Dieser Plan beschreibt weiterhin die weitergehende Zielarchitektur, nicht den vollständigen aktuellen Funktionsumfang.

### Umsetzungsstand der ersten Phase

- Node.js 22 / TypeScript; Mineflayer 4.39.0 mit konfigurierbarem Minecraft-Protokoll (Standard 1.20.4).
- Laufzeitvalidierung über Zod, strukturierte Pino-Logs und geordnete JSONL-Traces.
- Kleiner generischer Game-Adapter-/World-Model-/Action-Executor-Kern; Minecraft-Skills für Blickrichtung, Blockinspektion, konservative Navigation, begrenztes Logsammeln, Ausrüsten, verifiziertes Essen, whitelisted Holzrezepte und vorsichtiges Platzieren eines Crafting-Tisches.
- Einfaches Prioritäts-/Nutzwertmodell: sichtbare nahe Hostiles haben Vorrang, danach kritische Gesundheit/Hunger (bei fehlenden validierten Recovery-Skills wird blockiert) und dann der Nutzerauftrag. Der Holz-Dependency-Planer berechnet plank/stick/table/tool-Voraussetzungen, reagiert auf fehlendes Material und blockierte Ziele; es gibt kein Kampfverhalten und keine freie Aktionsplanung.
- Task-Loop mit frischer Beobachtung, Replanning, Zielausschluss nach Fehlern, Navigations-Stuck-Watchdog, Zeit-/Aktionsbudgets und bestätigtem Ziel-/Inventarzustand. Metriken erfassen Erfolg/Fortschritt, verbrauchte Items, Hungergewinn, Schaden, Fehler, Recovery und Laufzeit.
- Deterministische Offline-Fakes variieren Hunger, Inventar, Logs, Crafting-Tische, Hostiles, blockierte Wege, Aktionsfehler und Budgets. Sie testen Logik und Mock-Verhalten, nicht Mineflayer-/Serverkompatibilität.
- Kein echter Minecraft-Server stand zum Testen bereit; Live-Kompatibilität und Pluginverhalten in einer echten Welt sind daher weiterhin **nicht verifiziert**.

### Umsetzungsstand der zweiten Phase (Erkundung, Nahrung, Überleben)

- **Wahrnehmung:** Zusätzlich zum lokalen Würfel gibt es einen weiteren Ressourcenscan (Stämme, Werkbänke, Süßbeerenbüsche mit Reifegrad bis 24 Blöcke) und erkannte Gegenstände am Boden. Die Obergrenze des lokalen Würfels bevorzugt Ressourcenblöcke statt die Reihenfolge der Iteration.
- **Gedächtnis:** Sichtungen werden über Beobachtungen hinweg gehalten und nur entfernt, wenn ein vollständig erfasster, nicht abgeschnittener Bereich deren Fehlen belegt. Erkundete Felder und zuletzt gesehene Feinde werden mitgeführt.
- **Erkundung:** Begrenzte Routen zu unerkundeten Feldern im Umkreis des Aufgabenstarts; Feinde in der Nähe werden gemieden. Die Anzahl der Erkundungsschritte ist ein Parameter der Aufgabe.
- **Zielwahl in drei Prioritätsbändern:** Sicherheit (Flucht, Ausweichen nach Blockade), Überleben (Essen, Nahrung aufnehmen, Beeren ernten, Ausruhen bei niedriger Gesundheit) und Fortschritt (Sammeln, Crafting, Annähern an Gemerktes). Innerhalb eines Bandes wird nach Nutzen mit einem kleinen Bonus für das bisherige Ziel gewichtet.
- **Komposition und Verifikation:** Jede Entscheidung projiziert die verbleibenden Schritte; ausgeführt wird nur der erste. Jede bestätigte Aktion wird gegen die nächste Beobachtung geprüft. Nicht gestützte Bestätigungen zählen als Fehler.
- **Blockade und Erholung:** Routenblockaden führen zu begrenzten Ausweichmanövern, die achsenparallel sind; wiederholte Versuche ohne Fortschritt schließen das Ziel aus.
- **Offline-Simulation und Bewertung:** Eine deterministische, geseedete Welt mit zwölf Szenarien und Gate-Prüfungen (keine unsicheren Aktionen, keine Todesfälle, keine widersprüchlichen Bestätigungen). Die Ergebnisse gelten nur für Steuerungslogik, nicht für einen echten Server.
- **Live-Status:** Weiterhin **nicht verifiziert**. Die Prüfschritte und Befehle stehen in `docs/LIVE_VERIFICATION.md`.

## Kurzfassung

GameMind sollte nicht als ein einzelnes neuronales Netz verstanden werden, das direkt Pixel in Tastendrücke übersetzt. Für ein langfristig erweiterbares System ist eine **hierarchische, hybride Agentenarchitektur** sinnvoller:

1. Ein **Game Adapter** liefert begrenzte, nachvollziehbare Beobachtungen und führt validierte Aktionen aus.
2. **Perception und World Model** übersetzen Beobachtungen in einen zeitlich markierten, teilweise unsicheren Weltzustand.
3. Das **Decision Model** priorisiert Ziele, plant Teilaufgaben und wählt passende Skills aus.
4. Ein **Skill Runtime** führt Skills als überwachte, abbrechbare Optionen aus und meldet Ergebnisse zurück.
5. Ein **Safety Supervisor** prüft jede Aktion, überwacht Fortschritt und kann jederzeit pausieren.
6. **Memory, Evaluation und Learning** speichern Erfahrung und verbessern Skills kontrolliert; neue Modelle werden nicht ungeprüft live geschaltet.
7. Ein **Control Center** macht Zustand, Entscheidungen, Trainingsstände und Fehler verständlich und steuerbar.

Für den Anfang empfiehlt sich ein enger, reproduzierbarer Einsatzbereich: **Minecraft Java Edition, eine festgelegte Version, ein eigener oder lokaler Vanilla-Server und eine einzelne Agenteninstanz**. Die erste Version soll eine begrenzte Aufgabe dynamisch lösen können – nicht bloß eine fest kodierte Schrittfolge abspielen. Reinforcement Learning ist zunächst ausdrücklich **nicht** die Grundlage des MVP: World Model, Goal Selection, Planner, überprüfbare Skills und gute Evaluationswerkzeuge haben zuerst den höheren Nutzen.

---

## 1. Vision

GameMind soll langfristig eine allgemeine, erfahrungsfähige Game-AI werden, die in unterschiedlichen Spielen Ziele verfolgen und auf neue Situationen reagieren kann. „Allgemein“ bedeutet dabei nicht, dass ein einziges unverändertes Modell sofort jedes Spiel beherrscht. Es bedeutet, dass ein stabiler Kern durch austauschbare **Game Adapter** und spielspezifische **Domain Packs** erweitert werden kann.

Die AI soll:

- aus unvollständigen Beobachtungen einen nachvollziehbaren Weltzustand aufbauen;
- Bedürfnisse, Nutzeraufträge, Chancen, Risiken und langfristige Absichten gegeneinander abwägen;
- Ziele in überprüfbare Teilziele und Skills zerlegen;
- Aktionen vor ihrer Ausführung validieren und laufende Skills unterbrechen können;
- Erfolge, Fehler und Unsicherheiten messen und daraus kontrolliert lernen;
- Wissen, Episoden und Skill-Qualität dauerhaft, versioniert und mit Herkunft speichern;
- nach einem Neustart reproduzierbar weiterarbeiten oder einen sicheren Zustand herstellen;
- auf unbekannte Situationen mit Beobachten, risikoarmen Tests, Alternativplänen oder sicherem Abbruch reagieren.

**Wichtige Abgrenzung:** In frühen Versionen werden grundlegende Skills bewusst von Menschen implementiert und getestet. Das widerspricht dem Ziel einer lernenden AI nicht: Die Anpassungsfähigkeit liegt zunächst im dynamischen Zielmanagement, in der Auswahl und Kombination der Skills sowie in der Reaktion auf neue Zustände. Später kann die Ausführung einzelner Skills gelernt oder optimiert werden. Ein unvalidiertes Modell soll niemals direkt beliebigen Spielcode oder unbeschränkte Aktionen ausführen.

## 2. Kernanforderungen

### Funktionale Anforderungen

- Beobachtungen und Spielereignisse über eine definierte Adapter-Schnittstelle aufnehmen.
- Einen aktuellen, zeitlich markierten World State einschließlich unbekannter und veralteter Informationen führen.
- Ziele aus Nutzerauftrag, Überlebensbedarf, Fortschritt und Gelegenheiten erzeugen und priorisieren.
- Ziele in Teilziele/Skills zerlegen und bei geänderten Voraussetzungen neu planen.
- Skills vor, während und nach der Ausführung überwachen; Erfolg, Teilerfolg, Abbruch und Fehler unterscheiden.
- Ressourcen, Gefahren, Gesundheitszustand und verfügbare Fähigkeiten berücksichtigen.
- Episoden, Entscheidungsgründe, Metriken, Modelle und Skill-Versionen nachvollziehbar speichern.
- Training und Evaluation getrennt von der Live-Ausführung betreiben.
- Zustand und Entscheidungen über eine GUI beobachten sowie den Agenten sicher pausieren/stoppen können.

### Nichtfunktionale Anforderungen

- **Sicherheit:** Keine Aktion ohne Capability-, Schema-, Frische- und Vorbedingungsprüfung.
- **Robustheit:** Timeouts, Reconnects, Abbruch, Wiederaufnahme und Erkennung fehlenden Fortschritts.
- **Nachvollziehbarkeit:** Jede Aktion muss auf Beobachtung, Ziel, Skill und Entscheidungsdatensatz zurückführbar sein.
- **Reproduzierbarkeit:** Versionen, Szenarien, Seeds, Konfigurationen und Checkpoints festhalten.
- **Erweiterbarkeit:** Kleiner stabiler Kern; Spielregeln und Fähigkeiten in Adapter/Domain Packs.
- **Messbarkeit:** Erfolg nicht nur anhand eines Reward-Werts, sondern über fachliche Metriken beurteilen.
- **Kontrollierbarkeit:** Laufzeit- und Trainingskonfiguration ändern, ohne Geheimnisse oder Sicherheitsregeln offenzulegen.
- **Datenhygiene:** Nur notwendige Beobachtungen und Episoden speichern, Datenformate versionieren, Geheimnisse nie in Logs schreiben.

## 3. Vorgeschlagene Gesamtarchitektur

### 3.1 Daten- und Kontrollfluss

```text
                           ┌──────────────────────────────┐
                           │         Control Center       │
                           │ Live-State · Trace · Tests   │
                           └──────────────┬───────────────┘
                                          │ Beobachten / sicher steuern
                                          ▼
┌──────────┐   Beobachtungen   ┌────────────────────┐   Fakten / Beliefs
│ Minecraft├─────────────────►│ Adapter + Ingestion├──────────────────────┐
└────┬─────┘                  └────────────────────┘                      ▼
     ▲                                                    ┌────────────────────────┐
     │ validierte Aktionen                               │ Perception / World Model│◄──► Memory
     │                                                    └────────────┬───────────┘
     │                                                                 │ Zustand,
┌────┴───────────┐   Aktionsauftrag   ┌──────────────────┐             │ Kontext,
│ Safety Broker  │◄───────────────────│ Skill Runtime    │             │ Kompetenz
│ + Watchdog     │                    └────────▲─────────┘             ▼
└───────────────┘                             │                 ┌───────────────────┐
                                               │ Skill / Option  │ Decision Model   │
                                               └─────────────────┤ Goal Manager      │
                                                                 │ Planner + Selector│
                                                                 └─────────┬─────────┘
                                                                           │ Ergebnis,
                                                                           │ Episode,
                                                                           ▼
                                                            ┌─────────────────────────┐
                                                            │ Telemetrie / Evaluation │
                                                            │ Offline Learning        │
                                                            └─────────────────────────┘
```

Der Agent entscheidet nicht auf jedem Minecraft-Tick neu über jede Taste. Die Spielwelt kann mit hoher Frequenz aktualisiert werden; der Planner arbeitet ereignis- und zustandsgetrieben, während ein laufender Skill seine eng begrenzte Steuerung ausführt. Ein Skill kann bei einer Gefahr, einem Timeout oder einer relevanten Zustandsänderung unterbrochen werden. So bleiben Reaktionsfähigkeit und übergeordnete Planung getrennt.

### 3.2 Architekturprinzipien

1. **Hierarchisch statt monolithisch:** Zielwahl, Planung, Skill-Auswahl und Aktionsausführung sind getrennte Verantwortlichkeiten.
2. **Hybrid statt „RL für alles“:** Regeln und Constraints für Sicherheit, symbolische Planung für bekannte Abhängigkeiten, gelernte Policies nur dort, wo Erfahrung tatsächlich hilft.
3. **Beobachtung ist nicht Wahrheit:** Fakten erhalten Quelle, Zeitstempel und Vertrauensmaß. Nicht beobachtet bedeutet „unbekannt“, nicht „existiert nicht“.
4. **Ein Aktionspfad:** Live-Aktionen laufen ausschließlich durch den Safety Broker. UI, LLM, Planner und Skill-Code dürfen ihn nicht umgehen.
5. **Offline lernen, kontrolliert ausrollen:** Neue Policies werden an festen Szenarien bewertet, mit der aktuellen Version verglichen und erst nach Freigabe aktiviert.
6. **Spielneutraler Kern, ehrliche Spielgrenzen:** Gemeinsame Abstraktionen bleiben klein. Rezepte, Blocklogik, Kampfregeln und konkrete Fähigkeiten bleiben im Minecraft-Domain-Pack.
7. **Zuerst modularer Monolith:** Für den MVP keine verteilten Microservices. Eine klare Modulgrenze und ein isolierter Adapterprozess genügen; weitere Prozesse entstehen erst bei echtem Skalierungsbedarf.

### 3.3 Empfohlene technische Aufteilung

Als pragmatischer Start bietet sich eine TypeScript-/Node.js-basierte Laufzeit an: Sie passt zum verbreiteten Minecraft-Java-Client-Ökosystem, erlaubt gemeinsame Typen zwischen Adapter, Kern und Web-GUI und reduziert anfängliche Integrationsarbeit. Ein Python-Trainingsprozess mit PyTorch kann später über versionierte Episoden-/Datensatzformate ergänzt werden. Das Training sollte nicht Teil des zeitkritischen Aktionspfads sein.

Das ist eine **Empfehlung, keine Vorentscheidung**. Vor Festlegung sollte ein kurzer Kompatibilitätstest mit einer konkret unterstützten Minecraft-Version und dem ausgewählten Adapter stattfinden. Für den MVP sind ein lokaler Datenspeicher (z. B. SQLite plus append-only Episodenlogs) und ein WebSocket-/HTTP-Kanal für Live-Telemetrie ausreichend; zusätzliche Broker, Datenbanken und Orchestrierungssysteme wären zunächst unnötige Komplexität.

## 4. Komponenten und Verantwortlichkeiten

| Komponente | Verantwortung | Darf nicht tun |
|---|---|---|
| **Game Adapter** | Verbindung zum Spiel; rohe Beobachtungen/Ereignisse normalisieren; verfügbare Fähigkeiten melden; Aufträge ausführen und Ergebnisse bestätigen. | Zielprioritäten entscheiden oder Sicherheitsregeln umgehen. |
| **Ingestion / Session Manager** | Sitzungs- und Tick-Zeit ordnen, Duplikate behandeln, Adapterverbindung überwachen, Zustandsupdates weiterreichen. | Veraltete Daten als aktuell ausgeben. |
| **Perception** | Rohdaten zu semantischen Fakten verdichten, Objekte/Beziehungen und abgeleitete Merkmale erzeugen. | Nicht sichtbare Spielinformationen als bekannt voraussetzen. |
| **World Model** | Aktuellen Zustand, Teilkarte, Unsicherheit, Aktualität und Änderungshistorie verwalten. | Unbegrenzt alle Weltblöcke im Arbeitsspeicher halten. |
| **Memory** | Episoden, Fakten, Kartenwissen, Ziel-/Planfortschritt und Skill-Statistiken speichern und kontextbezogen abrufen. | Stale- oder Fremdwelt-Wissen ohne Kennzeichnung als sichere Tatsache behandeln. |
| **Goal Manager** | Ziele erzeugen, priorisieren, pausieren, fortsetzen und abschließen. | Sicherheits-Constraints als bloße Präferenz verrechnen. |
| **Planner** | Ziele in Teilziele und mögliche Skill-Folgen zerlegen; Ressourcen, Voraussetzungen, Kosten und Alternativen berücksichtigen. | Unbegrenzte oder unüberprüfte Aktionsketten ausgeben. |
| **Skill Selector** | Anwendbare Skills anhand Zielbeitrag, Erfolgsaussicht, Kosten, Risiko und Erfahrung auswählen. | Nicht erfüllte Vorbedingungen ignorieren. |
| **Skill Runtime** | Skills mit Fristen, Fortschrittskriterien, Abbruch und Ergebnisstatus verwalten. | Selbstständig unbeschränkt neue Aktionspfade starten. |
| **Safety Broker / Watchdog** | Aktion validieren, begrenzen, serialisieren, abbrechen; Stillstand, Fehler und kritische Zustände erkennen. | Von einem Modell oder UI deaktiviert werden können, während der Agent aktiv ist. |
| **Telemetry / Evaluator** | Decision Traces, Aktionsresultate, Metriken, Szenarioauswertung und Regressionen sammeln. | Trainingsreward mit tatsächlichem Task-Erfolg gleichsetzen. |
| **Training Pipeline** | Datensätze versionieren, Modelle trainieren, Checkpoints erzeugen und Kandidaten gegen Benchmarks testen. | Kandidaten ohne Evaluations-Gate live schalten. |
| **Control Center** | Beobachten, Debuggen, kontrollierte Eingriffe und Trainingsverwaltung ermöglichen. | Zugangsdaten oder unvalidierte Aktionen offenlegen. |

## 5. Decision Model

Das Decision Model ist die zentrale Entscheidungslogik zwischen World State, Absichten und Skills. Es ist kein einzelner „Black Box“-Klassifikator, sondern eine Pipeline mit expliziten Ergebnissen und überprüfbaren Zwischenständen.

### 5.1 Eingaben

- Aktueller World State, Änderungsereignisse, Zeitstempel, Vertrauenswerte und unbekannte Bereiche.
- Gesundheits-/Überlebenszustand, Ressourcen, Inventar, Position, Gefahren und laufende Aktivitäten.
- Aktiver Nutzerauftrag, bisheriger Ziel- und Planfortschritt, Zeit-/Risikobudgets.
- Verfügbare Adapter-Capabilities und Skill-Metadaten.
- Erfolgswahrscheinlichkeit und kontextabhängige Fehlerhistorie der Skills.
- Relevante Episoden, bestätigte Regeln und bekannte Gefahren aus Memory.
- Laufzeitbedingungen: Latenz, Disconnect, Pausezustand, Aktionsbudget und menschliche Eingriffe.

### 5.2 Was es entscheidet

1. **Brauche ich zuerst bessere Information?** Bei relevanter Unsicherheit kann die beste Entscheidung eine risikoarme Beobachtung sein.
2. **Welches Ziel ist jetzt aktiv?** Ziele können neu entstehen, wechseln, pausieren oder nach veränderten Bedingungen verfallen.
3. **Wie wird das Ziel in Teilziele zerlegt?** Der Planner berücksichtigt Abhängigkeiten und verfügbare Mittel.
4. **Welcher Skill ist jetzt geeignet?** Nur Skills mit erfüllten Voraussetzungen und passender Capability kommen infrage.
5. **Soll ich fortsetzen, unterbrechen, ausweichen, neu planen oder sicher stoppen?** Das hängt von Fortschritt, Gefahr, Unsicherheit und Laufzeitgrenzen ab.

### 5.3 Zielpriorisierung

Ziele sollten nicht allein über einen frei lernbaren Score gegeneinander antreten. Zuerst gelten **harte Constraints**, beispielsweise: Agent pausiert, Aktion ungültig, Adapterzustand nicht vertrauenswürdig, unmittelbar tödliche Gefahr oder Nutzer-Stopp. Danach kommt eine konfigurierbare Prioritätsordnung:

1. Harte Sicherheit und expliziter Stopp.
2. Akute Überlebens- und Schadensvermeidung.
3. Dringende Verpflichtungen des Nutzerauftrags und Schutz bereits investierter Ressourcen.
4. Strategische Teilziele und Fortschritt im aktiven Auftrag.
5. Opportunistische Ziele, Exploration und intrinsischer Lernwert.

Innerhalb derselben Ebene kann ein verständlicher Score verwendet werden, etwa aus **Wert des Fortschritts + Dringlichkeit + Nutzerpriorität + strategischer Relevanz + Informationswert − Zeit-/Ressourcenkosten − Risiko**. Machbarkeit und Vertrauensgrad beeinflussen den Score, ersetzen aber keine Sicherheitsregel. Der Score und seine Faktoren werden im Decision Trace offengelegt.

Um hektisches Wechseln zwischen ähnlich bewerteten Zielen zu vermeiden, braucht es **Hysterese**: Ein laufendes Ziel bleibt aktiv, solange es Fortschritt macht und kein klarer Grund für einen Wechsel vorliegt. Ein Zielwechsel erfolgt bei Gefahren, ungültigen Voraussetzungen, fehlendem Fortschritt, relevantem Informationsgewinn oder deutlichem Prioritätsabstand. Ziele besitzen außerdem Fristen, Abbruchbedingungen und Wiederaufnahmebedingungen.

### 5.4 Planung und Skill-Auswahl

Für den Anfang eignet sich eine Mischung aus:

- **Regeln/Constraints** für Sicherheits- und Überlebensreaktionen;
- **HTN-/GOAP-artiger Planung** für bekannte Voraussetzungen, Kosten und Teilziele;
- **heuristischer Skill-Auswahl** mit protokollierten Merkmalen;
- später **Bandit- oder RL-Policies** für Teilentscheidungen, deren Güte durch Erfahrung messbar verbessert werden kann.

Für ein Ziel werden zunächst unzulässige Skills anhand von Capability, Vorbedingung, Ressourcen, Risiko und Zustand herausgefiltert. Unter den verbleibenden Skills kann eine erwartete Qualität geschätzt werden:

> **Erwarteter Nutzen = Erfolgswahrscheinlichkeit × Zielbeitrag − Zeit-/Ressourcenkosten − Risikokosten + begrenzter Lern-/Informationswert.**

Der Lernbonus darf in Live-Welten nicht dazu führen, dass der Agent für Experimente vermeidbare Schäden riskiert. Bei gleichwertigen Optionen kann die Entscheidung deterministisch oder reproduzierbar tie-breaken, damit Fehler debugbar bleiben.

### 5.5 Unsicherheit und unbekannte Situationen

- Unsicherheit und Datenalter sind eigene Werte; „unbekannt“ ist nicht dasselbe wie „falsch“.
- Kritische Fakten (z. B. Zielposition, Durchgang, Mob-Verhalten) müssen vor riskanten Aktionen frisch bestätigt werden.
- Bei niedriger Konfidenz werden bevorzugt Beobachten, ein sicherer Umweg, ein reversibler Test oder ein Plan mit geringerem Schadenspotenzial gewählt.
- Wenn keine Option über einer Mindestkonfidenz liegt: nicht raten, sondern re-observieren, alternative Skills prüfen, den Plan verkürzen oder kontrolliert pausieren.
- Zufällige Exploration ist auf Trainingsszenarien mit Risiko- und Zeitbudget beschränkt.

### 5.6 Langfristige Ziele und Replanning

Langfristige Absichten werden als Zielgraph mit Meilensteinen, Voraussetzungen, benötigten Ressourcen, geschätzten Kosten, Fristen und Fortschritt geführt. Der Agent plant nicht starr jede Aktion für eine lange Zukunft vor: Er plant auf Meilenstein-Ebene und verwendet **Receding-Horizon-Replanning**. Nach wichtigen Ereignissen – Ressource gefunden/verloren, Weg blockiert, Gefahr erkannt, Skill fehlgeschlagen, Weltzustand verändert – wird der betroffene Planabschnitt neu bewertet. Ein erfolgreicher Teilplan kann im Episodenwissen gespeichert und später wiederverwendet werden, bleibt aber an Version und Kontext gebunden.

### 5.7 Entscheidungsprotokoll

Jede Entscheidung sollte mindestens aktive Mission, Ziel und Score-Faktoren, relevante Fakten mit Alter/Vertrauen, geprüfte Skills, verworfene Alternativen samt Grund, gewählten Skill, erwartetes Ergebnis, Abbruchkriterien, Modell-/Skill-Version und Korrelations-ID enthalten. Eine kurze strukturierte Erklärung ist hilfreicher als eine freie, möglicherweise erfundene Textbegründung.

## 6. Perception und World State

### 6.1 Minecraft-Informationen für den Start

**Agent und Bewegung**
- Position, Blickrichtung, Dimension, Geschwindigkeit bzw. Bewegungszustand, Boden-/Flug-/Schwimmzustand.
- Gesundheit, Absorption, Hunger/Sättigung, Luft, Feuer-/Effektzustand und Tod/Respawn.

**Inventar und Fähigkeiten**
- Item-Typ, Anzahl, Metadaten, Haltbarkeit, Rüstung und gehaltenes Item.
- Bekannte Rezepte, verfügbare Werkzeuge und relevante Interaktionsmöglichkeiten.
- Freie Inventarplätze und absehbare Ressourcenengpässe.

**Umgebung und Navigation**
- Lokal beobachtete Blöcke und ihre Semantik (abbaubar, fest, Flüssigkeit, Gefahr, Interaktionsobjekt).
- Navigierbare Flächen, Höhenunterschiede, Hindernisse, Abgründe und bekannte sichere Wege.
- Sichtlinie, Distanz und Aktualität der Beobachtung.
- Biome, Tageszeit, Wetter und Dimension, soweit für Ziel oder Risiko relevant.

**Entitäten und Ereignisse**
- Typ/Identität, Position, Distanz, Bewegungs-/Aktivitätszustand und beobachtbare Gefährlichkeit von Entitäten.
- Sichtbarkeit, geschätzte Richtung/Geschwindigkeit und – nur falls der Adapter es legitim beobachtet – Gesundheit.
- Ereignisse wie Schaden, Item-Aufnahme, Blockänderung, Aktionserfolg, Tod, Disconnect und Chunk-/Sichtbereichsänderung.

### 6.2 Repräsentation

World State sollte aus getrennten, zusammenführbaren Schichten bestehen:

1. **Direkte Beobachtungen:** Adaptermeldungen mit Quelle, Tick/Zeit und Session.
2. **Abgeleitete Fakten:** z. B. „Inventar enthält genügend Holz für Ziel X“ oder „Weg ist wahrscheinlich blockiert“.
3. **Räumliches Kurzzeitmodell:** begrenzte lokale Voxel-/Navmesh-/Graphrepräsentation, nicht eine vollständige Kopie der Welt.
4. **Beliefs:** unsichere oder indirekte Aussagen mit Konfidenz und Ablauf-/Veraltungsregeln.
5. **Änderungen:** kompakte Deltas und relevante Ereignisse für Replanning und Debugging.

Jeder Fakt trägt Zeitstempel, Quelle, Konfidenz und gegebenenfalls Gültigkeitsdauer. Das Modell muss unbekannte Chunks von leeren/ungefährlichen Bereichen unterscheiden. Weltwissen wird an Server, Welt, Dimension und Koordinatensystem gebunden, damit eine Erinnerung aus einer anderen Welt keine falsche Sicherheit erzeugt. Der MVP nutzt primär strukturierte Spielbeobachtungen; Bild-/Video-Perception ist ein späterer, optionaler Adapterkanal und nicht die erste Grundlage.

## 7. Skill-System

### 7.1 Skills als überwachte Optionen

Ein Skill ist mehr als eine Aktion. Er ist eine ausführbare, begrenzte Fähigkeit mit:

- Zweck und zulässigen Parametern;
- Initiierungsbedingungen und Vorbedingungen;
- benötigten Adapter-Capabilities und Ressourcen;
- erwarteten Effekten sowie Nebenwirkungen/Risiken;
- interner Policy oder Unter-Skill-Folge;
- Erfolgs-, Teilerfolgs- und Abbruchkriterien;
- Timeout, Fortschrittsindikator und maximalem Aktionsbudget;
- Recovery-/Alternativstrategie;
- Skill-Version, Tests und Erfolgsstatistik nach Kontext.

Jeder Skill endet mit einem expliziten Ergebnisstatus: **Erfolg**, **Teilerfolg**, **fehlgeschlagen**, **abgebrochen**, **nicht ausführbar** oder **unbekannt**. „Die Aktion wurde gesendet“ gilt nicht als Erfolg; der World State muss den erwarteten Effekt bestätigen.

### 7.2 Skill-Ebenen

- **Primitive Fähigkeiten (spielspezifisch):** beobachten, bewegen, Blick ausrichten, interagieren, Item benutzen/wechseln, warten, abbrechen.
- **Atomare Skills:** zu einem Ziel navigieren, Block inspizieren/abbauen, Drops aufnehmen, Crafting ausführen, Objekt platzieren, essen/ausrüsten, Angriff oder Ausweichen ausführen.
- **Komposite Skills/Options:** Ressource beschaffen, Starterwerkzeug herstellen, Gefahr verlassen, sicheren Ort erreichen, Gebiet erkunden, Versorgung auffüllen.
- **Strategische Aufgaben:** längere Zielketten wie Basis einrichten oder bestimmte Ressourcen beschaffen; sie gehören in Planner/Goal Model und sollen nicht als undurchsichtige Makro-Skripte versteckt werden.

### 7.3 Abhängigkeiten und Kombination

Abhängigkeiten werden über Voraussetzungen und erwartete Effekte beschrieben, nicht als starre lineare Skill-Liste. Der Planner kann dadurch alternative Wege berücksichtigen. Komposite Skills rufen andere Skills kontrolliert über dieselbe Runtime auf, mit Begrenzung für Tiefe, Zyklen, Gesamtdauer und Ressourcen. Eine fehlende Fähigkeit führt zu einer expliziten Planlücke; sie darf nicht stillschweigend durch improvisierte, unvalidierte Aktionen ersetzt werden.

### 7.4 Lernen und Verbesserung

Der Skill-Katalog beginnt mit menschlich implementierten, versionierten Fähigkeiten. Anschließend kann GameMind:

1. kontextbezogene Erfolgsraten, Fehlerursachen, Kosten und Abbrüche messen;
2. sichere Parameter (z. B. Zielauswahl oder Wegkosten) anhand von Episoden optimieren;
3. für passende Teilprobleme Demonstrationen per Behavior Cloning nutzen;
4. kontrollierte Policy-Optimierung/RL für einzelne Skills oder Skill-Auswahl erproben;
5. Kandidaten in Replay und Tests gegen die aktuelle Version bewerten;
6. erst nach bestandenen Gates als neue Version markieren.

Skills müssen nicht nur eine globale Erfolgsquote führen: Erfolg beim Navigieren in offenem Gelände sagt wenig über Höhlen, Wasser oder Nacht aus. Statistiken sollten nach wenigen sinnvollen Kontextmerkmalen stratifiziert und bei wenig Daten als unsicher gekennzeichnet werden. Jede gelernte Variante kann auf eine bekannte stabile Version zurückgerollt werden.

## 8. Learning und Reinforcement Learning

### 8.1 Wo RL sinnvoll ist – und wo nicht

| Problemklasse | Zunächst sinnvoller Ansatz | Mögliche spätere Lernmethode |
|---|---|---|
| Rezept-/Crafting-Abhängigkeiten, Inventarregeln | symbolische Daten, Constraint-/Graphplanung | kaum RL-Bedarf |
| Navigation in bekanntem lokalen Kartenmodell | etablierter Pathfinding-Algorithmus mit Gefahrkosten | gelernte Kostenheuristik oder lokale Policy |
| Zielpriorität und Skill-Auswahl | Regeln, Utility, Planner; sauber geloggte Alternativen | Contextual Bandit / Offline-RL, später hierarchisches RL |
| Timing, Bewegung, Kampf in komplexer Dynamik | robuste getestete Controller und Sicherheitsregeln | isoliertes Skill-/Option-RL mit klaren Limits |
| Unbekannte Situationen | Information sammeln, Hypothesen und risikoarme Tests | Imitation/Offline-Lernen; Exploration in kontrollierten Szenarien |
| Langfristige Aufgaben | Meilensteinplanung und explizite Ressourcenmodelle | High-Level-Policy, wenn genügend diverse Episoden vorliegen |

RL ist attraktiv, wenn eine gut definierte Beobachtungs-/Aktionsschnittstelle, viele wiederholbare Episoden und ein messbares Ergebnis existieren. Es ist unpassend als erster Ersatz für bekannte Spielregeln, Sicherheitslogik oder ein fehlendes Testsystem. Eine Hierarchie aus Optionen/Skills kann die Lernhorizonte verkürzen; ein Agent, der direkt auf niedrigster Eingabeebene eine komplette Sandbox-Aufgabe lernt, wäre im Projektstart teuer, datenhungrig und schwer zu debuggen.

### 8.2 Reward und Zielmetriken

Reward sollte aus überprüfbaren Zielen abgeleitet werden und nicht zum einzigen Qualitätsmaß werden. Denkbare Bestandteile sind Zielerreichung, Fortschritt (möglichst als potential-based shaping), Zeit-/Ressourcenkosten, vermeidbarer Schaden, Tod, ungültige Aktionen, Leerlauf und unnötige Zielwechsel. Der eigentliche Reward wird pro Trainingsaufgabe definiert; ein universeller „guter Spielzug“-Reward ist unrealistisch.

Zu vermeiden sind leicht ausnutzbare Stellvertreterziele, etwa Belohnung für bloß eingesammelte Items, wenn das eigentliche Ziel Crafting oder Überleben ist. Daher:

- Aufgabenerfolg separat als Erfolgsquote und Regelverletzungen berichten.
- Reward-Komponenten in GUI und Trainingslogs sichtbar machen.
- Grenzwerte/Safety-Invarianten als Constraints statt als kleine Strafpunkte modellieren.
- Reward-Hacking- und Edge-Case-Tests in die Evaluation aufnehmen.
- Reward- und Szenarioversion jeder Episode speichern.

### 8.3 Exploration und Curriculum

Exploration findet standardmäßig in isolierten, zurücksetzbaren Trainingswelten statt. In einer wertvollen Live-Welt ist die sichere Grundpolicy maßgeblich. Neugier kann vorrangig **Informationsgewinn bei geringem Risiko** bedeuten: ansehen, Abstand gewinnen, neue Route prüfen oder ungefährliche Interaktion testen.

Ein Curriculum sollte stufenweise wachsen:

1. isolierte Primitive und Adapterverträge;
2. statische, risikoarme Aufgaben mit bekannten Ressourcen;
3. variable Startpositionen, Inventare, Hindernisse und Seeds;
4. Zeit-/Versorgungsdruck, dynamische Welt und harmlose Gegner;
5. komplexere, unbekannte Kombinationen und Störfälle;
6. erst danach breitere, offene Welten.

Szenarien benötigen Trainings-, Validierungs- und **zurückgehaltene Testmengen**. Schwierigkeit steigt nach gemessener Kompetenz, nicht nur nach verstrichener Trainingszeit.

### 8.4 Experience Replay, Training und Checkpoints

Jede nutzbare Episode sollte Szenario/Seed, Spiel- und Adapterversion, Beobachtungen oder verlustarme Zustandsdeltas, Decision Traces, Skills, Aktionen, Resultate, Reward-Komponenten und Endzustand enthalten. Replay Buffer werden nach Erfolg, Fehlerart, Seltenheit und Szenario stratifiziert; ausschließlich erfolgreiche oder priorisierte Episoden zu speichern verzerrt das Lernen. Rohdaten werden begrenzt und versioniert.

Training läuft offline oder in ausdrücklich dafür gestarteten Szenarien. Ein Checkpoint umfasst mindestens Modell-/Skill-Version, Trainingskonfiguration, Datenstand, RNG-/Seed-Informationen, Evaluationsbericht und Schema-Version. Ein Kandidat wird nur übernommen, wenn er eine feste Suite besteht, keine Safety-Regression zeigt und auf zurückgehaltenen Seeds ausreichend generalisiert. Der vorherige Champion bleibt verfügbar.

### 8.5 Evaluation und Generalisierung

Erfolge müssen über unterschiedliche Seeds, Startzustände, Hindernisse, Ressourcenlagen, Tageszeiten und Störfälle geprüft werden. Berichtet werden mindestens Task-Erfolgsquote, Zeit bis Ziel, Todes-/Schadensrate, Aktions-/Skill-Fehler, Ressourcenverbrauch, Stillstand, Replan-Rate und Performance nach Kontext. Für Generalisierung sind unbekannte Kombinationen und leicht veränderte Bedingungen wichtiger als eine hohe Punktzahl auf Trainingswelten.

## 9. Memory

GameMind benötigt mehrere klar getrennte Speicherarten:

1. **Working Memory:** aktueller State, laufendes Ziel, Plan und kurze Ereignishistorie; flüchtig und schnell.
2. **Episodisches Memory:** Ablauf von Beobachtung, Entscheidung, Skill und Resultat mit Kontext; Grundlage für Debugging und spätere Trainingsdaten.
3. **Semantisches Memory:** bestätigte Rezepte, Ressourcenbeziehungen, Gefahrhinweise und allgemeine Fakten mit Quelle, Gültigkeit und Vertrauen.
4. **Räumliches Memory:** erkundete Teilkarten, Wege und Gefahren, gebunden an Welt/Dimension/Version und mit Alterung.
5. **Prozedurales Memory:** Skill-Katalog, Versionen, Vorbedingungen, Qualität und bekannte Recovery-Pfade.
6. **Strategisches Memory:** längerfristige Ziele, Meilensteinfortschritt, Nutzerpräferenzen und offene Pläne.
7. **Trainingsartefakte:** getrennte, reproduzierbare Datensätze, Checkpoints und Evaluationsergebnisse.

Die Datenbestände sollen nicht vermischt werden: Ein alter Episodenverlauf ist keine automatisch gültige Weltregel; ein Modell-Checkpoint ist kein Skill; ein konfigurierbarer Nutzerwunsch ist kein gelernter Fakt. Für den MVP genügen eine kleine lokale relationale Datenbank und dateibasierte, versionierte Episoden-/Modellartefakte. Wichtig sind Suchbarkeit, Herkunftsnachweis, Verfallsregeln, Export/Löschung und die Möglichkeit, mit leerem Memory kontrolliert zu starten. Embeddings/semantische Suche können später ergänzt werden, falls der Datenumfang es rechtfertigt.

## 10. Minecraft-Integration

### 10.1 Empfohlener Start

Für einen schnellen, beobachtbaren Minecraft-Java-Prototyp ist ein Client-Adapter auf Basis des **Mineflayer-Ökosystems** eine naheliegende Option. Er kann als isolierter Prozess mit dem Server kommunizieren, strukturierte Ereignisse weitergeben und getestete Bewegungs-/Pathfinding-Funktionen nutzen. Die konkrete Spielversion muss zu Beginn durch einen Kompatibilitätstest festgelegt und gepinnt werden. Bedrock, modifizierte Server, Multiplayer-PvP und beliebige Versionen gehören nicht ins MVP.

Der Adapter ist ein austauschbares Transport-/Ausführungsmodul, nicht die AI. Er meldet seine Fähigkeiten, etwa Navigation, Inventarzugriff, Blockinteraktion und verfügbare Beobachtungsfelder, über einen versionierten Vertrag. Der Agent soll nur Informationen nutzen, die der verbundene Spielclient tatsächlich beobachten kann; serverseitige Omniscience oder direkte Weltdatei-Abfragen wären für die eigentliche Policy ein unerlaubter Informationsvorteil und würden die Evaluation verfälschen.

### 10.2 Typische technische Schwierigkeiten

- Latenz, Paketverlust, verzögerte Bestätigung und Ereignisse in anderer Reihenfolge.
- Chunk-/Sichtbereichsgrenzen sowie unvollständige oder schnell veraltete lokale Karten.
- Blockierte Wege, Höhenunterschiede, Flüssigkeiten, Fallhöhen und dynamische Hindernisse.
- Unterschied zwischen „Auftrag gesendet“ und „Spielzustand hat sich geändert“.
- Unbeabsichtigte Wiederholung nicht-idempotenter Aktionen wie Angriff, Abbau oder Crafting.
- Disconnect, Tod, Respawn, Inventarverlust, neue Dimension und manuelle Übernahme.
- Versions-/Mod-Abweichungen, veränderte Rezepte und Serverregeln.
- Spielmechanik kann in Test- und Live-Servern unterschiedlich sein.

Deshalb bekommen Aufträge eindeutige IDs, Fristen und Zustandsbestätigungen. Wiederholung ist nur für ausdrücklich idempotente Operationen zulässig. Nach einem Timeout wird erst neu beobachtet und abgeglichen, bevor eine nicht-idempotente Aktion erneut versucht wird. Adapterfehler werden als eigener Zustand an Goal Manager und Safety Supervisor gemeldet.

### 10.3 Betrieb und Zugangsdaten

MVP vorzugsweise auf einem lokalen/privaten Testserver mit eigens angelegter Welt. Zugangsdaten gehören ausschließlich in lokale Secret-Verwaltung/Umgebungsvariablen und nie in Repository, UI-Telemetrie oder Episoden. Logs müssen sensible Verbindungsdaten redigieren. Automatisiertes Verhalten sollte zunächst nur in einer autorisierten Testumgebung stattfinden.

## 11. Game-Adapter-System

Ein Adapter implementiert eine versionierte Grenze mit vier Hauptaufgaben:

1. **Connect / Lifecycle:** verbinden, Capability-Handschlag, Session-ID, Disconnect, Reconnect und Fehlerzustände.
2. **Observe:** Snapshot plus Events mit Spielzeit, Beobachtungsquelle und Freshness.
3. **Act:** typisierte semantische Aufträge annehmen, validieren, abbrechen und Ergebnis/Fehler bestätigen.
4. **Describe:** Spielversion, Modus, Koordinatensystem, unterstützte Beobachtungen und Aktionen deklarieren.

Der Kern sollte ein kleines, allgemeines Vokabular für Agentenzustand, Ressourcen, Entitäten, Raumbezüge, Ziele und Fähigkeiten besitzen. Spiel-spezifische Daten bleiben in namespaced Erweiterungen. Nicht jedes Spiel hat Inventar, Blöcke oder dieselbe Bewegungssemantik – eine erzwungene universelle Ontologie würde falsche Gemeinsamkeiten schaffen.

Game-spezifische Perception, Aktionsabbildung, Primitive Skills, Rezepte und Kampf-/Bewegungsmodelle gehören in ein **Domain Pack**. Das Core übernimmt Goal Management, Memory-Schnittstellen, Telemetrie, Safety-Orchestrierung, Evaluationsprotokoll und UI-Grundgerüst. Jeder neue Adapter braucht Contract-Tests, Versionskompatibilität und mindestens eine eigene Benchmark-Suite. Transfer zwischen Spielen ist eine Forschungsfrage, keine automatische Garantie: zunächst können nur höherstufige Konzepte wie vorsichtige Exploration, Unsicherheitsbehandlung und Ressourcenplanung wiederverwendet werden.

## 12. GUI / Control Center

### 12.1 Gestaltungsziel

Eine hochwertige, Apple-inspirierte Liquid-Glass-Oberfläche mit zurückhaltender Transparenz, klarer Typografie, räumlicher Hierarchie und flüssigen, reduzierten Animationen. „Glass“ darf nie die Lesbarkeit wichtiger Werte beeinträchtigen. Kontrast, Tastaturbedienbarkeit, Screenreader-Beschriftungen, reduzierte Bewegung und eine gut lesbare Light-/Dark-Variante sind funktionale Anforderungen, keine Extras.

Die GUI ist ein Entwicklungs- und Betriebswerkzeug. Sie sollte Antworten auf drei Fragen liefern: **Was sieht der Agent? Was versucht er zu erreichen? Warum führt er gerade diesen Skill aus?** Live-Steuerung bleibt standardmäßig begrenzt und nachvollziehbar.

### 12.2 Bereiche und sinnvoller Inhalt

- **Overview:** Adapter-/Sessionzustand, Pause/Stop, aktuelles Ziel, Fortschritt, aktive Skill, Health/Risiko, letzte Entscheidung und zentrale Fehler. Nur wenige priorisierte Signale statt einer Wand aus KPIs.
- **Agent State:** Position, Inventar, Überleben, aktive Effekte, nahe Entitäten und letzte Zustandsänderungen.
- **World / Observation:** begrenzte Top-down-Ansicht mit beobachtet, unbekannt, veraltet und Gefahr als unterscheidbaren Layern; optional Rohdaten-/Entity-Inspector für Debugging.
- **Decision Model:** Zielagenda, Prioritätssignale, Meilenstein-/Planbaum, aktuelle Auswahl, Skill-Konfidenz, verworfene Alternativen und strukturierte Gründe.
- **Skills:** Katalog, Vorbedingungen, Abhängigkeiten, Version, Status, kontextbezogene Erfolgs-/Fehlerquote, letzte Episoden und Tests. Live-Änderungen an Skill-Code sind nicht Aufgabe dieser Ansicht.
- **Training:** aktive/abgeschlossene Runs, Szenarioversion, Durchsatz, Reward-Aufschlüsselung, Daten-/Modellversion, Checkpoints und Abbruchgrund. Keine irreführenden Trainingskurven, wenn kein Training läuft.
- **Evaluation:** Benchmark-Vergleich zwischen Champion/Kandidat, Seeds, Erfolgsrate, Fehlerklassen, Sicherheitsregressionen und Generalisierung.
- **Memory:** durchsuchbare Episoden/Fakten mit Quelle, Zeit, Konfidenz und Weltbezug; Korrektur, Ablauf oder Löschung mit Audit-Eintrag.
- **Logs:** chronologische Ereignisse mit Filtern für Session, Entscheidung, Skill, Adapter und Schweregrad; Korrelation vom Ziel bis zur Adapterbestätigung.
- **Configuration:** Spiel-/Adapterversion, Laufzeitlimits, Zielgewichte, Evaluationsprofile und Modellwahl. Riskante Änderungen nur kontrolliert; Geheimnisse nie anzeigen.

### 12.3 Informationsarchitektur und Bedienbarkeit

Die Hauptansicht priorisiert Live-Status und sichere Kontrolle; tiefere Ursachen liegen in Inspektionsseiten. Ein Ereignis sollte vom Overview in den zugehörigen Decision Trace und die verantwortliche Skill-Episode führen. Relevante Kontrollaktionen: **Pause nach aktueller sicherer Aktion**, **sofortiger Stopp/Abbruch**, **sicherer Resume**, **Read-only/Observer-Modus** und **neuen Szenariolauf starten**. Stopp und Pause müssen auch bei teilweisem Backend-Ausfall klaren Status zeigen.

Unnötig für den MVP sind dutzende Echtzeitdiagramme, frei editierbare interne Variablen, ungefilterte Rohpaketlogs, ein Chatbot als Ersatz für Entscheidungsgründe und komplexe 3D-Visualisierung der gesamten Welt. Erst wenn ein konkreter Debugging-/Trainingsnutzen messbar ist, sollten solche Ansichten hinzukommen.

## 13. Zusätzliche Vorschläge

Diese Ergänzungen sind bewusst über die Ausgangsidee hinaus gedacht. Sie stärken vor allem Reproduzierbarkeit, Sicherheit und kontrolliertes Lernen.

| Vorschlag | Problem, das er löst | Nutzen für GameMind | Priorität | Zeitpunkt |
|---|---|---|---|---|
| **Szenario- und Replay-Labor** | Fehler sind ohne gleiche Startbedingungen schwer reproduzierbar; reine Live-Tests sind langsam und riskant. | Seeds, Weltzustand und Ereignisfolgen wiederholen; Szenarien automatisieren; Regressionen nach jeder Änderung erkennen. | **P0** | **MVP** – zuerst einfache deterministische Szenarien und Mock-Adapter. |
| **Decision Provenance / Traceability** | Bei falschen Entscheidungen bleibt oft unklar, welche Beobachtung oder Annahme dazu geführt hat. | Jede Entscheidung bis zu State, Ziel, Skill, Action und Bestätigung zurückverfolgen; essenziell für Debugging und Vertrauen. | **P0** | **MVP** – strukturierter Trace ab dem ersten vertikalen Durchstich. |
| **Safety Ladder und Human Override** | Eine einzelne fehlgeschlagene Aktion kann zu endlosen Wiederholungen oder vermeidbarem Schaden führen. | Eskalation von Re-Observe → sichere Alternative → Replan → Pause; jederzeitige menschliche Übernahme und Audit. | **P0** | **MVP** – Stop, Pause, Timeouts und Stillstandserkennung von Anfang an. |
| **Fehler-Taxonomie und automatische Curriculum-Erzeugung** | Fehler werden häufig nur als „Episode verloren“ gespeichert und helfen dem nächsten Training wenig. | Fehler in Navigation, veraltete Wahrnehmung, Ressourcenplanung, Gefahr, Timing etc. sortieren und gezielt passende Szenarien erzeugen. | **P1** | Nach MVP, sobald ausreichend Episoden vorliegen. |
| **Skill Quality Gates und Canary-Rollouts** | Eine lokal verbesserte Skill-Version kann andere Situationen verschlechtern. | Kandidaten zuerst im Replay und in Teilmenge der Szenarien testen, vergleichen und sofort auf Champion zurückrollen. | **P1** | Erste Lern-/Optimierungsphase. |
| **Unsicherheitskalibrierung und Active Perception** | Ein Agent kann selbstbewusst auf stale oder dünne Beobachtungen reagieren. | Konfidenz mit tatsächlicher Trefferquote abgleichen und gezielt die nächste nützliche Beobachtung auswählen. | **P1** | Nach MVP; zunächst für kritische Entscheidungen. |
| **Welt-Snapshot- und Reset-Manager** | Verlässliches Training und sichere Experimente brauchen reproduzierbare, rücksetzbare Welten. | Szenarien isolieren, vor/nach Runs sichern und destruktive Experimente von wertvollen Welten trennen. | **P1** | Vor breiterem RL-/Explorationstraining. |
| **Aufgaben-/Szenario-Beschreibung statt Spezialcode** | Neue Tests oder Aufgaben erfordern sonst Änderungen an vielen Komponenten. | Goals, Startbedingungen, Erfolgskriterien und Limits konfigurierbar machen; verbessert Benchmark-Reuse und Curriculum. | **P1** | Nach dem ersten fest implementierten vertikalen Szenario. |
| **Lernfreigabe und Daten-Lifecycle** | Dauerhaftes Lernen kann falsches oder veraltetes Wissen verbreiten und schwer rückgängig zu machen sein. | Herkunft, Gültigkeit, Retention, Export/Löschung, Modell-Lineage und Freigabe jeder Wissens-/Policyänderung verwalten. | **P1** | Datenerfassung von Anfang an, erweiterte Verwaltung vor Live-Learning. |
| **Game-Transfer-Benchmark** | „Game-agnostisch“ kann ohne Messung ein Architekturversprechen ohne Beleg bleiben. | Bei einem zweiten Spiel prüfen, welche Fähigkeiten wirklich im Core wiederverwendbar sind und welche zu Recht im Domain Pack liegen. | **P2** | Erst nach stabiler Minecraft-Version und zweitem Adapter-Prototyp. |
| **Optionaler LLM-Planungspartner mit Validierung** | Bei komplexen unbekannten Situationen können symbolische Planner keine hilfreiche Hypothese finden. | Später Kandidatenziele oder Erklärungen vorschlagen; alle Vorschläge bleiben typisiert, begrenzt und durch Planner/Safety zu prüfen. | **P2** | Später und nur als optionaler Vorschlagskanal; niemals direkte Aktionsautorität. |

## 14. Risiken und technische Herausforderungen

| Risiko | Auswirkung | Gegenmaßnahme |
|---|---|---|
| **Zu großer Scope / falsches Allgemeinheitsversprechen** | Viele abstrakte Systeme, aber kein verlässlich spielender Agent. | Ein Spiel, eine Version, eine Aufgabe; jeden Abstraktionsschritt durch echten Nutzen oder einen zweiten Adapter begründen. |
| **Partielle Beobachtbarkeit und stale State** | Falsche Annahmen führen zu Fehlplanung oder Schaden. | Freshness/Confidence explizit führen, bei Risiko re-observieren, unbekannte Weltbereiche markieren. |
| **Asynchrone Aktionen und Protokolllatenz** | Doppelte Aktion, verlorene Bestätigung, nicht reproduzierbare Bugs. | Auftrags-IDs, Deadlines, Zustandsabgleich, Action Broker, idempotente Wiederholung nur wo sicher. |
| **Endlosschleifen / fehlender Fortschritt** | Ressourcenverlust oder festhängender Agent. | Progress-Metriken, Wiederholungszähler, diversifizierte Recovery, Watchdog und sichere Pause. |
| **Reward-Hacking und sparse Rewards** | Hoher Trainingsscore bei schlechtem realem Verhalten. | Fachliche Erfolgskriterien separat, Reward-Komponenten offenlegen, held-out Edge-Cases und Sicherheitsconstraints. |
| **RL-Sample- und Rechenkosten** | Training bleibt langsam oder lernt nur Startzustände auswendig. | Erst Skills/Planner/Imitation, kontrolliertes Curriculum, vielfältige Seeds und gezielte Teilprobleme. |
| **Skill-Komposition explodiert** | Unüberschaubare Kombinationen und schwer lokalisierbare Fehler. | Typisierte Vor-/Nachbedingungen, begrenzte Planlänge, Skill-Verträge und Replay-Tests. |
| **Version-/Mod-Drift bei Minecraft** | Fähigkeiten oder Beobachtungssemantik brechen ohne offensichtlichen Fehler. | Version pinnen, Adapter-Capability-Handshake, Contract-Tests und Support-Matrix. |
| **Falsche Sicherheit durch Erinnerungen** | Wissen aus anderer Welt oder anderem Kontext wird als wahr behandelt. | Welt-/Versionsbezug, Ablaufzeiten, Quellen, Konfidenz, Reset und kontrolliertes Vergessen. |
| **UI wird dekorativ statt diagnostisch** | Viele Daten, aber keine schnelle Antwort auf „Warum?“ oder „Was jetzt?“. | Jede Ansicht an konkrete Debugging-/Betriebsfragen binden, nach Nutzbarkeit testen, nur handlungsrelevante KPIs zeigen. |
| **Zugangsdaten / unsichere Plugins** | Account- oder Serverrisiko. | Secrets aus Logs/DB entfernen, lokale Testumgebung, Adapter-/Plugin-Vertrauensgrenzen, minimale Berechtigungen. |
| **Scheinbare Generalisierung** | Erfolgreiche bekannte Seeds werden mit allgemeiner Intelligenz verwechselt. | Zurückgehaltene Seeds, veränderte Bedingungen, adversariale Tests und später separater zweiter Game Adapter. |

## 15. Priorisierung der Features

### P0 – vor und im MVP

- Eine festgelegte Minecraft-Java-Version und begrenzte Testumgebung.
- Versionierter Adaptervertrag und Contract-/Mock-Tests.
- Zustandsmodell mit Quelle, Zeit und Unbekannt-/Veraltet-Markierung.
- Goal Manager mit harten Safety-Regeln, erklärbarer Priorisierung und Hysterese.
- Begrenzter Planner und überprüfbare Basis-Skills.
- Serialisierter Safety Broker, Timeout, Pause/Stop und No-progress-Watchdog.
- Strukturierte Decision Traces, Telemetrie und wiederholbare Szenarien.
- Kleines Control Center mit Live-Zustand, aktiver Entscheidung, Skills, Ereignissen und sicherer Kontrolle.

### P1 – erste robuste Version nach dem MVP

- Erweiterte Skill Library und kontextbezogene Kompetenzschätzung.
- Episodisches/semantisches Memory mit Ablauf, Suche und Herkunft.
- Mehr Variation in Szenarien, Benchmark-Suiten und Champion/Kandidat-Vergleich.
- Menschliche Korrektur/Übernahme und strukturierte Fehler-Taxonomie.
- Parameteroptimierung oder Imitation für ein klar begrenztes Problem.
- Trainings-/Evaluationsansichten, Reset- und Snapshot-Werkzeuge.

### P2 – langfristige Fähigkeiten

- RL/Hierarchical RL in ausgewählten Skills und Skill-Auswahl.
- Prozedurale Szenarioerzeugung, kontrollierte offene Exploration und Active Perception.
- LLM als optionaler, validierter Hypothesen-/Planungspartner.
- Erweiterte visuelle Perception, modifizierte/weitere Minecraft-Modi.
- Zweites Spiel mit eigenem Adapter und formaler Transfer-Evaluation.
- Verteiltes Training, umfangreiche Modellverwaltung oder Multi-Agent-Funktionen nur bei nachgewiesenem Bedarf.

## 16. Konkrete Entwicklungsphasen

### Phase 0 – Scope und technische Machbarkeit

- Zielversion, Betriebssystem, private Testumgebung und rechtliche Nutzungsgrenzen festlegen.
- Adapterkandidaten auf Verbindung, Beobachtung, Zustandsbestätigung und Abbruch testen.
- Minimales Daten-/Action-Vertragsdesign und Fehlerfälle dokumentieren.
- **Exit:** Stabiler Verbindungs- und Beobachtungsnachweis; Entscheidung über Stack und unterstützte Version ist begründet.

### Phase 1 – Fundament und Testlabor

- Modulgrenzen, Session-/Eventmodell, Logs, Mock-Adapter und deterministische Szenarien festlegen.
- Action Broker, strukturierte Auftragsresultate, Timeouts und Kill-/Pause-Pfad aufbauen.
- Schema-/Contract-Tests und State-Reducer validieren.
- **Exit:** Ungültige, veraltete und verspätete Aktionen werden reproduzierbar erkannt und sicher behandelt.

### Phase 2 – End-to-End Minecraft-Vertikalschnitt

- Echten Adapter anbinden; grundlegenden World State aufbauen.
- Goal Manager, begrenzten Planner und erste atomare Skills integrieren.
- Eine kontrollierte Aufgabe vollständig von Beobachtung über Ziel/Skill bis bestätigtem Ergebnis erledigen.
- Unterbrochene Wege, fehlende Ressourcen, einfache Gefahren und Disconnect-Fehler testen.
- **Exit:** Der Agent löst die Aufgabe durch dynamische Zustandsauswertung und Replanning, nicht durch eine feste, unveränderte Aktionsliste.

### Phase 3 – MVP-Härtung und Control Center

- Episoden/Traces, einfache dauerhafte Memory, Skill-Statistiken und Replays ergänzen.
- Overview, Live-State, Decision Trace, Skill- und Ereignisansicht sowie Pause/Stop implementieren.
- Mehrere Seeds, Fehlerfälle und Regressionen automatisieren; Datenspeicherung begrenzen und dokumentieren.
- **Exit:** Ein Entwickler kann einen Fehllauf aus dem UI/Trace verstehen, wiederholen und sicher stoppen.

### Phase 4 – Kompetenzmessung und erstes kontrolliertes Lernen

- Benchmark und Testset einfrieren; Baseline und Metriken veröffentlichen.
- Fehler-Taxonomie und Episodenqualität verbessern.
- Zuerst einfache Parameteroptimierung/Bandit oder Imitation für ein isoliertes Teilproblem prüfen.
- Champion/Kandidat-Gates, Checkpoints, Rollback und Reward-Hacking-Tests ergänzen.
- **Exit:** Eine gelernte Variante verbessert die Baseline auf zurückgehaltenen Bedingungen ohne Safety-Regression.

### Phase 5 – Autonomie und Szenariobreite

- Mehrzielplanung, längerfristige Ressourcenplanung, Unsicherheitskalibrierung und fortgeschrittene Skills.
- Curriculum, schwierigere Welten, größere Störfallabdeckung und optional ein klar abgegrenztes RL-Problem.
- **Exit:** Zuverlässige, gemessene Kompetenz über mehrere Szenarioklassen; Fehler können weiterhin reproduziert und zurückgerollt werden.

### Phase 6 – Zweiter Game Adapter

- Ein bewusst andersartiges Spiel anhand desselben Core-/Adaptervertrags prototypisieren.
- Gemeinsamkeiten, notwendige Domain-Erweiterungen und nicht übertragbare Skills dokumentieren.
- **Exit:** Belegen, welche GameMind-Kernteile tatsächlich wiederverwendbar sind; Architektur nötigenfalls vereinfachen, statt Gemeinsamkeiten zu erzwingen.

## 17. Definition eines sinnvollen MVP

Das MVP ist ein **sicherer, nachvollziehbarer, begrenzt autonomer Minecraft-Agent** – noch keine selbsttrainierende allgemeine Game-AI.

### Umfang

- Ein Agent, Minecraft Java Edition, eine gepinnte Vanilla-Version und kontrollierter privater/lokaler Server.
- Strukturierte Wahrnehmung von Position, Inventar, Gesundheit/Hunger, relevanten nahen Blöcken/Entitäten und Zustandsereignissen.
- Goal Selection mindestens für Aufgabenfortschritt und eine höher priorisierte Sicherheits-/Abbruchreaktion.
- Kleine überprüfte Skill Library, z. B. beobachten, navigieren, Holzressource beschaffen, craften/platzieren, ausrüsten, einfache Gefahr vermeiden/abbrechen.
- Begrenzter Planner, der Voraussetzungen dynamisch aus Inventar und Umgebung auflöst und bei Störungen neu plant.
- Persistente Episoden-/Decision-Traces und reproduzierbare Testläufe.
- Web-Control-Center mit Overview, Agent State, Decision Trace, Skills, Logs sowie Pause/Stop.
- Kein Online-RL, keine unvalidierten LLM-Aktionen, kein beliebiges Bauen/Kämpfen, kein Mehrspieler-PvP und kein Anspruch auf volle Survival-Autonomie.

### Vorgeschlagener Abnahmeszenario-Typ

In einer kontrollierten Welt soll der Agent aus einem frischen Startzustand ein begrenztes Starterziel erreichen, zum Beispiel eine definierte Menge Holz sammeln und daraus ein einfaches Werkzeug herstellen. Startposition, Ressourcenlage und Hindernisse variieren; einzelne Läufe enthalten eine Unterbrechung oder eine ungefährliche Störung. Der Agent muss Ziele und Skills aus dem aktuellen Zustand auswählen und nach einer ungültigen Annahme neu planen. Das konkrete Rezept-/Zielset wird erst nach dem Adapter-Kompatibilitätstest finalisiert.

### Vorläufige Abnahmekriterien

Die Schwellen sind Startwerte und werden nach einer ersten Baseline angepasst:

- Mindestens **80 % Erfolg** auf einer kleinen, vorab festgelegten Suite von mindestens 20 Test-Seeds.
- **0 unvalidierte oder außerhalb der Capability liegende Aktionen** in der Suite.
- Jeder Skill hat Timeout, Abbruch und einen bestätigten Erfolgsindikator.
- Kein unbegrenztes Wiederholen derselben erfolglosen Aktion; Stillstand führt zu Recovery oder sicherer Pause.
- Mindestens ein Störfall wird ohne Neustart durch Neu-Beobachtung/Replanning behandelt.
- Fehlläufe sind über Session-ID und Replay/Trace analysierbar.
- Stop/Pause funktioniert unabhängig davon, ob das aktuelle Ziel erfolgreich ist.

Das MVP enthält keine Behauptung, dass die AI bereits eigenständig neue Skills erfindet. Es etabliert die Daten-, Kontroll- und Evaluationspfade, über die Skill-Verbesserung später sicher messbar wird.

## 18. Langfristige Roadmap

1. **Verlässlicher Minecraft-Agent:** stabile Wahrnehmung, sichere Skills, verständliche Zielwahl, Fehlererholung und überprüfbare Aufgaben.
2. **Kompetenzbasierte Verbesserung:** bessere kontextbezogene Skill-Auswahl, Learning-to-rank/Bandits, Imitation und RL für nachweislich geeignete Teilprobleme.
3. **Längerfristige Planung und offene Exploration:** Meilensteine, Ressourcenstrategien, aktive Informationssuche, robuste Anpassung an unbekannte Weltzustände.
4. **Skalierbares Wissens-/Skill-Ökosystem:** versionierte Domain Packs, Skill-Qualitätsgates, Szenario-Curricula und nachvollziehbare Memory-Lifecycle-Verwaltung.
5. **Zweiter und weitere Game Adapter:** Transfer anhand von Benchmarks prüfen und Core nur dort verallgemeinern, wo die Erfahrung es rechtfertigt.
6. **Optionale fortgeschrittene Modelle:** multimodale Perception, LLM-gestützte Hypothesen/Planvorschläge oder hierarchische Policies – immer innerhalb der validierten Planner- und Safety-Grenzen.

## Abschließende Architekturentscheidung

Der wichtigste frühe Erfolg ist nicht ein möglichst großes Modell, sondern ein **geschlossener, sicherer und messbarer Regelkreis**: Beobachtung → expliziter World State → begründete Zielwahl → überprüfter Skill → bestätigtes Ergebnis → gespeicherte Episode → reproduzierbare Evaluation. Wenn dieser Kreis sauber funktioniert, kann GameMind seine Skills und Policies schrittweise verbessern. Ohne ihn wären RL, Memory und eine aufwendige GUI überwiegend schwer überprüfbare Komplexität.
