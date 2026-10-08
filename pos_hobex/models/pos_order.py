# -*- coding: utf-8 -*-

from odoo import api, models


class PosOrder(models.Model):
    _inherit = 'pos.order'

    @api.model
    def _payment_fields(self, order, ui_paymentline):
        """Carry the hobex_* values of a pushed payment line onto pos.payment.

        17.0-only hook: the POS sends payment lines as plain dicts, and core
        copies only the keys it knows about. 18.0 pushes pos.payment records
        through the ORM data service, where the stored fields travel by
        themselves.

        The names come from pos.payment.HOBEX_UI_FIELDS, the same list
        _export_for_ui() uses for the opposite direction, so a field added
        there is picked up here without a second edit.
        """
        values = super()._payment_fields(order, ui_paymentline)
        for name in self.env['pos.payment'].HOBEX_UI_FIELDS:
            if name in ui_paymentline:
                values[name] = ui_paymentline[name]
        return values
