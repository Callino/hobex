# -*- coding: utf-8 -*-
"""What happens when Hobex does not answer.

A missing answer is the dangerous case at the till: the payment may well have
been completed at the terminal, so the transaction must never be written off as
failed and the POS must never start a second one. These tests pin that down.

The methods under test open their own cursor via ``registry.cursor()`` and
commit in it, which is why every test that reaches them runs inside
``_registry_test_mode()``: new cursors then reuse the test transaction and
everything is rolled back afterwards.
"""
from contextlib import contextmanager
from unittest.mock import patch

import requests

from odoo.tests import TransactionCase, tagged

STATE_PATH = ('odoo.addons.pos_hobex.models.pos_payment_hobex_transaction'
              '.HobexTransaction.update_hobex_state')
SLEEP_PATH = 'odoo.addons.pos_hobex.models.pos_payment_hobex_transaction.time.sleep'


class FakeResponse:
    """Minimal stand-in for a requests.Response."""

    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text
        self.headers = {'Content-Type': 'application/json'}


@tagged('post_install', '-at_install')
class TestHobexNoAnswer(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.method = cls.env['pos.payment.method'].create({
            'name': 'hobex Test',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'hobex',
            'hobex_terminal_id': '3512285',
            'hobex_user': 'user',
            'hobex_pass': 'secret',
            'hobex_auth_token': 'token',
        })
        cls.transaction = cls.env['pos.payment.hobex.transaction'].create({
            'pos_payment_method_id': cls.method.id,
            'tid': '3512285',
            'transaction_id': 'TEST1',
            'reference': 'TEST1',
            'amount': 12.34,
            'currency': 'EUR',
            'url': 'http://127.0.0.1:1/api/transaction/payment',
            'state': 'pending',
        })

    @contextmanager
    def _registry_test_mode(self):
        """18.0 stand-in for 19.0's ``TransactionCase.enter_registry_test_mode``.

        That helper does not exist yet in 18.0; HttpCase drives the same
        registry calls by hand, and so do we. In test mode ``registry.cursor()``
        hands out the test cursor, so the explicit commits of the code under
        test stay inside the test transaction and are rolled back with it.
        """
        self.registry.enter_test_mode(self.cr)
        try:
            yield
        finally:
            self.registry.leave_test_mode()

    def _start_with(self, error):
        """Run a payment whose POST to Hobex fails with `error`."""
        with self._registry_test_mode():
            with patch.object(requests, 'post', side_effect=error):
                res, response = self.method.hobex_start_sync_transaction('TEST1')
        self.transaction.invalidate_recordset()
        return res, response

    # ------------------------------------------------------------------
    # No answer to the payment request
    # ------------------------------------------------------------------

    def test_timeout_keeps_the_transaction_pending(self):
        """A timeout leaves the outcome open - it is not a failed payment.

        Marking it 'failed' is what lets the POS reset the transaction and
        charge the customer a second time.
        """
        res, response = self._start_with(requests.exceptions.Timeout())

        self.assertEqual(res['responseCode'], '-1')
        self.assertEqual(self.transaction.state, 'pending')
        # Asserted on the number rather than the sentence: the message is
        # translated, and a test must not break when the database language does.
        # 80 = the request timeout used for the payment POST.
        self.assertIn('80', res['responseText'])
        self.assertEqual(self.transaction.message, res['responseText'])
        # No response object to hand back - the caller must not rely on one.
        self.assertIsNone(response)

    def test_connection_error_names_the_unreachable_server(self):
        """A connection error is reported readably, not as a raw exception."""
        res, _response = self._start_with(requests.exceptions.ConnectionError('no route'))

        self.assertEqual(res['responseCode'], '-1')
        # The cause travels with the message, whatever language it is in.
        self.assertIn('no route', res['responseText'])
        self.assertNotEqual(res['responseText'], 'no route')
        self.assertEqual(self.transaction.state, 'pending')

    def test_an_unexpected_error_still_leaves_the_transaction_open(self):
        """Anything else is unknown territory too - the state stays pending."""
        res, _response = self._start_with(ValueError('something odd'))

        self.assertEqual(res['responseCode'], '-1')
        self.assertEqual(res['responseText'], 'something odd')
        self.assertEqual(self.transaction.state, 'pending')

    # ------------------------------------------------------------------
    # Asking for the state afterwards
    # ------------------------------------------------------------------

    def test_status_request_flags_an_unknown_transaction(self):
        """`not_found` tells the POS it may start a new transaction."""
        result = self.method.proxy_hobex_status_request('DOES-NOT-EXIST')

        self.assertTrue(result['error'])
        self.assertEqual(result['code'], 'not_found')

    def test_status_request_flags_a_missing_answer(self):
        """`no_answer` tells the POS to keep the transaction and ask again.

        Without the distinction from `not_found`, an unreachable Hobex would
        look like a transaction that never existed - and the POS would start a
        new one over an open payment.
        """
        with patch(STATE_PATH, side_effect=requests.exceptions.ConnectionError('boom')):
            result = self.method.proxy_hobex_status_request('TEST1')

        self.assertTrue(result['error'])
        self.assertEqual(result['code'], 'no_answer')

    def test_status_request_passes_a_result_through(self):
        """The good case still answers with error = False and the payload."""
        with patch(STATE_PATH, return_value=({'state': 'OK'}, None)):
            result = self.method.proxy_hobex_status_request('TEST1')

        self.assertFalse(result['error'])
        self.assertEqual(result['res'], {'state': 'OK'})

    def test_status_poll_waits_for_a_lowercase_inprogress(self):
        """The server keeps polling while the terminal is busy - in any case.

        The spec writes the state lowercase, the examples uppercase. If the
        wait loop only knew 'INPROGRESS', a lowercase answer would go straight
        back to the POS and the cashier would have to press "Send" again for
        every poll.
        """
        answers = [
            FakeResponse(200, '{"responseCode": "0", "state": "inprogress"}'),
            FakeResponse(200, '{"responseCode": "0", "state": "OK"}'),
        ]

        with self._registry_test_mode():
            with patch.object(requests, 'get', side_effect=answers) as get, \
                    patch(SLEEP_PATH) as sleep:
                res, _response = self.transaction.update_hobex_state(sync=True)

        self.transaction.invalidate_recordset()
        self.assertEqual(get.call_count, 2)
        sleep.assert_called_once()
        self.assertEqual(res['state'], 'OK')
        self.assertEqual(self.transaction.state, 'ok')

    # ------------------------------------------------------------------
    # Signature receipt
    # ------------------------------------------------------------------

    def test_a_failing_receipt_download_does_not_fail_the_payment(self):
        """A signature receipt that cannot be fetched is a printing problem.

        The payment itself was accepted, so it has to end up as 'ok' - not as
        an exception on the way back to the till.
        """
        response = FakeResponse(200, '{"responseCode": "0", "state": "OK", "cvm": 1}')

        with self._registry_test_mode():
            with patch.object(requests, 'get', side_effect=requests.exceptions.Timeout()):
                res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                    tid='3512285', transaction_id='TEST1', response=response,
                )

        self.transaction.invalidate_recordset()
        self.assertEqual(res['responseCode'], '0')
        self.assertNotIn('cvm_receipt', res)
        self.assertEqual(self.transaction.state, 'ok')

    def test_a_successful_receipt_download_is_handed_on(self):
        """The normal case: the receipt travels with the result to the POS."""
        response = FakeResponse(200, '{"responseCode": "0", "state": "OK", "cvm": 1}')

        with self._registry_test_mode():
            with patch.object(requests, 'get', return_value=FakeResponse(200, 'RECEIPT')):
                res = self.env['pos.payment.hobex.transaction']._update_transaction_with_hobex_result(
                    tid='3512285', transaction_id='TEST1', response=response,
                )

        self.transaction.invalidate_recordset()
        self.assertEqual(res['cvm_receipt'], 'RECEIPT')
        self.assertEqual(self.transaction.state, 'ok')
