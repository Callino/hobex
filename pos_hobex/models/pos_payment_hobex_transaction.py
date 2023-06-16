from odoo import api, fields, models


class HobexTransaction(models.Model):
    _name = 'pos.payment.hobex.transaction'
    _rec_name = 'reference'
    _description = 'Hobex Transaction'
    _order = 'transaction_date desc'

    reference = fields.Char('Reference', required=True)
    transaction_date = fields.Datetime('Transaction Date', default=lambda self: fields.Datetime.now())
    pos_payment_method_id = fields.Many2one('pos.payment.method', string="Payment method", required=True)
    transaction_type = fields.Integer('Transaction Type')
    amount = fields.Float('Amount')
    currency = fields.Char('Currency')
    tid = fields.Char('TID')
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
        ('reference_tid_uniq', 'unique(reference, tid)', 'Reference must be unique per TID!'),
    ]