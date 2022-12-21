# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.osv.expression import AND, OR
import logging

_logger = logging.getLogger(__name__)


class POSSession(models.Model):
    _name = 'pos.session'
    _inherit = 'pos.session'

    def _loader_params_pos_payment_method(self):
        params = super(POSSession, self)._loader_params_pos_payment_method()
        params['search_params']['fields'].extend(
            ["hobex_terminal_id", "hobex_api_address", "hobex_auth_token", "auto_validate", "open_cashdrawer"])
        return params
