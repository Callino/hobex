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
        try:
            result = requests.post(
                url,
                data=json.dumps(data),
                timeout=30,
                headers=h,
            )
            return Response(result.text, status=result.status_code, headers=dict(result.headers))
        except Exception as e:
            _logger.info('hobex Exception: %s', str(e))

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