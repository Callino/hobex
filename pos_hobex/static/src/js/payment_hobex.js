odoo.define('pos_hobex.payment', function (require) {
"use strict";

const { Gui } = require('point_of_sale.Gui');
var core = require('web.core');
var PaymentInterface = require('point_of_sale.PaymentInterface');

var _t = core._t;


var PaymentHobex = PaymentInterface.extend({

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);
        this.enable_reversals();
    },

    /**
     * Call this function to enable UI elements that allow a user to
     * reverse a payment. This requires that you implement
     * send_payment_reversal.
     */
    enable_reversals: function () {
        this.supports_reversals = true;
    },

    /**
     * Called when a user clicks the "Send" button in the
     * interface. This should initiate a payment request and return a
     * Promise that resolves when the final status of the payment line
     * is set with set_payment_status.
     *
     * For successful transactions set_receipt_info() should be used
     * to set info that should to be printed on the receipt. You
     * should also set card_type and transaction_id on the line for
     * successful transactions.
     *
     * @param {string} cid - The id of the paymentline
     * @returns {Promise} resolved with a boolean that is false when
     * the payment should be retried. Rejected when the status of the
     * paymentline will be manually updated.
     */
    send_payment_request: function (cid) {
        var order = this.pos.get_order();
        var line = order.paymentlines._byId[cid];
        var data = {
            'transactionType': 1,
            'amount': Math.round(this.pos.get_order().selected_paymentline.amount / this.pos.currency.rounding) * this.pos.currency.rounding,
            'currency': this.pos.currency.name,
            'tid': line.payment_method.hobex_terminal_id,
            'reference': line.sequence_number,
        };
        return new Promise((resolve) => {
            this.transactionResolve = resolve;
            $.ajax({
                url: this.payment_method.hobex_api_address + "/api/transaction/payment",
                type: 'post',
                data: JSON.stringify({transaction: data}),
                contentType: "application/json",
                timeout: 120000,
                headers: {
                    'Token': this.payment_method.hobex_auth_token,
                }
            }).then(
                function done(result) {
                    if (result.responseCode === "0") {
                        for (const [key, value] of Object.entries(result)) {
                          line['hobex_'+key] = value;
                        }
                        if (result.cvm === 1) {
                            this.print_receipt(line);
                        }
                        resolve(true);
                    } else {
                        order.trigger('hobex_error', {
                            'title': _t('Hobex Fehler'),
                            'body': result['responseCode'] + ': ' + result['responseText'],
                        });
                        resolve(false);
                    }
                },
                function failed() {
                    order.trigger('hobex_error', {
                        'title': _t('Hobex Fehler'),
                        'body': _t('Kommunikation mit dem Hobex Server ist fehlgeschlagen'),
                    });
                    resolve(false);
                }
            );
        });
    },

    /**
     * Called when a user removes a payment line that's still waiting
     * on send_payment_request to complete. Should execute some
     * request to ensure the current payment request is
     * cancelled. This is not to refund payments, only to cancel
     * them. The payment line being cancelled will be deleted
     * automatically after the returned promise resolves.
     *
     * @param {} order - The order of the paymentline
     * @param {string} cid - The id of the paymentline
     * @returns {Promise}
     */
    send_payment_cancel: function (order, cid) {
        return new Promise((resolve) => {
            // Hobex does not support to cancel running payment requests
            order.trigger('hobex_error', {
                'title': _t('ACHTUNG'),
                'body': _t('Zahlung bitte am Terminal abbrechen !'),
            });
            resolve(false);
        });
    },

    /**
     * This is an optional method. When implementing this make sure to
     * call enable_reversals() in the constructor of your
     * interface. This should reverse a previous payment with status
     * 'done'. The paymentline will be removed based on returned
     * Promise.
     *
     * @param {string} cid - The id of the paymentline
     * @returns {Promise} returns true if the reversal was successful.
     */
    send_payment_reversal: function (cid) {
        var order = this.pos.get_order();
        var line = order.paymentlines._byId[cid];
        return new Promise((resolve) => {
            $.ajax({
                url: this.payment_method.hobex_api_address + "/api/transaction/payment/" + line.payment_method.hobex_terminal_id + "/" + line.hobex_transactionId,
                type: 'delete',
                timeout: 120000,
                headers: {
                    'Token': this.payment_method.hobex_auth_token,
                }
            }).then(
                function done(result) {
                    resolve(true);
                },
                function failure() {
                    order.trigger('hobex_error', {
                        'title': _t('Hobex Fehler'),
                        'body': _t('Kommunikation mit dem Hobex Server ist fehlgeschlagen'),
                    });
                    resolve(false);
                }
            );
        });
    },

    /**
     * Called when the payment screen in the POS is closed (by
     * e.g. clicking the "Back" button). Could be used to cancel in
     * progress payments.
     */
    close: function () {},
});

return PaymentHobex;

});
