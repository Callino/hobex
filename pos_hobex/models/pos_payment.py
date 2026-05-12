# -*- coding: utf-8 -*-

from odoo import models, fields, _
from odoo.exceptions import UserError
import json
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

    # Note: pos.payment's default `_load_pos_data_fields` returns `[]`, which
    # is interpreted as "load all fields" by both `_load_pos_data_read`
    # (Odoo's `read([])` reads every field) and `_load_pos_data_relations`
    # (its filter only kicks in when the list is non-empty). Overriding it
    # to return our hobex_* fields would *restrict* the loaded fields and
    # drop pos_order_id et al. The hobex_* fields are stored on the model,
    # so the default "all fields" behaviour already includes them.

    def hobex_refund(self):
        self.ensure_one()
        payment = self
        if not (payment.hobex_responseText == 'OK' and payment.hobex_transactionType == 'SELL'):
            raise UserError(_('Only successful transactions can be refunded!'))

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
                "hobex refund: no response from hobex for payment %s (tid=%s, transactionId=%s)",
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
            raise UserError(_('hobex refund failed: %s') % message)

        # Mirror the hobex response onto the pos.payment record so the
        # invoice / accounting view reflects the refund.
        if res:
            payment.hobex_responseText = res.get('responseText') or payment.hobex_responseText
            payment.hobex_responseCode = res.get('responseCode') or payment.hobex_responseCode
        payment.hobex_transactionType = 'REFUNDED'
