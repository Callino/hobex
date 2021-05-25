# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class PosOrder(models.Model):
    _inherit = 'pos.order'

    @api.model
    def _payment_fields(self, order, ui_paymentline):
        values = super(PosOrder, self)._payment_fields(order, ui_paymentline)
        payment = self.env['pos.payment']
        for member in ui_paymentline:
            if member.startswith('hobex') and member in payment._fields:
                values[member] = ui_paymentline[member]
        return values
