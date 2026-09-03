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

    @api.onchange('hobex_terminal_ref_id')
    def _onchange_hobex_terminal_ref_id(self):
        for method in self:
            if method.hobex_terminal_ref_id:
                method.hobex_terminal_id = method.hobex_terminal_ref_id.tid

    @api.onchange('hobex_terminal_mode', 'hobex_user', 'hobex_pass')
    def _onchange_auth(self):
        for method in self:
            method.hobex_auth_token = False

    def _compute_hobex_transaction_count(self):
        # sudo: the audit records are readable for POS and accounting managers
        # only, but the count sits on a form every ERP manager may open.
        domain = [('pos_payment_method_id', 'in', self.ids)]
        groups = self.env['pos.payment.hobex.transaction'].sudo()._read_group(
            domain, groupby=['pos_payment_method_id'], aggregates=['__count'])
        counts = dict(groups)
        for method in self:
            method.hobex_transaction_count = counts.get(method, 0)

    def action_view_hobex_transactions(self):
        """Open this method's transaction log, newest first."""
        self.ensure_one()
        domain = [('pos_payment_method_id', '=', self.id)]
        return {
            'type': 'ir.actions.act_window',
            'name': _('Hobex Transactions'),
            'res_model': 'pos.payment.hobex.transaction',
            'view_mode': 'list,form',
            'domain': domain,
            'context': {'search_default_groupby_state': 0},
        }

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
    # Capabilities mirrored from GET /api/account/profile. They are refreshed
    # whenever a token is fetched (Check Connection button + daily cron) so the
    # form can tell the admin up front whether Hobex enabled refunds for this
    # account. They are informational only: the refund path never blocks on
    # them, it relies on the 403 the API returns (see proxy_hobex_refund_request).
    hobex_can_refund = fields.Boolean('Refunds enabled', readonly=True,
                                      help="Hobex has enabled the refund (Gutschrift) "
                                           "function for this account.")
    hobex_can_void = fields.Boolean('Reversals enabled', readonly=True,
                                    help="Hobex has enabled the reversal (Storno) "
                                         "function for this account.")
    # Terminals available to this account, filled by hobex_load_terminals().
    # hobex_terminal_id stays the single source of truth for every API call —
    # the Many2one is only the picker that writes into it, so an account that
    # never loads its terminal list keeps working exactly as before.
    hobex_terminal_ids = fields.One2many('hobex.terminal', 'pos_payment_method_id',
                                         string="Available Terminals", readonly=True)
    hobex_terminal_ref_id = fields.Many2one('hobex.terminal', string="Select Terminal",
                                            ondelete='set null',
                                            help="Pick one of the terminals Hobex reports "
                                                 "for this account to fill in the Terminal ID.")
    # Mirrors the flag from the picked terminal so the form can warn about a
    # terminal Hobex reports as inactive - a payment against it would only
    # come back as a device error.
    hobex_terminal_active = fields.Boolean(related='hobex_terminal_ref_id.hobex_active',
                                           string="Terminal active at Hobex")
    hobex_transaction_ids = fields.One2many('pos.payment.hobex.transaction', 'pos_payment_method_id', string="Transactions", readonly=True)
    hobex_transaction_count = fields.Integer(compute='_compute_hobex_transaction_count',
                                             string="Transactions")
    active_pos_session_ids = fields.Many2many('pos.session', string="Active POS Sessions", compute='_compute_active_pos_sessions')

    @api.model
    def _load_pos_data_fields(self, config_id):
        params = super()._load_pos_data_fields(config_id)
        params += ['hobex_terminal_id']
        return params

    @api.constrains('use_payment_terminal', 'hobex_terminal_id', 'hobex_user', 'hobex_pass')
    def _check_required_if_hobex(self):
        # sudo: hobex_user / hobex_pass are restricted to base.group_erp_manager,
        # so reading them here would raise for anyone else editing the record.
        for method in self.sudo():
            if method.use_payment_terminal != 'hobex':
                continue
            missing = []
            if not method.hobex_user:
                missing.append(_('User'))
            if not method.hobex_pass:
                missing.append(_('Password'))
            # The Terminal ID is only demanded once Hobex reported the account's
            # terminals. The setup flow is credentials -> Check Connection ->
            # Load Terminals -> pick one, so a record holding nothing but
            # credentials has to be saveable — otherwise the admin could never
            # reach the step where the TID becomes known. hobex_new_transaction()
            # is the backstop for a method that stays without a terminal.
            if method.hobex_terminal_ids and not method.hobex_terminal_id:
                missing.append(_('Terminal ID'))
            if missing:
                raise ValidationError(_('Required fields for Hobex are missing: %s') % ', '.join(missing))

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
        terminal_count = None
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
                    'Timeout while contacting Hobex (%s). Please check your '
                    'internet connection and try again.'
                ) % url)
            except requests.exceptions.ConnectionError:
                _logger.warning("hobex auth: connection error to %s", url, exc_info=True)
                raise UserError(_(
                    'Could not reach the Hobex server (%s). Please check your '
                    'internet connection and the configured terminal mode.'
                ) % url)
            except requests.exceptions.RequestException as e:
                _logger.warning("hobex auth: request failed for %s", url, exc_info=True)
                raise UserError(_('Hobex request failed: %s') % e)

            if result.status_code == 401:
                # Real "wrong credentials" path — surface the Hobex message verbatim.
                try:
                    message = json.loads(result.text).get('message') or result.text
                except ValueError:
                    message = result.text
                _logger.info("hobex auth: rejected by server (%s): %s", url, message)
                raise UserError(_('Hobex authentication failed: %s') % message)

            if result.status_code != 200:
                # 5xx, unexpected 4xx — distinguish from credential failure.
                _logger.warning(
                    "Hobex auth: unexpected HTTP %s from %s: %s",
                    result.status_code, url, result.text,
                )
                raise UserError(_(
                    'Hobex returned an unexpected response (HTTP %(status)s): %(body)s'
                ) % {'status': result.status_code, 'body': result.text[:500]})

            try:
                token = json.loads(result.content)['token']
            except (ValueError, KeyError) as e:
                _logger.warning(
                    "Hobex auth: malformed success response from %s: %s",
                    url, result.text, exc_info=True,
                )
                raise UserError(_('Hobex returned a malformed response: %s') % e)

            method.hobex_auth_token = token
            # Token is valid now, so the calls below will succeed.
            method._hobex_refresh_capabilities()
            # Pull the terminal list straight away: the whole point of checking
            # the connection is to get to the terminal picker, and a second
            # click would only be in the way. A failure here is not fatal - the
            # credentials are fine, the list can still be fetched by hand.
            try:
                terminal_count = method._hobex_sync_terminals()
            except Exception:
                _logger.info("hobex: could not load terminals for method %s",
                             method.id, exc_info=True)
                terminal_count = None

        # All errors raise UserError above; reaching this point means every
        # record in self successfully authenticated.
        if terminal_count is None:
            message = _('Authentication token was renewed, but the terminal '
                        'list could not be loaded.')
        else:
            message = _('Authentication token was renewed, %s terminal(s) '
                        'available for this account.') % terminal_count
        return self._hobex_notify('success', _('Hobex connection successful'), message)

    def _hobex_api_get(self, endpoint, timeout=15):
        """GET a Hobex endpoint with the account token and return its JSON body.

        Every transport failure and every non-200 answer is translated into a
        UserError the admin can act on, so callers only ever deal with parsed
        data.
        """
        self.ensure_one()
        url = urljoin(self.hobex_api_address, endpoint)
        try:
            response = requests.get(url, timeout=timeout, headers=self._get_hobex_headers())
        except requests.exceptions.Timeout:
            _logger.warning("hobex GET %s: timeout", url)
            raise UserError(_('Timeout while contacting Hobex (%s).') % url)
        except requests.exceptions.ConnectionError:
            _logger.warning("hobex GET %s: connection error", url, exc_info=True)
            raise UserError(_(
                'Could not reach the Hobex server (%s). Please check your '
                'internet connection and the configured terminal mode.'
            ) % url)
        except requests.exceptions.RequestException as e:
            _logger.warning("hobex GET %s: request failed", url, exc_info=True)
            raise UserError(_('Hobex request failed: %s') % e)

        if response.status_code != 200:
            raise UserError(_(
                'Hobex request to %(endpoint)s failed (HTTP %(status)s): %(body)s'
            ) % {
                'endpoint': endpoint,
                'status': response.status_code,
                'body': response.text[:300],
            })

        try:
            return json.loads(response.text)
        except ValueError as e:
            _logger.warning("hobex GET %s: malformed response: %s",
                            url, response.text, exc_info=True)
            raise UserError(_('Hobex returned a malformed response: %s') % e)

    def hobex_get_profile(self):
        """Return the parsed body of GET /api/account/profile.

        The profile carries the per-account feature flags (``canRefund``,
        ``canVoid``, ``canPreAuthorize``) plus the list of terminals the
        account may drive. Requires a valid token in ``hobex_auth_token``.
        """
        return self._hobex_api_get("/api/account/profile")

    def _hobex_refund_allowed(self):
        """Check the account's refund permission before booking a credit.

        Hobex enables the refund per account, and the permission has to be
        verified on /api/account/profile before a credit is executed. The
        answer is mirrored onto the payment method so the form keeps showing
        the current state.

        A profile call that fails does NOT block the refund: refusing a
        legitimate credit because of a network hiccup would be worse than
        letting it through, and the refund POST still answers 403 by itself
        when the function is not enabled.

        :returns: False only when Hobex explicitly reports canRefund = false
        """
        self.ensure_one()
        method = self.sudo()
        try:
            if not method.hobex_auth_token:
                method.hobex_get_auth_token()
            profile = method.hobex_get_profile()
        except Exception:
            _logger.info("hobex: refund pre-flight failed for method %s, "
                         "relying on the 403 of the refund itself", self.id,
                         exc_info=True)
            return True

        can_refund = bool(profile.get('canRefund'))
        if method.hobex_can_refund != can_refund:
            method.hobex_can_refund = can_refund
        if not can_refund:
            _logger.info("hobex: account behind method %s may not refund "
                         "(canRefund = false)", self.id)
        return can_refund

    def hobex_load_terminals(self):
        """Button: refresh the terminal list and report how many there are."""
        self.ensure_one()
        if not self.sudo().hobex_auth_token:
            self.hobex_get_auth_token()
        count = self._hobex_sync_terminals()
        return self._hobex_notify(
            'success',
            _('Hobex terminals loaded'),
            _('%s terminal(s) available for this account.') % count,
        )

    def _hobex_sync_terminals(self):
        """Mirror GET /api/terminals onto hobex.terminal records.

        Kept separate from the profile call: the profile also carries a
        terminal list, but /api/terminals is the flat, purpose-built one and
        does not drag along comm/ecr credentials we have no business storing.

        Returns the number of terminals Hobex reported.
        """
        self.ensure_one()
        entries = self._hobex_api_get("/api/terminals")
        if not isinstance(entries, list):
            raise UserError(_('Hobex returned an unexpected terminal list: %s')
                            % entries)

        Terminal = self.env['hobex.terminal'].sudo()
        existing = {t.tid: t for t in self.sudo().hobex_terminal_ids}
        seen = set()
        for entry in entries:
            tid = entry.get('tid')
            if not tid:
                continue
            seen.add(tid)
            vals = {
                'merchant_name': entry.get('merchantName') or False,
                'company_name': entry.get('company') or False,
                'terminal_type': entry.get('terminalType') or False,
                'vu': entry.get('vu') or False,
                'city': entry.get('city') or False,
                'hobex_active': bool(entry.get('active')),
            }
            if tid in existing:
                existing[tid].write(vals)
            else:
                Terminal.create(dict(vals, tid=tid, pos_payment_method_id=self.id))

        # Drop terminals Hobex no longer reports. The Many2one is
        # ondelete='set null', so a stale selection clears itself instead of
        # blocking the delete — hobex_terminal_id keeps the configured value.
        stale = Terminal.browse([t.id for tid, t in existing.items() if tid not in seen])
        if stale:
            stale.unlink()

        # Point the picker at whatever is configured, so the form does not look
        # unset right after loading.
        if self.hobex_terminal_id:
            match = self.sudo().hobex_terminal_ids.filtered(
                lambda t: t.tid == self.hobex_terminal_id)
            if match and self.hobex_terminal_ref_id != match[:1]:
                self.hobex_terminal_ref_id = match[:1]

        return len(seen)

    def _hobex_refresh_capabilities(self):
        """Mirror the account feature flags onto the payment method.

        Never raises: a profile hiccup must not break the login flow, the
        flags are a convenience for the admin form only.
        """
        for method in self.sudo():
            try:
                profile = method.hobex_get_profile()
            except Exception:
                _logger.info("hobex: could not refresh capabilities for method %s",
                             method.id, exc_info=True)
                continue
            method.update({
                'hobex_can_refund': bool(profile.get('canRefund')),
                'hobex_can_void': bool(profile.get('canVoid')),
            })

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
                'Could not reach the Hobex server (%s). Please check your '
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
            return self._hobex_notify('danger', _('Hobex authentication failed'),
                                     body.get('message') or result.text)
        if result.status_code != 200:
            return self._hobex_notify(
                'danger',
                _('Hobex sample transaction failed (HTTP %s)') % result.status_code,
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
            message = "\n".join(details) or _("Hobex accepted the sample transaction.")
            return self._hobex_notify('success',
                                     _('Hobex sample transaction successful'),
                                     message)

        # Non-zero responseCode: terminal/business rejection — surface code + message.
        return self._hobex_notify(
            'warning',
            _('Hobex sample transaction rejected'),
            _("Code %(code)s: %(text)s") % {
                'code': response_code or '?',
                'text': response_text or _('No further details from the terminal.'),
            },
        )

    def _hobex_notify(self, level, title, message):
        """Push a toast over the bus and return True.

        Deliberately NOT an ir.actions.client dict: a button that returns an
        action makes the web client execute that action *instead of* reloading
        the record, so everything the method just wrote (auth token, terminal
        list, account flags, Terminal ID) would stay invisible on the form
        until a manual refresh. Returning True lets the client reload; the
        message travels over the bus.

        Call this on a recordset in the *user's* environment — under sudo()
        `env.user` is the superuser and the notification would be sent to a
        channel nobody is listening on.
        """
        if self.env.su:
            # Cron and other server-side callers have no browser session on the
            # other end; writing bus rows for the superuser is pure waste.
            return True
        self.env.user._bus_send('simple_notification', {
            'type': level,            # 'success' / 'warning' / 'danger' / 'info'
            'title': title,
            'message': message,
            'sticky': level != 'success',
        })
        return True

    # Endpoint per transaction kind. A refund ("Gutschrift") is a standalone
    # credit: Hobex needs no reference to an earlier transaction and accepts an
    # arbitrary amount, so the two kinds only differ in the URL and in the
    # payload built by hobex_start_sync_transaction().
    HOBEX_ENDPOINTS = {
        'payment': "/api/transaction/payment",
        'refund': "/api/transaction/refund",
    }

    def hobex_new_transaction(self, amount, currency, reference, transaction_id, kind='payment'):
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        if not self.hobex_terminal_id:
            # The form-level constraint lets a half-configured method be saved
            # so the terminal list can be fetched; refuse to talk to Hobex
            # without a TID rather than sending a request that cannot work.
            raise UserError(_(
                'No terminal is selected for the payment method "%s". Open it and '
                'pick one under "Terminal".'
            ) % self.display_name)
        # We do create the new transaction in a new environment with a new cursor with an explicit commit
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            url = urljoin(self.hobex_api_address, self.HOBEX_ENDPOINTS[kind])
            env['pos.payment.hobex.transaction'].sudo().create({
                'pos_payment_method_id': self.id,
                'reference': reference,
                'transaction_id': transaction_id,
                'amount': amount,
                'currency': currency,
                'tid': self.hobex_terminal_id,
                'kind': kind,
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
                payload = {
                    'amount': transaction.amount,
                    'currency': transaction.currency,
                    'tid': transaction.tid,
                    'reference': transaction.reference,
                    'transactionId': transaction.transaction_id,
                    'language': 'DE',
                }
                if transaction.kind != 'refund':
                    # /api/transaction/refund derives the type from the
                    # endpoint; sending transactionType=1 (SELL) there would
                    # contradict it, so only payments carry the field.
                    payload['transactionType'] = transaction.transaction_type
                response = requests.post(
                    transaction.url,
                    data=json.dumps({'transaction': payload}),
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
                # Only flag the transaction failed when we actually have one;
                # otherwise we'd hit AttributeError / NameError on the way out
                # and lose the original cause.
                if transaction:
                    transaction.update({
                        'state': 'failed',
                        'message': str(e),
                    })
                _logger.info('hobex Exception: %s', str(e))
                return {
                    'responseCode': '-1',
                    'responseText': str(e),
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

    def hobex_abort_transaction(self, transaction_id):
        """Abort a transaction that is still running on the terminal.

        Own endpoint, distinct from the reversal: POST /api/transaction/abort/
        <tid>/<transactionId>. The reversal route (DELETE on the payment URL)
        only accepts a *completed* transaction and answers HTTP 400
        "Transaction State is not OK!" for one that is still waiting for the
        card. Hobex also notes that the abort is no longer possible once the
        card has been tapped.

        The pending POST /api/transaction/payment is deliberately NOT touched
        here - Hobex lets it run and answers it with responseCode 8004
        ("aborted at terminal"). That response is what flips the payment line,
        which is also why this method must not write to the transaction record:
        the still-open payment request is the one that owns its final state,
        and a second writer would race it.
        """
        self.ensure_one()
        if self.use_payment_terminal != 'hobex':
            raise UserError(_('This method is only available for Hobex payment methods.'))
        url = urljoin(self.hobex_api_address, "/api/transaction/abort/%s/%s" % (
            self.hobex_terminal_id, transaction_id))
        try:
            response = requests.post(url, timeout=30, headers=self._get_hobex_headers())
        except requests.exceptions.RequestException as e:
            _logger.warning("hobex abort: request failed for %s", url, exc_info=True)
            return {'error': True, 'message': str(e)}

        if response.status_code == 200:
            # The body optionally names the transaction that was aborted. An
            # empty body means Hobex accepted the command without reporting an
            # aborted transaction - worth seeing in the log when the terminal
            # keeps waiting for the card anyway.
            _logger.info("hobex abort: accepted for %s/%s, response: %s",
                         self.hobex_terminal_id, transaction_id, response.text or '<leer>')
            return {'error': False}

        if response.status_code == 403:
            # Hobex enables the abort per account, same as the refund.
            _logger.warning("hobex abort: not enabled for this account (%s)", url)
            return {'error': True, 'message': _(
                'The abort function is not enabled for this Hobex account. '
                'Please ask Hobex to activate it.'
            )}

        if response.status_code in (400, 404):
            # 400 = already captured or cancelled, 404 = Hobex never saw the
            # transaction. Both mean there is nothing left to abort, and the
            # still-open payment request reports the outcome anyway, so this is
            # not something the cashier has to act on.
            _logger.info("hobex abort: nothing to abort for %s/%s (HTTP %s): %s",
                         self.hobex_terminal_id, transaction_id,
                         response.status_code, response.text)
            return {'error': False, 'nothing_to_abort': True}

        message = self.env['pos.payment.hobex.transaction']._hobex_error_message(response)
        _logger.warning("hobex abort: HTTP %s for %s: %s",
                        response.status_code, url, response.text)
        return {'error': True, 'message': message}

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
                'message': _('Transaction not found'),
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
                'message': _('Hobex transaction not found'),
            }

    def _hobex_run_transaction(self, data, kind):
        """Create the audit record and run the synchronous Hobex call.

        Shared by the payment and the refund proxy: the two differ only in the
        endpoint, which `kind` selects via HOBEX_ENDPOINTS.
        """
        self.ensure_one()
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
            kind=kind,
        )
        (res, response) = self.hobex_start_sync_transaction(data['transactionId'])
        return res

    def proxy_hobex_payment_request(self, data):
        self.ensure_one()
        self._check_pos_user_or_su()
        return self._hobex_run_transaction(data, 'payment')

    def proxy_hobex_refund_request(self, data):
        """Book a standalone credit (Gutschrift) on the terminal.

        Hobex wants a *positive* amount on /api/transaction/refund and rejects
        0 or a negative value with "Invalid Amount" — the POS sends the amount
        of a negative payment line, so normalise it here rather than relying on
        every caller to do it.

        The account's permission is verified on GET /api/account/profile
        before the credit is sent (_hobex_refund_allowed). Should that check
        pass but Hobex still refuse, the refund POST answers 403 and
        _update_transaction_with_hobex_result() turns it into a responseCode of
        '-403' plus `hobex_forbidden` - the POS renders the same "needs to be
        enabled by Hobex" message for both.
        """
        self.ensure_one()
        self._check_pos_user_or_su()
        data = dict(data, amount=abs(data['amount']))
        if not data['amount']:
            return {
                'responseCode': '-1',
                'responseText': _('A refund needs an amount greater than zero.'),
            }
        if not self._hobex_refund_allowed():
            # Same shape as the 403 the refund itself would answer with, so the
            # POS renders the "needs to be enabled by Hobex" message either way.
            return {
                'responseCode': '-403',
                'responseText': _(
                    'The refund (Gutschrift) function is not enabled for this '
                    'Hobex account. Please ask Hobex to activate it.'
                ),
                'hobex_forbidden': True,
            }
        return self._hobex_run_transaction(data, 'refund')

    def proxy_hobex_abort_request(self, transaction_id):
        self.ensure_one()
        self._check_pos_user_or_su()
        return self.hobex_abort_transaction(transaction_id)

    def proxy_hobex_reversal_request(self, transaction_id):
        self.ensure_one()
        self._check_pos_user_or_su()
        res, response = self.hobex_reversal_transaction(transaction_id)
        return res
