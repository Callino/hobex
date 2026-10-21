.. image:: https://guides.hobex.at/_images/logos/hobex-logo-rgb.png
  :width: 260
  :alt: hobex Logo
  :align: center

==============================
POS hobex Terminal Integration
==============================

.. |badge1| image:: https://img.shields.io/badge/maturity-Production%2FStable-green.png
    :target: https://odoo-community.org/page/development-status
    :alt: Production/Stable
.. |badge2| image:: https://img.shields.io/badge/licence-AGPL--3-blue.png
    :target: http://www.gnu.org/licenses/agpl-3.0-standalone.html
    :alt: License: AGPL-3
.. |badge3| image:: https://img.shields.io/badge/github-Callino%2Fhobex-lightgray.png?logo=github
    :target: https://github.com/Callino/hobex/tree/20.0/pos_hobex
    :alt: Callino/hobex

|badge1| |badge2| |badge3|

Dieses Modul ermöglicht das direkte Ansprechen unterstützter Terminals an der Odoo Kasse.
Unterstützt werden alle hobex Terminals, die das REST API unterstützen.

Portal für den Testmodus:
https://hobexplus.brunn.hobex.at/login

hobex Online Portal:
https://online.hobex.at/login

Installation
============

Variante A – über die Anbieter-Karten (empfohlen)
-------------------------------------------------
* Das Modul installieren
* Kassensystem -> Konfiguration -> Zahlungsmethoden -> Neue Zahlungsmethode
* In der Kachel-Übersicht (rechts) die ``Hobex``-Karte mit *Aktivieren* bzw.
  bei bereits installiertem Modul mit *Setup* anklicken – das Feld
  *Integration* wird automatisch auf ``Terminal`` und *Integrate with*
  (Zahlungsanbieter) auf ``Hobex`` gesetzt.
* Ein Bank-Journal auswählen oder ein neues anlegen
* Weiter mit den Schritten unter *Einrichtung der hobex-Verbindung*.

Variante B – manuell
--------------------
* Das Modul installieren
* Kassensystem -> Konfiguration -> Zahlungsmethoden -> Neue Zahlungsmethode
* Ein Bank-Journal auswählen oder ein neues anlegen
* Im Feld *Integration* den Wert ``Terminal`` auswählen
  (ohne diesen Schritt erscheint *Integrate with* nicht!)
* Im Feld *Integrate with* ``Hobex`` auswählen
* Weiter mit den Schritten unter *Einrichtung der hobex-Verbindung*.

Einrichtung der hobex-Verbindung
--------------------------------
Das Formular ist als Ablauf aufgebaut und führt von oben nach unten:

1. **Zugangsdaten**: Test- oder Echtmodus wählen, hobex Benutzer und
   Passwort eintragen und auf ``Check Connection`` klicken. Der Datensatz
   darf hier noch ohne Terminal-ID gespeichert werden – ohne Token gibt es
   ja noch keine Terminalliste.
2. **Terminal**: ``Check Connection`` holt die Terminals des Kontos bereits
   mit (``GET /api/terminals``) – im Schritt *2. Terminal* nur noch eines
   auswählen. Das Feld *Terminal ID* wird dabei automatisch gefüllt; wer die
   TID kennt, kann sie weiterhin direkt eintippen. Sobald Terminals geladen
   wurden, ist die Auswahl Pflicht. ``Refresh Terminals`` lädt die Liste
   später erneut, etwa wenn hobex ein Terminal hinzufügt.
3. Optional ``Sample Transaction`` für eine Probebuchung über 0,01 EUR.

Die geladenen Terminals sind auch über Kassensystem -> Konfiguration ->
*hobex Terminals* einsehbar (schreibgeschützt, wird bei jedem Laden
überschrieben).

Verhalten an der Kasse
======================
* Die Zahlung startet wie bisher sofort, sobald die hobex-Zeile angelegt wird
  (Odoo 20 macht das im Kern nur noch für Bank-QR-Codes, das Modul stellt das
  bisherige Verhalten wieder her). Abschaltbar pro Zahlungsmethode unter
  *3. Point of Sale* → *Start payment automatically*: dann kann der Betrag
  zuerst angepasst werden (Teilzahlung), gestartet wird mit *Send*.
  Retouren starten in beiden Fällen erst mit *Refund*.
* Hobex-Zahlungen werden über das Terminal abgewickelt; der Knopf
  *Force done* (Erledigt erzwingen) wird auf hobex-Zahlungszeilen
  ausgeblendet – nicht erfolgreiche Buchungen müssen am Terminal bzw.
  durch *Cancel* abgebrochen werden.
* Bei einer erfolgreichen Buchung werden TID, Belegnummer, Karte, PAN,
  Autorisierungscode, AID und Antwortcode auf dem Kassenbon gedruckt.
* Bei Belegen mit Unterschriftspflicht (``cvm == 1``) wird – falls für die
  Kasse ein Bondrucker eingerichtet ist – ein separater Händlerbeleg
  gedruckt. Ohne Bondrucker entfällt er (kein Browser-Druckdialog mitten in
  der Zahlung); die Unterschriftszeile steht ohnehin auf dem Kassenbon.

Gutschrift (Refund)
===================
Eine Gutschrift ist bei hobex eine eigenständige Transaktion: sie braucht
keinen Bezug zur ursprünglichen Zahlung und funktioniert deshalb auch nach
dem Tagesabschluss. Sie ist damit etwas anderes als das *Storno* (VOID),
das die Originaltransaktion zurücknimmt und nur bis zum Tagesabschluss
möglich ist.

An der Kasse
------------
* Kassenbeleg öffnen → *Rückgabe* → Zahlungsart hobex wählen.
* Bei Retouren startet Odoo die Terminaltransaktion nicht von selbst: auf
  der negativen Zahlungszeile erscheint der Button *Refund*, der die
  Anfrage auslöst.
* Weil der Betrag negativ ist, geht die Anfrage an ``/api/transaction/refund``
  (Gutschrift) statt an ``/api/transaction/payment``. Der Betrag wird dabei
  positiv übermittelt, das Vorzeichen bleibt in der Odoo-Zahlungszeile.
* Die Gutschrift enthält keine Kartendaten und keinen Bezug zur
  Originalzahlung — der Kunde legt die Karte am Terminal vor.
* Das Terminal verlangt dabei den Sicherheitscode, der bei der Einschulung
  übergeben wurde (hobex-Bedienungsanleitung, Abschnitt *Gutschrift
  Kreditkarte*). Laut hobex darf eine Gutschrift nur auf jene Karte erfolgen,
  mit der ursprünglich bezahlt wurde; technisch geprüft wird das nicht.

Im Backend
----------
* Kassensystem → Bestellungen → Zahlungen → Zahlung öffnen.
* *Storno (VOID)* nimmt die Originaltransaktion zurück.
* *Gutschrift* bucht eine neue Gutschrift über den vollen Zahlungsbetrag.

Storno nach dem Kassieren ist ein Sonderfall
--------------------------------------------
An der Kasse gibt es seit Odoo 20 keinen Stornoweg mehr: der Kern hat das
Zurücknehmen einer Terminal-Zahlungszeile (*Reverse*) entfernt. Nach dem
Kassieren bietet Odoo nur noch die Retoure an.

Der Backend-Button storniert zwar weiterhin bis zum Tagesabschluss, **erzeugt
aber keinen Gegenbeleg in Odoo**: Betrag der Zahlungszeile, Belegstatus,
Sitzungssumme und Buchhaltung bleiben unverändert. Das Geld ist beim Kunden,
Odoo zeigt weiter eine bezahlte Zahlung. Der Button ist deshalb für den
Ausnahmefall gedacht (falscher Betrag, Kunde noch anwesend); die Differenz
muss anschließend von Hand bereinigt werden. Der Regelweg nach dem Kassieren
ist die Retoure.

Eine bereits gebuchte Gutschrift lässt sich nicht stornieren: der Storno-Weg
adressiert ``/api/transaction/payment/<tid>/<txid>`` und kennt nur
Kauftransaktionen, hobex antwortet auf eine Gutschrift mit 404. Der Button
*Reverse at hobex* ist in der Transaktionsliste bei ``kind = refund`` daher
ausgeblendet.

Freischaltung
-------------
hobex schaltet die Gutschrift-Funktion pro Konto frei. Der aktuelle Stand
wird beim Klick auf *Check Connection* aus ``/api/account/profile``
(``canRefund``) gelesen und im Formular der Zahlungsmethode angezeigt. Ist
die Funktion nicht freigeschaltet, antwortet hobex auf den Gutschrift-Request
mit HTTP 403; die Kassierer:in bekommt dann einen entsprechenden Hinweis
statt einer generischen Fehlermeldung.

Transaktionsabbruch (Abort)
===========================
Wartet die Kasse auf die Karte, bricht *Abbrechen* an der Zahlungszeile die
Transaktion am Terminal ab. Technisch geht dabei ein Abort-Command mit
Terminal-ID und Transaction-ID an hobex
(``POST /api/transaction/abort/<tid>/<transactionId>``); der laufende
Zahlungs-Request wird **nicht** unterbrochen, sondern antwortet kurz darauf
selbst mit responseCode 8004 ("am Terminal abgebrochen"). Erst diese Antwort
gibt die Zahlungszeile wieder frei — dadurch kann die Kasse nie eine Zeile
löschen, während hobex noch mit dem Terminal spricht.

Der Abbruch ist ein eigener Endpunkt und nicht mit dem Storno zu verwechseln:
das Storno (``DELETE /api/transaction/payment/<tid>/<transactionId>``) nimmt
eine **abgeschlossene** Transaktion zurück und antwortet auf eine laufende mit
``Transaction State is not OK!``. Laut hobex ist der Abbruch außerdem nicht
mehr möglich, sobald die Karte aufgelegt wurde; ab diesem Moment läuft die
Transaktion durch und muss gegebenenfalls storniert werden.

Antwortet hobex mit 400 (bereits abgeschlossen oder abgebrochen) oder 404
(Transaktion unbekannt), gibt es nichts mehr abzubrechen — die Kasse bleibt
dann still, das Ergebnis kommt über die offene Zahlungsanfrage. Ein 403
bedeutet, dass hobex die Abbruch-Funktion für das Konto nicht freigeschaltet
hat; das wird als Meldung angezeigt.

Wichtig für die Einschulung: Ein ``200`` von hobex heißt nur, dass das
Kommando angenommen wurde — nicht, dass das Terminal abbricht. Terminals im
**Pinpad-Modus** (``terminalType = PINPAD`` in der Terminalliste) setzen den
Abbruch laut hobex-Dokumentation nicht um; sie warten weiter auf die Karte und
enden erst im eigenen Timeout, der dann als responseCode 8004 zurückkommt. Die
Kasse zeigt nach dem Abbruch deshalb den Hinweis an, dass die Anforderung
gesendet wurde und die Zahlung gegebenenfalls direkt am Gerät abgebrochen
werden muss; die Zahlungszeile bleibt währenddessen auf „Request sent".

Terminalauswahl
===============
``Check Connection`` liest über ``GET /api/terminals`` alle Terminals aus,
die dem hinterlegten hobex-Konto zugeordnet sind, und stellt sie im Formular
der Zahlungsmethode als Auswahlliste bereit; ``Refresh Terminals`` wiederholt
das jederzeit. Die geladenen Rohdaten sind nur im Entwicklermodus sichtbar –
im Normalbetrieb bleibt die Auswahlliste. Die Auswahl schreibt lediglich in
das Feld *Terminal ID*, das weiterhin die einzige von der API verwendete
Quelle ist — wer die TID manuell eintragen will, kann das unverändert tun.

Credits
=======

Authors
-------
* Callino (https://www.callino.at)

Sponsors
--------
Im Auftrag der hobex wurde dieses Modul durch die Callino entwickelt.
