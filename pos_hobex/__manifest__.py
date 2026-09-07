# -*- coding: utf-8 -*-
{
    'name': 'hobex Payment Terminal',
    'summary': 'Akzeptiere Karten- und kontaktlose Zahlungen direkt an der '
               'Odoo-Kasse über hobex Zahlungsterminals.',
    'description': """
hobex Payment Terminal Integration for Odoo POS
================================================

This module integrates `hobex <https://www.hobex.at>`_ payment terminals
directly into the Odoo Point of Sale. The cashier triggers a card payment
from the POS UI, the amount is sent to the terminal over hobex's REST API,
and the result – including approval code, card brand, masked PAN and the
optional signature receipt – flows back into the corresponding ``pos.payment``
record without any manual step.

Supported terminals
-------------------
Every hobex terminal that exposes the public REST API
(``https://online.hobex.at`` for production,
``https://hobexplus.brunn.hobex.at`` for the test sandbox).

Key features
------------
* **Native POS integration** – appears alongside Adyen / Stripe / SIX in the
  payment-provider grid; a single click on the *Hobex* tile activates the
  module and pre-fills the ``Integration`` / ``Zahlungsterminal`` fields.
* **Synchronous transactions** with status polling: a payment that times out
  in the browser can be reconciled when the cashier returns to the order –
  no double charges.
* **Reversals & refunds** straight from Odoo. ``Storno`` flips the linked
  ``pos.payment.hobex.transaction`` record to ``refunded`` so the audit trail
  on the payment method form stays consistent.
* **Signature receipts** are fetched from hobex automatically when the card
  required CVM = signature, and printed via the IoT printer if one is
  connected.
* **Hardened error handling** – timeouts, connection errors, malformed
  responses and authentication failures each produce a specific message
  instead of a generic "check credentials".
* **Daily authentication renewal** via a built-in cron job, so tokens never
  silently expire mid-session.
* **Locked-down credentials** – ``hobex_user``, ``hobex_pass`` and
  ``hobex_auth_token`` are restricted to ``base.group_erp_manager``;
  POS users cannot read them via RPC, export, or the form view.
* **German translations** included (de_DE).

Setup
-----
See ``README.rst`` for the step-by-step installation guide. In short:

1. Install the module.
2. Open *Point of Sale → Configuration → Payment Methods → Create*.
3. Click the *Hobex* card in the provider grid (or set
   *Integration = Terminal* and *Zahlungsterminal = Hobex* manually).
4. Fill in Terminal ID, hobex user and password, choose Test- or
   Production-Mode and click *Check Connection*.
""",
    'version': '19.0.1.0.2',
    'category': 'Point of Sale',
    'sequence': 6,
    'website': 'https://github.com/Callino/hobex',
    'author': 'Wolfgang Pichler (Callino), Gerhard Baumgartner (Callino)',
    "license": "AGPL-3",
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/pos_payment_method.xml',
        'views/pos_payment.xml',
        'views/res_config_settings_views.xml',
        'data/cron.xml',
    ],
    'images': [
        'static/description/banner.png',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_hobex/static/src/app/**/*',
            'pos_hobex/static/src/overrides/**/*',
            'pos_hobex/static/src/xml/**/*',
        ],
        'web.assets_backend': [
            'pos_hobex/static/src/backend/**/*',
        ],
    },

    'installable': True,
    'auto_install': False,
}
