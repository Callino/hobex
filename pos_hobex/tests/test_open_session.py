# -*- coding: utf-8 -*-
from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged

PROFILE_PATH = 'odoo.addons.pos_hobex.models.pos_payment_method.PosPaymentMethod.hobex_get_profile'


@tagged('post_install', '-at_install')
class TestHobexOpenSession(TransactionCase):
    """Core forbids writes on a payment method while a POS session uses it.
    The fields pos_hobex maintains itself must stay writable, otherwise the
    daily token renewal fails for tills that are not closed overnight.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        journal = cls.env['account.journal'].create({
            'name': 'hobex Test Bank',
            'type': 'bank',
            'code': 'HOBXT',
        })
        Method = cls.env['pos.payment.method']
        vals = {
            'name': 'hobex Test',
            'journal_id': journal.id,
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'hobex',
            'hobex_terminal_id': '3512285',
            'hobex_user': 'user',
            'hobex_pass': 'secret',
            'hobex_auth_token': 'token',
        }
        cls.method = Method.create({k: v for k, v in vals.items() if k in Method._fields})
        cls.config = cls.env['pos.config'].create({
            'name': 'hobex Test Shop',
            'payment_method_ids': [(6, 0, cls.method.ids)],
        })
        cls.env['pos.session'].create({'config_id': cls.config.id})
        cls.method.invalidate_recordset(['open_session_ids'])

    def test_session_is_open(self):
        self.assertTrue(self.method.open_session_ids)

    def test_token_can_be_renewed(self):
        self.method.hobex_auth_token = 'new-token'
        self.assertEqual(self.method.hobex_auth_token, 'new-token')

    def test_refund_flag_can_be_refreshed(self):
        self.method.hobex_can_refund = False
        with patch(PROFILE_PATH, return_value={'canRefund': True, 'canVoid': True}):
            self.assertTrue(self.method._hobex_refund_allowed())
        self.assertTrue(self.method.hobex_can_refund)

    def test_configuration_stays_locked(self):
        with self.assertRaises(UserError):
            self.method.hobex_terminal_id = '9999999'
