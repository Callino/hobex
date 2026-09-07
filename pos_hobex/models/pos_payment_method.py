# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError, ValidationError, AccessDenied
import json
import requests
from urllib.parse import urljoin
from requests.exceptions import ReadTimeout
import uuid
import logging

_logger = logging.getLogger(__name__)


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [('hobex', 'HOBEX')]

    @api.depends('hobex_terminal_mode')
    def _compute_hobex_terminal_address(self):
        for method in self:
            method.hobex_api_address = 'https://hobexplus.brunn.hobex.at' if method.hobex_terminal_mode == 'testing' else 'https://online.hobex.at'

    @api.onchange('hobex_terminal_mode', 'hobex_user', 'hobex_pass')
    def _onchange_auth(self):
        for method in self:
            method.hobex_auth_token = False

    def _compute_active_pos_sessions(self):
        for method in self:
            method.active_pos_session_ids = self.env['pos.session'].sudo().search([
                ('state', '!=', 'closed'),
                ('payment_method_ids', 'in', method.id),
            ])

    @api.depends('hobex_auth_token', 'use_payment_terminal')
    def _compute_hobex_connected(self):
        # hobex_auth_token is group-restricted; read it via sudo so the compute
        # still resolves for users that don't have base.group_erp_manager.
        for method in self.sudo():
            method.hobex_connected = bool(method.use_payment_terminal == 'hobex' and method.hobex_auth_token)

    hobex_terminal_id = fields.Char('Terminal ID')
    hobex_terminal_mode = fields.Selection([
        ('testing', "Testmode"),
        ('production', "Production"),
    ], required=True, default='production', string="Terminal Mode")
    hobex_api_address = fields.Char('Terminal Address', compute='_compute_hobex_terminal_address', store=True)
    # Credentials: restricted to ERP managers so a POS cashier with read access
    # to pos.payment.method cannot exfiltrate them. POS-facing methods below
    # use .sudo() to read these where needed (same pattern as pos_adyen).
    hobex_user = fields.Char('User', groups='base.group_erp_manager')
    hobex_pass = fields.Char('Password', groups='base.group_erp_manager')
    hobex_auth_token = fields.Char('Token', groups='base.group_erp_manager')
    hobex_connected = fields.Boolean('Connected', compute='_compute_hobex_connected', store=True)
    hobex_transaction_ids = fields.One2many('pos.payment.hobex.transaction', 'pos_payment_method_id', string="Transactions", readonly=True)
    active_pos_session_ids = fields.Many2many('pos.session', string="Active POS Sessions", compute='_compute_active_pos_sessions')

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += ['hobex_terminal_id']
        return params

    @api.constrains('use_payment_terminal', 'hobex_terminal_id', 'hobex_user', 'hobex_pass')
    def _check_required_if_hobex(self):
        for method in self:
            if method.use_payment_terminal == 'hobex':
                missing = []
                if not method.hobex_terminal_id:
                    missing.append(_('Terminal ID'))
                if not method.hobex_user:
                    missing.append(_('User'))
                if not method.hobex_pass:
                    missing.append(_('Password'))
                if missing:
                    raise ValidationError(_('Required fields for hobex are missing: %s') % ', '.join(missing))

    @api.model
    def hobex_cron_renew_auth(self):
        for method in self.search([
            ('use_payment_terminal', '=', 'hobex'),
            ('hobex_user', '!=', False),
            ('hobex_pass', '!=', False),
        ]):
            try:
                method.hobex_get_auth_token()
            except Exception:
                # Called from cron - so just ignore it here
                pass

    def hobex_get_auth_token(self):
        # Reads hobex_user / hobex_pass and writes hobex_auth_token, all of
        # which are restricted to base.group_erp_manager. Use sudo so the
        # method works for the cron and for managers without that group.
        for method in self.sudo():
            params = {
                'userName': method.hobex_user,
                'password': method.hobex_pass,
            }
            url = urljoin(method.hobex_api_address, "/api/account/login")
            try:
                result = requests.post(url, json=params, timeout=15)
            except requests.exceptions.Timeout:
                _logger.warning("hobex auth: timeout contacting %s", url, exc_info=True)
                raise UserError(_(
                    'Timeout while contacting hobex (%s). Please check your '
                    'internet connection and try again.'
                ) % url)
            except requests.exceptions.ConnectionError:
                _logger.warning("hobex auth: connection error to %s", url, exc_info=True)
                raise UserError(_(
                    'Could not reach the hobex server (%s). Please check your '
                    'internet connection and the configured terminal mode.'
                ) % url)
            except requests.exceptions.RequestException as e:
                _logger.warning("hobex auth: request failed for %s", url, exc_info=True)
                raise UserError(_('hobex request failed: %s') % e)

            if result.status_code == 401:
                # Real "wrong credentials" path — surface the hobex message verbatim.
                try:
                    message = json.loads(result.text).get('message') or result.text
                except ValueError:
                    message = result.text
                _logger.info("hobex auth: rejected by server (%s): %s", url, message)
                raise UserError(_('hobex authentication failed: %s') % message)

            if result.status_code != 200:
                # 5xx, unexpected 4xx — distinguish from credential failure.
                _logger.warning(
                    "hobex auth: unexpected HTTP %s from %s: %s",
                    result.status_code, url, result.text,
                )
                raise UserError(_(
                    'hobex returned an unexpected response (HTTP %(status)s): %(body)s'
                ) % {'status': result.status_code, 'body': result.text[:500]})

            try:
                token = json.loads(result.content)['token']
            except (ValueError, KeyError) as e:
                _logger.warning(
                    "hobex auth: malformed success response from %s: %s",
                    url, result.text, exc_info=True,
                )
                raise UserError(_('hobex returned a malformed response: %s') % e)

            method.hobex_auth_token = token

        # All errors raise UserError above; reaching this point means every
        # record in self successfully authenticated. Return a notification
        # action for button callers (the cron and internal callers ignore
        # the return value, so this is safe).
        return self._hobex_notify(
            'success',
            _('hobex connection successful'),
            _('Authentication token was renewed.'),
        )

    def hobex_sample_transaction(self):
        self.ensure_one()
        payload = {
            "transaction": {
                "transactionType": 1,
                "tid": self.hobex_terminal_id,
                "currency": "EUR",
                "reference": str(uuid.uuid4())[:20],
                "amount": 0.01,
            }
        }
        headers = {
            # hobex_auth_token is group-restricted; sudo() bypasses the field ACL
            # for this single read.
            'Token': self.sudo().hobex_auth_token,
        }
        url = urljoin(self.hobex_api_address, "/api/transaction/payment")
        try:
            result = requests.post(url, json=payload, timeout=30, headers=headers)
        except ReadTimeout:
            _logger.warning("hobex sample: timeout contacting %s", url)
            raise UserError(_('Timeout after 30 seconds.'))
        except requests.exceptions.ConnectionError:
            _logger.warning("hobex sample: connection error to %s", url, exc_info=True)
            raise UserError(_(
                'Could not reach the hobex server (%s). Please check your '
                'internet connection and the configured terminal mode.'
            ) % url)
        except Exception as e:
            _logger.warning("hobex sample: request failed for %s", url, exc_info=True)
            raise UserError(_('There was an error: %s') % (str(e),))
        _logger.debug("Result Code: %s, Result: %s", result.status_code, result.content)

        # Parse + surface a real notification.
        try:
            body = json.loads(result.text) if result.text else {}
        except ValueError:
            body = {}

        if result.status_code == 401:
            return self._hobex_notify('danger', _('hobex authentication failed'),
                                     body.get('message') or result.text)
        if result.status_code != 200:
            return self._hobex_notify(
                'danger',
                _('hobex sample transaction failed (HTTP %s)') % result.status_code,
                body.get('message') or (result.text[:300] if result.text else ''),
            )

        response_code = body.get('responseCode')
        response_text = body.get('responseText') or ''
        if response_code == "0":
            details = []
            if body.get('brand'):
                details.append(_("Card: %s") % body['brand'])
            if body.get('cardNumber'):
                details.append(_("PAN: %s") % body['cardNumber'])
            if body.get('approvalCode'):
                details.append(_("Approval: %s") % body['approvalCode'])
            if body.get('transactionId'):
                details.append(_("Transaction ID: %s") % body['transactionId'])
            message = "\n".join(details) or _("hobex accepted the sample transaction.")
            return self._hobex_notify('success',
                                     _('hobex sample transaction successful'),
                                     message)

        # Non-zero responseCode: terminal/business rejection — surface code + message.
        return self._hobex_notify(
            'warning',
            _('hobex sample transaction rejected'),
            _("Code %(code)s: %(text)s") % {
                'code': response_code or '?',
                'text': response_text or _('No further details from the terminal.'),
            },
        )

    @staticmethod
    def _hobex_notify(level, title, message):
        """Return an ir.actions.client dict that displays a toast notification."""
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': title,
                'message': message,
                'type': level,        # 'success' / 'warning' / 'danger' / 'info'
                'sticky': level != 'success',
            },
        }

    def hobex_new_transaction(self, amount, currency, reference, transaction_id):
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
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
            env.cr.commit()
            _logger.debug("CREATED NEW Hobex Transaction: %s", transaction_id)

    def _get_hobex_headers(self):
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        return {
            # hobex_auth_token is group-restricted; sudo() lets POS callers
            # (cashiers without base.group_erp_manager) build the auth header.
            'Token': self.sudo().hobex_auth_token,
            'Content-Type': 'application/json',
        }

    def hobex_start_sync_transaction(self, transaction_id):
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        # New cursor needed to read the transaction created above in another cursor
        response = None
        # Initialise transaction *before* the try so the except handler can
        # safely reference it even if the search itself raises (DB error,
        # cursor problem). An empty recordset .update() is a no-op so the
        # `if transaction:` guard below also covers the "not found" case.
        transaction = self.env['pos.payment.hobex.transaction']
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            try:
                transaction = env['pos.payment.hobex.transaction'].sudo().search([
                    ('tid', '=', self.hobex_terminal_id),
                    ('transaction_id', '=', transaction_id),
                ], limit=1)
                if not transaction:
                    raise UserError(_('Hobex transaction %s/%s not found in DB.') % (self.hobex_terminal_id, transaction_id))
                env.cr.commit()
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
                res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                    tid=transaction.tid,
                    transaction_id=transaction.transaction_id,
                    response=response,
                )
                return res, response
            except Exception as e:
                # No usable answer from hobex (timeout, connection error, unexpected response).
                # The outcome of the payment is unknown - the customer may still complete it at
                # the terminal - so the transaction stays pending and its real state has to be
                # fetched afterwards via update_hobex_state() (the POS does this automatically).
                # Never guess a final state here: a wrong 'failed' leads to double charges.
                if isinstance(e, requests.exceptions.Timeout):
                    message = _('No answer from hobex within 80 seconds.')
                elif isinstance(e, requests.exceptions.ConnectionError):
                    message = _('hobex server not reachable: %s') % (str(e),)
                else:
                    message = str(e)
                # Only touch the transaction when we actually have one (the search itself may
                # have raised) - an empty recordset would be a no-op anyway.
                if transaction:
                    transaction.update({
                        'message': message,
                    })
                _logger.warning('hobex transaction %s: no result (%s)', transaction_id, str(e))
                return {
                    'responseCode': '-1',
                    'responseText': message,
                }, response

    def hobex_reversal_transaction(self, transactionId):
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        url = urljoin(self.hobex_api_address, "/api/transaction/payment/%s/%s" % (self.hobex_terminal_id, transactionId))
        try:
            response = requests.delete(
                url,
                timeout=30,
                headers=self._get_hobex_headers(),
            )
            res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                tid=self.hobex_terminal_id,
                transaction_id=transactionId,
                response=response,
            )
            return res, response
        except Exception as e:
            _logger.info('hobex Exception: %s', str(e))
            return None, None

    def _check_pos_user_or_su(self):
        """Reject calls from non-POS users when not running as superuser.

        The proxy_hobex_* methods are exposed to the POS frontend via
        pos.data.silentCall, so any logged-in user could in theory invoke
        them. Restricting to POS users is the same defence pos_adyen uses.
        """
        if not self.env.su and not self.env.user.has_group('point_of_sale.group_pos_user'):
            raise AccessDenied()

    def proxy_hobex_status_request(self, transaction_id):
        self.ensure_one()
        self._check_pos_user_or_su()
        transaction = self.env['pos.payment.hobex.transaction'].sudo().search([
            ('tid', '=', self.hobex_terminal_id),
            ('transaction_id', '=', transaction_id),
        ], limit=1)
        if not transaction:
            return {
                'error': True,
                'code': 'not_found',
                'message': 'Transaktion nicht gefunden',
            }
        try:
            res, response = transaction.update_hobex_state(sync=True)
        except Exception as e:
            # hobex not reachable - the state of the transaction is still unknown, the POS
            # must keep the transaction and ask again (never start a new one here)
            _logger.warning('hobex transaction %s: state request failed (%s)', transaction_id, str(e))
            return {
                'error': True,
                'code': 'no_answer',
                'message': 'Keine Antwort vom hobex Server - der Status der Zahlung ist unbekannt. Bitte erneut versuchen.',
            }
        if res:
            return {
                'error': False,
                'res': res,
            }
        else:
            # 404 on hobex side - the transaction never reached hobex, a new one may be started
            return {
                'error': True,
                'code': 'not_found',
                'message': 'Hobex Transaktion nicht gefunden',
            }

    def proxy_hobex_payment_request(self, data):
        self.ensure_one()
        self._check_pos_user_or_su()
        # Create String from transactionid
        data['transactionId'] = str(data['transactionId'])
        # Hobex limits the reference to 20 chars: strip hyphens and truncate.
        data['reference'] = data['reference'].replace('-', '')[:20]
        # We do create the new transaction in a new environment with a new cursor with an explicit commit
        self.hobex_new_transaction(
            amount=data['amount'],
            currency=data['currency'],
            reference=data['reference'],
            transaction_id=data['transactionId'],
        )
        (res, response) = self.hobex_start_sync_transaction(data['transactionId'])
        return res

    def proxy_hobex_reversal_request(self, transaction_id):
        self.ensure_one()
        self._check_pos_user_or_su()
        res, response = self.hobex_reversal_transaction(transaction_id)
        return res
