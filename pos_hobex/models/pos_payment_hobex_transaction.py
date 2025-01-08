from odoo import api, fields, models


class HobexTransaction(models.Model):
    _name = 'pos.payment.hobex.transaction'
    _rec_name = 'reference'
    _description = 'Hobex Transaction'
    _order = 'transaction_date desc'

    reference = fields.Char(required=True)
    transaction_date = fields.Datetime(default=lambda self: fields.Datetime.now())
    pos_payment_method_id = fields.Many2one('pos.payment.method', string="Payment method", required=True)
    transaction_type = fields.Integer()
    amount = fields.Float()
    currency = fields.Char()
    tid = fields.Char('TID')
    url = fields.Char('URL')
    message = fields.Char()
    response_code = fields.Char()
    response_text = fields.Char()
    response = fields.Text()
    state = fields.Selection([
        ('pending', 'Pending'),
        ('ok', 'Ok'),
        ('failed', 'Failed'),
        ('abort', 'Aborted'),
        ('refunded', 'Refunded'),
    ], default='pending')

    _sql_constraints = [
        ('reference_tid_uniq', 'unique(reference, tid)', 'Reference must be unique per TID!'),
    ]