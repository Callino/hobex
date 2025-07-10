# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import json
import requests
from urllib.parse import urljoin
from requests.exceptions import ReadTimeout
from werkzeug.routing import ValidationError
import uuid
import logging

_logger = logging.getLogger(__name__)


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
    ], required=True, default='production', string="Terminal Mode")
    hobex_api_address = fields.Char('Terminal Address', compute='_compute_hobex_terminal_address', store=True)
    hobex_user = fields.Char('User', required_if_terminal='hobex')
    hobex_pass = fields.Char('Password', required_if_terminal='hobex')
    hobex_auth_token = fields.Char('Token')
    hobex_connected = fields.Boolean('Connected', compute='_compute_hobex_connected', store=True)
    hobex_transaction_ids = fields.One2many('pos.payment.hobex.transaction', 'pos_payment_method_id', string="Transactions", readonly=True)
    active_pos_session_ids = fields.Many2many('pos.session', string="Active POS Sessions", compute='_compute_active_pos_sessions')

    @api.model
    def hobex_cron_renew_auth(self):
        for method in self.search([
            ('use_payment_terminal', '=', 'hobex'),
            ('hobex_user', '!=', False),
            ('hobex_pass', '!=', False)
        ]):
            try:
                method.hobex_get_auth_token()
            except:
                # Called from cron - so just ignore it here
                pass

    def hobex_renew_auth_token(self):
        self.hobex_get_auth_token()

    def hobex_get_auth_token(self):
        for method in self:
            params = {
                'userName': method.hobex_user,
                'password': method.hobex_pass
            }
            try:
                result = requests.post(urljoin(method.hobex_api_address, "/api/account/login"), json=params, timeout=15)
                if result.status_code == 401:
                    res = json.loads(result.text)
                    raise UserError(res['message'])
                method.hobex_auth_token = json.loads(result.content)['token']
            except Exception as e:
                raise UserError(_(u'hobex authentication failed. Please check credentials !'))

    def hobex_sample_transaction(self):
        self.ensure_one()
        payload = {
            "transaction": {
                "transactionType": 1,
                "tid": self.hobex_terminal_id,
                "currency": "EUR",
                "reference": str(uuid.uuid4())[:20],
                "amount": 1.0
            }
        }
        headers = {
            'Token': self.hobex_auth_token,
        }
        try:
            result = requests.post(urljoin(self.hobex_api_address, "/api/transaction/payment"), json=payload, timeout=30, headers=headers)
        except ReadTimeout as re:
            raise UserError(_(u'Timeout after 30 seconds.'))
        except Exception as e:
            raise UserError(_(u'There was an error: %s') % (str(e), ))
        _logger.debug("Result Code: %s, Result: %s", result.status_code, result.content)

    def hobex_new_transaction(self, amount, currency, reference, transaction_id):
        self.ensure_one()
        if self.use_payment_terminal!='hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        # We do create the new transaction in a new environment with a new cursor with an explicit commit
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            url = urljoin(self.hobex_api_address, "/api/transaction/payment")
            env['pos.payment.hobex.transaction'].sudo().create({
                'pos_payment_method_id': self.id,
                'reference': reference,
                'transaction_id': transaction_id,
                'amount': amount,
                'currency': currency,
                'tid': self.hobex_terminal_id,
                'url': url,
            })
            # Änderungen dauerhaft in der Datenbank speichern
            env.cr.commit()
            _logger.debug("CREATED NEW Hobex Transaction: %s", transaction_id)

    def _get_hobex_headers(self):
        self.ensure_one()
        if self.use_payment_terminal!='hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        return {
            'Token': self.hobex_auth_token,
            'Content-Type': 'application/json'
        }

    def hobex_start_sync_transaction(self, transaction_id):
        self.ensure_one()
        if self.use_payment_terminal!='hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        # We do need a new cursor here - to be able to read the transaction we created before already with a new cursor
        # The old cursor does not have this record!
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            try:
                transaction = env['pos.payment.hobex.transaction'].sudo().search([
                    ('tid', '=', self.hobex_terminal_id),
                    ('transaction_id', '=', transaction_id),
                ], limit=1)
                env.cr.commit()
                # Do use Timeout of 60 seconds - otherwise the transaction will be aborted
                # Because most Odoo Instances will run with 120 seconds timeout - if we also use 120 seconds timeout we will get a problem
                _logger.debug("Start Hobex Sync Transaction: %s", transaction_id)
                response = requests.post(
                    transaction.url,
                    data=json.dumps({
                        'transaction': {
                            'transactionType': transaction.transaction_type,
                            'amount': transaction.amount,
                            'currency': transaction.currency,
                            'tid': transaction.tid,
                            'reference': transaction.reference,
                            'transactionId': transaction.transaction_id,
                            'language': 'DE',
                        }
                    }),
                    timeout=80,
                    headers=self._get_hobex_headers(),
                )
                _logger.debug("Done Hobex Sync Transaction: %s", transaction_id)
                # api.model call - will create own env for this
                res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                    tid=transaction.tid,
                    transaction_id=transaction.transaction_id,
                    response=response
                )
                return res, response
            except Exception as e:
                transaction.update({
                    'state': 'failed',
                    'message': str(e),
                })
                _logger.info('hobex Exception: %s', str(e))
                return {
                    'responseCode': '-1',
                    'responseText': str(e),
                }, response or None

    def hobex_reversal_transaction(self, transactionId):
        self.ensure_one()
        if self.use_payment_terminal!='hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        url = urljoin(self.hobex_api_address, "/api/transaction/payment/%s/%s" % (self.hobex_terminal_id, transactionId, ))
        try:
            response = requests.delete(
                url,
                timeout=30,
                headers=self._get_hobex_headers(),
            )
            # api.model call - will create own env for this
            res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                tid=self.hobex_terminal_id,
                transaction_id=transactionId,
                response=response
            )
            return res, response
        except Exception as e:
            _logger.info('hobex Exception: %s', str(e))

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

    def proxy_hobex_status_request(self, transaction_id):
        transaction = self.env['pos.payment.hobex.transaction'].sudo().search([
            ('tid', '=', self.hobex_terminal_id),
            ('transaction_id', '=', transaction_id),
        ], limit=1)
        if not transaction:
            return {
                'error': True,
                'message': 'Transaktion nicht gefunden',
            }
        res, response = transaction.update_hobex_state(sync=True)
        if res:
            return {
                'error': False,
                'res': res,
            }
        else:
            return {
                'error': True,
                'message': 'Hobex Transaktion nicht gefunden',
            }

    def proxy_hobex_payment_request(self, data):
        # Create String from transactionid
        data['transactionId'] = str(data['transactionId'])
        # Remove - from reference
        data['reference'] = data['reference'].replace('-', '')
        # We do create the new transaction in a new environment with a new cursor with an explicit commit
        self.hobex_new_transaction(
            amount=data['amount'],
            currency=data['currency'],
            reference=data['reference'],
            transaction_id=data['transactionId'],
        )
        (res, response) = self.hobex_start_sync_transaction(data['transactionId'])
        '''
        This is for testing the Hobex cvm=1 Code - because i do not have any card here which will produce cvm=1 results 
        res['cvm'] = 1
        res['cvm_receipt'] = 'TEST123123'
        '''
        return res

    def proxy_hobex_reversal_request(self, transaction_id):
        res, response = self.hobex_reversal_transaction(transaction_id)
        return res
