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
    :target: https://github.com/Callino/hobex/tree/19.0/pos_hobex
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

Variante A – über die Anbieter-Karten (empfohlen ab Odoo 19)
-------------------------------------------------------------
* Das Modul installieren
* Kassensystem -> Konfiguration -> Zahlungsmethoden -> Neue Zahlungsmethode
* In der Kachel-Übersicht (rechts) die ``Hobex``-Karte mit *Aktivieren* bzw.
  bei bereits installiertem Modul mit *Setup* anklicken – das Feld
  *Integration* wird automatisch auf ``Terminal`` und *Zahlungsterminal*
  auf ``Hobex`` gesetzt.
* Ein Bank-Journal auswählen oder ein neues anlegen
* Terminal ID, hobex Benutzer und Passwort ausfüllen
* Auswahl zwischen Test Modus und Echt Modus
* Mit dem Button ``Check Connection`` die Zugangsdaten prüfen
* Sind die Daten korrekt, so verschwindet der Button ``Check Connection`` und
  es erscheinen ``Renew Auth`` sowie ``Sample Transaction`` (für eine
  Probebuchung).

Variante B – manuell
--------------------
* Das Modul installieren
* Kassensystem -> Konfiguration -> Zahlungsmethoden -> Neue Zahlungsmethode
* Ein Bank-Journal auswählen oder ein neues anlegen
* Im Feld *Integration* den Wert ``Terminal`` auswählen
  (ohne diesen Schritt erscheint *Zahlungsterminal* nicht!)
* Im Feld *Zahlungsterminal* ``Hobex`` auswählen
* Terminal ID, hobex Benutzer und Passwort ausfüllen
* Auswahl zwischen Test Modus und Echt Modus
* Mit dem Button ``Check Connection`` die Zugangsdaten prüfen, danach ggf.
  über ``Sample Transaction`` eine Probebuchung auslösen.

Verhalten an der Kasse
======================
* Hobex-Zahlungen werden über das Terminal abgewickelt; der Knopf
  *Force done* (Erledigt erzwingen) wird auf hobex-Zahlungszeilen
  ausgeblendet – nicht erfolgreiche Buchungen müssen am Terminal bzw.
  durch *Cancel* abgebrochen werden.
* Bei einer erfolgreichen Buchung werden TID, Belegnummer, Karte, PAN,
  Autorisierungscode, AID und Antwortcode auf dem Kassenbon gedruckt.
* Bei Belegen mit Unterschriftspflicht (``cvm == 1``) wird – falls ein
  Drucker am IoT-Proxy angebunden ist – ein separater Händlerbeleg
  gedruckt.

Credits
=======

Authors
-------
* Callino (https://www.callino.at)

Sponsors
--------
Im Auftrag der hobex wurde dieses Modul durch die Callino entwickelt.
