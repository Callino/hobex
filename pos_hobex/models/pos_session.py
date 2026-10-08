# -*- coding: utf-8 -*-

from odoo import models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _loader_params_pos_payment_method(self):
        """Ship the terminal ID to the POS frontend, and nothing else.

        17.0-only hook (18.0 has pos.payment.method._load_pos_data_fields).

        Deliberately just hobex_terminal_id: the frontend used to receive
        hobex_api_address and hobex_auth_token as well and talked to Hobex
        through a public controller, which handed the account token to every
        browser with the POS open. All Hobex traffic now goes through the
        proxy_hobex_* methods on pos.payment.method, so the credentials stay
        on the server.
        """
        params = super()._loader_params_pos_payment_method()
        params['search_params']['fields'].append('hobex_terminal_id')
        return params
