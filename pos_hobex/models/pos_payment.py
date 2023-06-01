# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class PosPayment(models.Model):
    _inherit = 'pos.payment'

    hobex_receipt = fields.Char('Hobex Receipt Number')
    hobex_approvalCode = fields.Char('Hobex Approval Code')
    hobex_actionCode = fields.Char('Hobex Crypto Code')
    hobex_aid = fields.Char('Hobex Aid')
    hobex_reference = fields.Char('Hobex Ref Number')
    hobex_tid = fields.Char('Hobex TID')
    hobex_transactionId = fields.Char('Hobex Transaction ID')
    hobex_transactionDate = fields.Char('Hobex Transaction Date')
    hobex_cardNumber = fields.Char('Hobex Card Number')
    hobex_cardExpiry = fields.Char('Hobex Card Expiry')
    hobex_brand = fields.Char('Hobex Card Brand')
    hobex_cardIssuer = fields.Char('Hobex Card Issuer')
    hobex_transactionType = fields.Char('Hobex Transaction Type')
    hobex_responseCode = fields.Char('Hobex Response Code')
    hobex_responseText = fields.Char('Hobex Response Text')
    hobex_cvm = fields.Char('Hobex CVM')

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
