# -*- coding: utf-8 -*-
from odoo import api, fields, models


class HobexTerminal(models.Model):
    """A terminal as reported by GET /api/terminals.

    Mirrored per payment method rather than globally: the terminal list is
    whatever the account behind `hobex_user` may drive, so two payment methods
    with different credentials legitimately see different terminals.
    """
    _name = 'hobex.terminal'
    _description = 'Hobex Terminal'
    _order = 'tid'

    pos_payment_method_id = fields.Many2one(
        'pos.payment.method', string="Payment Method",
        required=True, ondelete='cascade', index=True)
    tid = fields.Char('Terminal ID', required=True)
    merchant_name = fields.Char('Merchant')
    company_name = fields.Char('Company')
    terminal_type = fields.Char('Terminal Type')
    vu = fields.Char('VU Number')
    city = fields.Char('City')
    # `active` is reserved by Odoo for the archive mechanism, so the flag Hobex
    # reports gets its own name instead of silently turning records invisible.
    hobex_active = fields.Boolean('Active at Hobex')

    _sql_constraints = [
        ('tid_method_uniq', 'unique(tid, pos_payment_method_id)',
         'A terminal ID can only be listed once per payment method!'),
    ]

    @api.depends('tid', 'merchant_name')
    def _compute_display_name(self):
        for terminal in self:
            terminal.display_name = (
                "%s - %s" % (terminal.tid, terminal.merchant_name)
                if terminal.merchant_name else terminal.tid
            )
