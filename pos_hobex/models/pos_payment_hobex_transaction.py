from odoo import api, fields, models
import requests
from urllib.parse import urljoin
import json
from odoo.exceptions import UserError
import time
import logging

_logger = logging.getLogger(__name__)


class HobexTransaction(models.Model):
    _name = 'pos.payment.hobex.transaction'
    _rec_name = 'reference'
    _description = 'Hobex Transaction'
    _order = 'transaction_date desc'

    reference = fields.Char('Reference', required=True)
    transaction_id = fields.Char('Transaction ID', required=True)
    transaction_date = fields.Datetime('Transaction Date', default=lambda self: fields.Datetime.now())
    pos_payment_method_id = fields.Many2one('pos.payment.method', string="Payment method", required=True)
    transaction_type = fields.Integer('Transaction Type', default=1)
    # Which Hobex endpoint this record was sent to. 'refund' is a standalone
    # credit (Gutschrift) with no link to an earlier transaction, as opposed to
    # the reversal (VOID) that cancels one — see hobex_reversal_transaction().
    kind = fields.Selection([
        ('payment', 'Payment'),
        ('refund', 'Refund'),
    ], default='payment', required=True, string="Kind")
    amount = fields.Float('Amount')
    currency = fields.Char('Currency', default='EUR')
    tid = fields.Char('TID', help="Terminal ID", required=True)
    url = fields.Char('URL')
    message = fields.Char('Message')
    response_code = fields.Char('Response Code')
    response_text = fields.Char('Response Text')
    response = fields.Text('Response')
    state = fields.Selection([
        ('pending', 'Pending'),
        ('ok', 'Ok'),
        ('failed', 'Failed'),
        ('abort', 'Aborted'),
        ('refunded', 'Refunded'),
    ], default='pending', string="State")

    _sql_constraints = [
        ('transactionid_tid_uniq', 'unique(transaction_id, tid)',
         'TransactionID must be unique per TID!'),
    ]

    @staticmethod
    def _hobex_error_message(response):
        """Pull the human readable `message` out of a Hobex error body."""
        try:
            return json.loads(response.text).get('message') or response.text
        except (ValueError, AttributeError):
            return response.text

    @api.model
    def _update_transaction_with_hobex_result(self, tid, transaction_id, response):
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            transaction = env['pos.payment.hobex.transaction'].sudo().search([
                ('tid', '=', tid),
                ('transaction_id', '=', transaction_id),
            ], limit=1)

            if response.status_code == 400:
                # 400 = Bad Request. Reachable for refunds, where Hobex
                # validates tid -> currency -> amount and answers e.g.
                # {"message": "Invalid Amount."}. Surface just the message.
                raise UserError(self._hobex_error_message(response))
            elif response.status_code == 403:
                # 403 = the account is not cleared for this operation. The
                # refund (Gutschrift) function in particular has to be enabled
                # by Hobex per account (profile flag `canRefund`). Return a
                # structured result instead of raising so the POS can show a
                # message the cashier can act on.
                message = self._hobex_error_message(response)
                _logger.info(
                    "Hobex refused transaction %s/%s with 403: %s",
                    tid, transaction_id, message,
                )
                transaction.update({
                    'state': 'failed',
                    'message': message,
                    'response': response.text,
                })
                env.cr.commit()
                return {
                    'responseCode': '-403',
                    'responseText': message,
                    'hobex_forbidden': True,
                }
            elif response.status_code == 404 and transaction.state == 'pending':
                # 404 = Transaction is not found on Hobex side - but our state is pending - so it is failed
                transaction.state = 'failed'
                return
            elif response.status_code == 404:
                # 404 = Transaction is not found on Hobex side
                transaction.state = 'failed'
                return
            elif response.status_code == 200:
                res = json.loads(response.text)
                # .get(): the signature receipt is a property of the card
                # verification method, and not every Hobex response carries a
                # `cvm` key. A missing key must not blow up the whole call —
                # it just means there is no receipt to fetch.
                # cvm is a number on the transaction endpoints (1 = signature)
                # and a string on Transaction Status V2 ("SIGNATURE"), so both
                # spellings have to count - otherwise the signature receipt is
                # silently skipped whenever the result arrives over the status
                # poll instead of the original request.
                if res.get('responseCode') == "0" and res.get('cvm') in (1, 'SIGNATURE'):
                    # We do fetch the receipt from Hobex - and include it in the response
                    receipt_url = urljoin(transaction.pos_payment_method_id.hobex_api_address, "/api/transaction/download")
                    # The payment itself is already done at this point. A
                    # hiccup while fetching the signature slip must not escape:
                    # the caller would turn a successful payment into 'failed' +
                    # responseCode -1 and skip the transaction.update() below,
                    # losing the result of a card charge that actually went
                    # through. Missing paper beats a lost payment.
                    try:
                        receipt_result = requests.get(
                            receipt_url,
                            params={
                                'tid': tid,
                                'transactionId': transaction_id,
                                'width': 32,
                                'type': 'txt',
                                'raw': True,
                            },
                            timeout=10,
                            headers=transaction.pos_payment_method_id._get_hobex_headers(),
                        )
                        res['cvm_receipt'] = receipt_result.text
                    except Exception as e:
                        _logger.warning(
                            "Hobex transaction %s/%s: could not download the signature receipt (%s)",
                            tid, transaction_id, str(e),
                        )
                # ============================================================
                # TODO TEMP TEST — REMOVE BEFORE PRODUCTION
                # Force cvm == 1 + a fake merchant receipt so we can exercise
                # print_hobex_receipt() in the POS without a real
                # signature-required card. Only kicks in on a successful
                # response so other code paths stay untouched.
                # ============================================================
                '''
                if res.get('responseCode') == "0":
                    res['cvm'] = 1
                    res['cvm_receipt'] = (
                        "          HOBEX TEST            \r\n"
                        "--------------------------------\r\n"
                        "TID         : %s\r\n"
                        "Transaktion : %s\r\n"
                        "Karte       : VISA ****1234\r\n"
                        "Betrag      : EUR 0.01\r\n"
                        "--------------------------------\r\n"
                        "Bitte unterschreiben:\r\n"
                        "\r\n"
                        "\r\n"
                        "________________________________\r\n"
                    ) % (tid, transaction_id)
                '''
                # ============================================================
                # END TEMP TEST
                # ============================================================

                response_code = res.get('responseCode')
                if response_code is None:
                    # Transaction Status V2 answers with responseCode = null
                    # while the transaction is still running on the terminal
                    # (spec 1.13, "Transaction Status V2"). Marking that as
                    # failed would tell the cashier the payment died while the
                    # customer is still holding the card - and invite a second
                    # charge. Leave it pending; the caller polls again.
                    transaction.update({
                        'response': response.text,
                        'state': 'pending',
                    })
                elif response_code == "0":
                    # responseCode == "0" means the Hobex API accepted the
                    # request. Status V2 states the outcome in its own `state`
                    # field, the transaction endpoints only in responseText.
                    # Unknown values are treated as 'ok' (success with extra
                    # info) rather than crashing — the raw response is kept in
                    # `response` for forensics.
                    response_text = res.get('responseText')
                    raw_state = (res.get('state') or response_text or '').upper()
                    state_map = {
                        'OK': 'ok',
                        'VOID': 'refunded',
                        'INPROGRESS': 'pending',
                    }
                    state = state_map.get(raw_state, 'ok')
                    if raw_state not in state_map:
                        _logger.warning(
                            "Unknown Hobex state %r on transaction %s/%s; "
                            "treating as 'ok'. Full response: %s",
                            raw_state, tid, transaction_id, response.text,
                        )
                    transaction.update({
                        'response_code': response_code,
                        'response_text': response_text or res.get('statusText'),
                        'response': response.text,
                        'state': state,
                    })
                else:
                    transaction.update({
                        'response_code': response_code,
                        'response_text': res.get('responseText') or res.get('statusText'),
                        'response': response.text,
                        'state': 'failed',
                    })
                env.cr.commit()
                return res
            else:
                # Other Codes = No other codes are defined in the API
                raise UserError(response.text)

    def update_hobex_state(self, sync=False):
        '''
        Do get the current state of this transaction from Hobex side
        '''
        h = self.pos_payment_method_id._get_hobex_headers()
        url = urljoin(self.pos_payment_method_id.hobex_api_address, "/api/v2/transactions/%(terminalid)s/%(transactionid)s" % {
            "terminalid": self.tid,
            "transactionid": self.transaction_id,
        })
        retry_count = 1 if not sync else 12
        retry = 0
        while retry < retry_count:
            retry += 1
            response = requests.get(
                url,
                timeout=30,
                headers=h,
            )
            # api.model call - will create own env for this
            res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                tid=self.tid,
                transaction_id=self.transaction_id,
                response=response
            )
            if sync and res and res.get('state') == 'INPROGRESS':
                time.sleep(5)
            else:
                break
        return res, response

    def reversal_hobex_transaction(self):
        self.pos_payment_method_id.hobex_reversal_transaction(self.transaction_id)
        return True