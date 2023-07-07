# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from urllib.parse import urljoin
import requests
from requests.exceptions import ReadTimeout
from odoo.exceptions import UserError
import logging
import json

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

    def _export_for_ui(self, payment):
        data = super(PosPayment, self)._export_for_ui(payment)
        data.update({
            'hobex_receipt': payment.hobex_receipt,
            'hobex_approvalCode': payment.hobex_approvalCode,
            'hobex_actionCode': payment.hobex_actionCode,
            'hobex_aid': payment.hobex_aid,
            'hobex_reference': payment.hobex_reference,
            'hobex_tid': payment.hobex_tid,
            'hobex_transactionId': payment.hobex_transactionId,
            'hobex_transactionDate': payment.hobex_transactionDate,
            'hobex_cardNumber': payment.hobex_cardNumber,
            'hobex_cardExpiry': payment.hobex_cardExpiry,
            'hobex_brand': payment.hobex_brand,
            'hobex_cardIssuer': payment.hobex_cardIssuer,
            'hobex_transactionType': payment.hobex_transactionType,
            'hobex_responseCode': payment.hobex_responseCode,
            'hobex_responseText': payment.hobex_responseText,
            'hobex_cvm': payment.hobex_cvm,
        })
        return data

    def hobex_refund(self):
        self.ensure_one()
        payment = self
        if not (payment.hobex_responseText == 'OK' and payment.hobex_transactionType == 'SELL'):
            raise UserError('Only successfull transactions can get refunded !')
        if not payment.payment_method_id.hobex_auth_token:
            payment.payment_method_id.get_auth_token()
        headers = {
            'Token': payment.payment_method_id.hobex_auth_token,
        }
        try:
            result = requests.delete(urljoin(
                payment.payment_method_id.hobex_api_address,
                "/api/transaction/payment/%s/%s" % (payment.hobex_tid, payment.hobex_transactionId, )),
                timeout=30,
                headers=headers
            )
            if result.status_code != 200:
                res = json.loads(result.text)
                raise UserError(res['message'])
            else:
                res = json.loads(result.text)
                _logger.info("Got response: %s" % res['responseText'])
                payment.hobex_responseText = res['responseText']
                payment.hobex_responseCode = res['responseCode']
                payment.hobex_transactionType = 'REFUNDED'
            _logger.info("Got result from refund: %s", result)
        except ReadTimeout as re:
            raise UserError(_(u'Timeout after 30 seconds.'))
        except Exception as e:
            raise UserError(_(u'There was an error: %s') % (str(e),))

