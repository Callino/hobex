# -*- coding: utf-8 -*-
from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged

PROFILE_PATH = 'odoo.addons.pos_hobex.models.pos_payment_method.PosPaymentMethod.hobex_get_profile'


@tagged('post_install', '-at_install')
class TestHobexRefundPermission(TransactionCase):
    """The refund permission is checked on /api/account/profile before a
    credit is booked. hobex enables the function per account, so the refusal
    path cannot be produced at the terminal - it is stubbed here instead.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.method = cls.env['pos.payment.method'].create({
            'name': 'hobex Test',
            'type': 'bank',
            'payment_method_type': 'terminal',
            'payment_provider': 'hobex',
            'hobex_terminal_id': '3512285',
            'hobex_user': 'user',
            'hobex_pass': 'secret',
            'hobex_auth_token': 'token',
        })

    def test_refund_refused_when_account_may_not_refund(self):
        """canRefund = false stops the credit before it reaches the terminal."""
        with patch(PROFILE_PATH, return_value={'canRefund': False, 'canVoid': True}):
            self.assertFalse(self.method._hobex_refund_allowed())
            result = self.method.proxy_hobex_refund_request({
                'amount': -1.0,
                'currency': 'EUR',
                'reference': 'TEST',
                'transactionId': '1',
            })
        self.assertEqual(result['responseCode'], '-403')
        self.assertTrue(result['hobex_forbidden'])
        # No transaction may have been created: nothing was sent to hobex.
        self.assertFalse(self.env['pos.payment.hobex.transaction'].search([
            ('pos_payment_method_id', '=', self.method.id),
        ]))
        # The flag hobex reported is mirrored onto the form.
        self.assertFalse(self.method.hobex_can_refund)

    def test_flag_is_refreshed_when_permission_is_granted(self):
        """canRefund = true lets the credit through and updates the form."""
        self.method.hobex_can_refund = False
        with patch(PROFILE_PATH, return_value={'canRefund': True, 'canVoid': True}):
            self.assertTrue(self.method._hobex_refund_allowed())
        self.assertTrue(self.method.hobex_can_refund)

    def test_profile_failure_does_not_block_the_refund(self):
        """A broken profile call must not refuse a legitimate credit.

        The refund POST answers 403 by itself when the function is disabled,
        so a network hiccup during the pre-flight is not a reason to send the
        customer away.
        """
        with patch(PROFILE_PATH, side_effect=Exception('boom')):
            self.assertTrue(self.method._hobex_refund_allowed())

    def test_backend_button_refuses_with_a_readable_error(self):
        """The Refund (Credit) button on pos.payment raises instead of posting."""
        payment = self.env['pos.payment'].new({
            'payment_method_id': self.method.id,
            'amount': 1.0,
        })
        # Pinned to en_US: the message is translated, and the database this
        # runs in may well have a German user language.
        with patch(PROFILE_PATH, return_value={'canRefund': False}):
            with self.assertRaisesRegex(UserError, 'not enabled'):
                payment.with_context(lang='en_US').hobex_refund()
