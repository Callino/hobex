from odoo import api, fields, models
import requests
from urllib.parse import urljoin
import json
from odoo.exceptions import UserError
import time


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
        ('transactionid_tid_uniq', 'unique(transaction_id, tid)', 'TransactionID must be unique per TID!'),
    ]

    @api.model
    def _update_transaction_with_hobex_result(self, tid, transaction_id, response):
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.user.id, self.env.context)
            transaction = env['pos.payment.hobex.transaction'].sudo().search([
                ('tid', '=', tid),
                ('transaction_id', '=', transaction_id),
            ], limit=1)

            if response.status_code == 400:
                # 400 = Bad Request - Should not happen any time
                raise UserError(response.text)
            elif response.status_code == 404 and transaction.state == 'pending':
                # 404 = Transaction is not found on hobex side - but our state is pending - so it is failed
                transaction.state = 'failed'
                return
            elif response.status_code == 404:
                # 404 = Transaction is not found on hobex side
                transaction.state = 'failed'
                return
            elif response.status_code == 200:
                res = json.loads(response.text)
                if res['responseCode'] == "0" and res['cvm'] == 1:
                    # We do fetch the receipt from hobex - and include it in the response
                    receipt_url = urljoin(transaction.pos_payment_method_id.hobex_api_address, "/api/transaction/download")
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
                if res['responseCode'] == "0":
                    if res['responseText'] == 'OK':
                        state = 'ok'
                    elif res['responseText'] == 'VOID':
                        state = 'refunded'
                    elif res['responseText'] == 'INPROGRESS':
                        state = 'pending'
                    transaction.update({
                        'response_code': res['responseCode'],
                        'response_text': res['responseText'],
                        'response': response.text,
                        'state': state,
                    })
                else:
                    transaction.update({
                        'response_code': res['responseCode'],
                        'response_text': res['responseText'],
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
        Do get the current state of this transaction from hobex side
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
            if sync and res and res['state'] == 'INPROGRESS':
                time.sleep(5)
            else:
                break
        return res, response

    def reversal_hobex_transaction(self):
        self.pos_payment_method_id.hobex_reversal_transaction(self.transaction_id)