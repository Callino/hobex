# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import json
import requests
from urllib.parse import urljoin

from werkzeug.routing import ValidationError


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    def _get_payment_terminal_selection(self):
        return super(PosPaymentMethod, self)._get_payment_terminal_selection() + [('hobex', 'HOBEX')]

    @api.depends('hobex_terminal_mode')
    def _compute_hobex_terminal_address(self):
        for method in self:
            method.hobex_api_address = 'https://hobexplus.brunn.hobex.at' if method.hobex_terminal_mode == 'testing' else 'https://online.hobex.at'

    @api.onchange('hobex_terminal_mode', 'hobex_user', 'hobex_pass')
    def _onchange_auth(self):
        for method in self:
            method.hobex_auth_token = None

    def _compute_active_pos_sessions(self):
        for method in self:
            method.active_pos_session_ids = self.env['pos.session'].sudo().search([
                ('state', '!=', 'closed'),
                ('payment_method_ids', 'in', method.id),
            ])

    @api.depends('hobex_auth_token')
    def _compute_hobex_connected(self):
        for method in self:
            method.hobex_connected = bool(method.use_payment_terminal=='hobex' and method.hobex_auth_token)

    hobex_terminal_id = fields.Char('Terminal ID', required_if_terminal='hobex')
    hobex_terminal_mode = fields.Selection([
        ('testing', _(u"Testmode")),
        ('production', _(u"Production")),
    ], required=True, default='production')
    hobex_api_address = fields.Char('Terminal Address', compute='_compute_hobex_terminal_address', store=True)
    hobex_user = fields.Char('Hobex User', required_if_terminal='hobex')
    hobex_pass = fields.Char('Hobex Password', required_if_terminal='hobex')
    hobex_auth_token = fields.Char('Hobex Token')
    hobex_connected = fields.Boolean('Hobex Connected', compute='_compute_hobex_connected', store=True)
    open_cashdrawer = fields.Boolean('Open Cashdrawer', default=False)
    auto_validate = fields.Boolean('Auto Validate', default=False)
    active_pos_session_ids = fields.Many2many('pos.session', string="Active POS Sessions", compute='_compute_active_pos_sessions')

    @api.model
    def cron_renew_auth(self):
        for journal in self.search([('use_payment_terminal', '=', 'hobex')]):
            try:
                journal.get_auth_token()
            except:
                # Called from cron - so just ignore it here
                pass

    def get_auth_token(self):
        for method in self:
            params = {
                'userName': method.hobex_user,
                'password': method.hobex_pass
            }
            try:
                result = requests.post(urljoin(method.hobex_api_address, "/api/account/login"), json=params, timeout=5)
                method.hobex_auth_token = json.loads(result.content)['token']
            except:
                raise UserError(_(u'Hobex authentication failed. Please check credentials !'))

    def _check_required_if_hobex(self):
        """ If the field has 'required_if_terminal="hobex"' attribute, then it is required"""
        empty_field = []
        for method in self:
            for k, f in method._fields.items():
                if method.use_payment_terminal == 'hobex' and getattr(f, 'required_if_terminal', None) == "hobex" and not method[k]:
                    empty_field.append(self.env['ir.model.fields'].search([('name', '=', k), ('model', '=', method._name)]).field_description)
        if empty_field:
            raise ValidationError((', ').join(empty_field))
        return True

    _constraints = [
        (_check_required_if_hobex, 'Required fields not filled', []),
    ]
