# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo.http import Controller, request, route, SessionExpiredException, Response
from odoo import _, api, fields
import json


class HobexController(Controller):

    def _get_payment_method(self, method_id):
        payment_method = request.env['pos.payment.method'].sudo().browse(method_id)
        if not payment_method:
            return Response(_('Payment Method is not available'), status=404)
        return payment_method

    @route('/hobex/api/transaction/payment', type="http", auth="public", cors='*', csrf=False, methods=['POST'])
    def payment(self):
        data = json.loads(request.httprequest.data.decode('utf-8'))
        # Get and check Payment method
        payment_method = self._get_payment_method(data['transaction']['pos_payment_mode_id'])
        del data['transaction']['pos_payment_mode_id']
        # Create String from transactionid
        data['transaction']['transactionId'] = str(data['transaction']['transactionId'])
        # Remove - from reference
        data['transaction']['reference'] = data['transaction']['reference'].replace('-', '')
        # We do create the new transaction in a new environment with a new cursor with an explicit commit
        payment_method.hobex_new_transaction(
            amount=data['transaction']['amount'],
            currency=data['transaction']['currency'],
            reference=data['transaction']['reference'],
            transaction_id=data['transaction']['transactionId'],
        )
        (res, response) = payment_method.hobex_start_sync_transaction(data['transaction']['transactionId'])
        '''
        This is for testing the Hobex cvm=1 Code - because i do not have any card here which will produce cvm=1 results 
        res['cvm'] = 1
        res['cvm_receipt'] = 'TEST123123'
        '''
        if response is None:
            # No usable answer from hobex (timeout, connection error, ...) - res is our own
            # result with responseCode -1. The POS will then ask for the transaction state.
            return Response(json.dumps(res), status=200, headers={'Content-Type': 'application/json'})
        return Response(json.dumps(res), status=response.status_code, headers=dict(response.headers))

    @route('/hobex/api/transaction/payment/<int:method_id>/<string:transactionId>', type="http", auth="public", cors='*', csrf=False, methods=['DELETE'])
    def payment_reversal(self, method_id, transactionId):
        payment_method = self._get_payment_method(method_id)
        res, response = payment_method.hobex_reversal_transaction(transactionId)
        if response is None:
            # No usable answer from hobex (timeout, connection error) - reversal state unknown
            return Response(json.dumps({
                'message': _('No answer from hobex - the state of the reversal is unknown. Please check the transaction in the hobex portal.'),
            }), status=502, headers={'Content-Type': 'application/json'})
        if res:
            return Response(json.dumps(res), status=response.status_code, headers=dict(response.headers))
        else:
            return Response(_('Transaction not found on hobex side'), status=404)

    @route('/hobex/api/v2/transactions/<int:method_id>/<string:transactionId>', type="http", auth="public", cors='*', csrf=False, methods=['GET'])
    def payment_state(self, method_id, transactionId):
        payment_method = self._get_payment_method(method_id)
        transaction = request.env['pos.payment.hobex.transaction'].sudo().search([
            ('tid', '=', payment_method.hobex_terminal_id),
            ('transaction_id', '=', transactionId),
        ], limit=1)
        if not transaction:
            return Response(_('Transaction not found !'), status=404)

        res, response = transaction.update_hobex_state(sync=True)
        if res:
            return Response(json.dumps(res), status=response.status_code, headers=dict(response.headers))
        else:
            return Response(_('Transaction not found on hobex side'), status=404)
