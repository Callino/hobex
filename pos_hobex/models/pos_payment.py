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
