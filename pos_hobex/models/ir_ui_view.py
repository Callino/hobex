# -*- coding: utf-8 -*-
from odoo import api, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    @api.model
    def _get_xml_ids_to_load(self):
        # Ship the signature receipt to the POS, which can only render the
        # receipt templates listed here.
        return super()._get_xml_ids_to_load() + ['pos_hobex.hobex_cvm_receipt']
