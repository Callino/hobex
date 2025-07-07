# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class PosOrder(models.Model):
    _inherit = 'pos.order'

    @api.model
    def _payment_fields(self, order, ui_paymentline):
        """
        This method extends the `_payment_fields` method to include additional field
        logic for payment lines starting with 'hobex'. It ensures that data from
        these fields is included in the returned values if they exist in the
        `pos.payment` model fields.

        Args:
            order (dict): The POS order dictionary containing all order-related data.
            ui_paymentline (dict): A dictionary representing the payment line details,
                potentially including custom fields such as 'hobex' prefixed fields.

        Returns:
            dict: A modified dictionary of payment fields with additional custom logic
            for 'hobex' prefixed fields if they are present in the model 'pos.payment'.
        """
        values = super(PosOrder, self)._payment_fields(order, ui_paymentline)
        payment = self.env['pos.payment']
        for member in ui_paymentline:
            if member.startswith('hobex') and member in payment._fields:
                values[member] = ui_paymentline[member]
        return values
