# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo.http import Controller, request, route, SessionExpiredException, Response
from odoo import _
import requests
from urllib.parse import urljoin
import json
import logging

_logger = logging.getLogger(__name__)


class HobexController(Controller):
    @route('/hobex/api/transaction/payment', type="http", auth="public", cors='*', csrf=False, methods=['POST'])
    def payment(self):
        data = json.loads(request.httprequest.data.decode('utf-8'))
        payment_method = request.env['pos.payment.method'].sudo().browse(data['transaction']['pos_payment_mode_id'])
        if not payment_method:
            return Response(_('Payment Method is not available'), status=404)
        del data['transaction']['pos_payment_mode_id']
        h = {
            'Token': payment_method.hobex_auth_token,
            'Content-Type': 'application/json'
        }
        url = urljoin(payment_method.hobex_api_address, "/api/transaction/payment")
        # Search for existing transaction
        transaction = request.env['pos.payment.hobex.transaction'].sudo().search([
            ('tid', '=', data['transaction']['tid']),
            ('reference', '=', data['transaction']['reference']),
        ], limit=1)
        # do return the response we already got - but exclude aborted transactions - user may try again
        if transaction and transaction.response_code is not False and transaction.response_code not in ['8004']:
            headers = {
                'Content-Type': 'application/json',
            }
            return Response(transaction.response, status=200, headers=headers)
        transaction = request.env['pos.payment.hobex.transaction'].sudo().create({
            'pos_payment_method_id': payment_method.id,
            'reference': data['transaction']['reference'],
            'transaction_type': data['transaction']['transactionType'],
            'amount': data['transaction']['amount'],
            'currency': data['transaction']['currency'],
            'tid': data['transaction']['tid'],
            'url': url,
        })
        try:
            result = requests.post(
                url,
                data=json.dumps(data),
                timeout=30,
                headers=h,
            )
            res = json.loads(result.text)
            if res['responseCode'] == "0":
                transaction.update({
                    'response_code': res['responseCode'],
                    'response_text': res['responseText'],
                    'response': result.text,
                    'state': 'ok',
                })
            else:
                transaction.update({
                    'response_code': res['responseCode'],
                    'response_text': res['responseText'],
                    'response': result.text,
                    'state': 'failed',
                })
            return Response(result.text, status=result.status_code, headers=dict(result.headers))
        except Exception as e:
            transaction.update({
                'state': 'failed',
                'message': str(e),
            })
            _logger.info('hobex Exception: %s', str(e))
            headers = {
                'Content-Type': 'application/json',
            }
            return Response(json.dumps({
                'responseCode': '-1',
                'responseText': 'Timeout on transaction request',
            }), status=200, headers=headers)


    @route('/hobex/api/transaction/payment/<int:method_id>/<string:transactionId>', type="http", auth="public", cors='*', csrf=False, methods=['DELETE'])
    def payment_reversal(self, method_id, transactionId):
        payment_method = request.env['pos.payment.method'].sudo().browse(method_id)
        if not payment_method:
            return Response(_('Payment Method is not available'), status=404)
        h = {
            'Token': payment_method.hobex_auth_token,
        }
        url = urljoin(payment_method.hobex_api_address, "/api/transaction/payment/%s/%s" % (payment_method.hobex_terminal_id, transactionId, ))
        try:
            result = requests.delete(
                url,
                timeout=30,
                headers=h,
            )
            return Response(result.text, status=result.status_code, headers=dict(result.headers))
        except Exception as e:
            _logger.info('hobex Exception: %s', str(e))