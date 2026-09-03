# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # The `module_<name>` magic on res.config.settings tells Odoo to install
    # the `<name>` addon when the boolean flips True (and uninstall when it
    # flips back). Declaring the field here makes the "hobex" row appear in
    # POS → Configuration → Settings → Payment Terminals, alongside Adyen,
    # Stripe, etc.
    module_pos_hobex = fields.Boolean(
        string="Hobex Payment Terminal",
        help="The transactions are processed by Hobex. "
             "Set your Hobex credentials on the related payment method.",
    )
