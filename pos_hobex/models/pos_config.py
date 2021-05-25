# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class PosConfig(models.Model):
    _name = 'pos.config'
    _inherit = 'pos.config'

    auto_terminal_payment = fields.Boolean(string="Transaktion automatisch", default=True)
