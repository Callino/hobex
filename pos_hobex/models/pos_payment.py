# -*- coding: utf-8 -*-

from odoo import models, fields, _
from odoo.exceptions import UserError
import json
import time
import logging

_logger = logging.getLogger(__name__)


class PosPayment(models.Model):
    _inherit = 'pos.payment'

    hobex_receipt = fields.Char('hobex Receipt Number')
    hobex_approvalCode = fields.Char('hobex Approval Code')
    hobex_actionCode = fields.Char('hobex Crypto Code')
    hobex_aid = fields.Char('hobex Aid')
    hobex_reference = fields.Char('hobex Ref Number')
    hobex_tid = fields.Char('hobex TID')
    hobex_transactionId = fields.Char('hobex Transaction ID')
    hobex_transactionDate = fields.Char('hobex Transaction Date')
    hobex_cardNumber = fields.Char('hobex Card Number')
    hobex_cardExpiry = fields.Char('hobex Card Expiry')
    hobex_brand = fields.Char('hobex Card Brand')
    hobex_cardIssuer = fields.Char('hobex Card Issuer')
    hobex_transactionType = fields.Char('hobex Transaction Type')
    hobex_responseCode = fields.Char('hobex Response Code')
    hobex_responseText = fields.Char('hobex Response Text')
    hobex_cvm = fields.Char('hobex CVM')
    # Set when a standalone credit (Gutschrift) was booked for this payment,
    # so the button can't be pressed twice and the audit record stays linked.
    hobex_refund_transaction_id = fields.Many2one(
        'pos.payment.hobex.transaction', string='hobex Refund Transaction',
        readonly=True, ondelete='set null',
        help="The credit (Gutschrift) booked on the terminal for this payment.")

    # Note: pos.payment's default `_load_pos_data_fields` returns `[]`, which
    # is interpreted as "load all fields" by both `_load_pos_data`
    # (its `search_read(domain, [])` reads every field) and
    # `_load_pos_data_relations` (its filter only kicks in when the list is
    # non-empty). Overriding it to return our hobex_* fields would *restrict*
    # the loaded fields and drop pos_order_id et al. The hobex_* fields are
    # stored on the model, so the default "all fields" behaviour already
    # includes them - in the POS record and in its serialization back.

    def hobex_refund(self):
        """Book a standalone credit (Gutschrift) for this payment.

        This is NOT the reversal in hobex_reversal(): a reversal (VOID) cancels
        the original transaction and is only possible until hobex closes the
        batch. A credit is an independent transaction — hobex needs no
        reference to the original sale, which makes it the fallback once the
        end of day has run.

        Like every hobex transaction this one is synchronous: the customer has
        to present their card on the terminal while the request is open.
        """
        self.ensure_one()
        method_sudo = self.payment_method_id.sudo()
        if method_sudo.use_payment_terminal != 'hobex':
            raise UserError(_('This payment was not made through a hobex terminal.'))
        if self.hobex_refund_transaction_id:
            raise UserError(_('A credit was already booked for this payment on %s.')
                            % self.hobex_refund_transaction_id.transaction_date)
        amount = abs(self.amount)
        if not amount:
            raise UserError(_('A refund needs an amount greater than zero.'))
        if not method_sudo._hobex_refund_allowed():
            raise UserError(_(
                'The refund (Gutschrift) function is not enabled for this '
                'hobex account. Please ask hobex to activate it.'
            ))

        # hobex_auth_token is restricted to base.group_erp_manager; sudo so
        # account users that may refund a pos.payment can still build the
        # outbound auth header (the credential never leaves the server).
        if not method_sudo.hobex_auth_token:
            method_sudo.hobex_get_auth_token()

        transaction_id = str(int(time.time() * 1000))
        reference = (self.hobex_reference or self.pos_order_id.name or '').replace('-', '')[:20]
        method_sudo.hobex_new_transaction(
            amount=amount,
            currency=self.currency_id.name,
            reference=reference,
            transaction_id=transaction_id,
            kind='refund',
        )
        res, response = method_sudo.hobex_start_sync_transaction(transaction_id)

        transaction = self.env['pos.payment.hobex.transaction'].sudo().search([
            ('tid', '=', method_sudo.hobex_terminal_id),
            ('transaction_id', '=', transaction_id),
        ], limit=1)

        if not res or res.get('responseCode') != "0":
            # hobex_start_sync_transaction never raises; it maps every failure
            # onto a responseCode. '-403' is the "not enabled for this account"
            # case, which deserves an actionable message.
            if res and res.get('hobex_forbidden'):
                raise UserError(_(
                    'The refund (Gutschrift) function is not enabled for this '
                    'hobex account. Please ask hobex to activate it.'
                ))
            raise UserError(_('hobex refund failed: %(code)s %(text)s') % {
                'code': (res or {}).get('responseCode') or '',
                'text': (res or {}).get('responseText') or _('no response from hobex'),
            })

        self.hobex_refund_transaction_id = transaction
        # Not method_sudo: _hobex_notify() sends to env.user, which under
        # sudo() would be the superuser instead of the cashier at the screen.
        return self.payment_method_id._hobex_notify(
            'success',
            _('hobex credit booked'),
            _('%(amount)s %(currency)s were credited on terminal %(tid)s.') % {
                'amount': amount,
                'currency': self.currency_id.name,
                'tid': method_sudo.hobex_terminal_id,
            },
        )

    def hobex_reversal(self):
        """Reverse (VOID) the original transaction on the hobex side.

        The counterpart is hobex_refund(): a reversal cancels *this*
        transaction and only works until hobex closes the batch, a refund is
        an independent credit that also works afterwards.
        """
        self.ensure_one()
        payment = self
        if not (payment.hobex_responseText == 'OK' and payment.hobex_transactionType == 'SELL'):
            raise UserError(_('Only successful transactions can be reversed!'))

        # hobex_auth_token is restricted to base.group_erp_manager; sudo so
        # account users that can refund pos.payment can still build the
        # outbound auth header (the credential never leaves the server).
        method_sudo = payment.payment_method_id.sudo()
        if not method_sudo.hobex_auth_token:
            method_sudo.hobex_get_auth_token()

        # Route the reversal through the payment method's existing helper.
        # That helper already calls `_update_transaction_with_hobex_result`,
        # which is the single place that flips the linked
        # pos.payment.hobex.transaction record's state to 'refunded' on a
        # successful VOID. The previous implementation talked to hobex
        # directly and updated only the pos.payment row, leaving the
        # transaction audit record stuck at state='ok' — which made the
        # "Transactions" list on the payment method form lie.
        res, response = method_sudo.hobex_reversal_transaction(payment.hobex_transactionId)

        if response is None:
            # hobex_reversal_transaction swallows requests exceptions and
            # returns (None, None). The real cause is in the server log.
            _logger.warning(
                "hobex reversal: no response from hobex for payment %s (tid=%s, transactionId=%s)",
                payment.id, payment.hobex_tid, payment.hobex_transactionId,
            )
            raise UserError(_(
                'There was a communication error with hobex. '
                'See the server log for details.'
            ))

        if response.status_code != 200:
            try:
                message = json.loads(response.text).get('message') or response.text
            except (ValueError, AttributeError):
                message = response.text
            raise UserError(_('hobex reversal failed: %s') % message)

        # Mirror the hobex response onto the pos.payment record so the
        # invoice / accounting view reflects the refund.
        if res:
            payment.hobex_responseText = res.get('responseText') or payment.hobex_responseText
            payment.hobex_responseCode = res.get('responseCode') or payment.hobex_responseCode
        payment.hobex_transactionType = 'REFUNDED'
