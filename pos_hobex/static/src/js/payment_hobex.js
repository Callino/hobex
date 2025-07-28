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
     * Updates the payment line values by appending data from the result object,
     * and optionally prints a receipt if specific conditions are met.
     *
     * @param {Object} line - The payment line object that will be updated with new values.
     * @param {Object} result - The object containing key-value pairs to update the payment line with.
     * @return {void} This method does not return a value.
     */
    update_payment_line_values_from_hobex(line, result) {
        line.hobex_receipt = result.receipt;
        line.hobex_approvalCode = result.approvalCode;
        line.hobex_actionCode = result.actionCode;
        line.hobex_aid = result.aid;
        line.hobex_reference = result.reference;
        line.hobex_tid = result.tid;
        line.hobex_transactionId = result.transactionId;
        line.hobex_transactionDate = result.transactionDate;
        line.hobex_cardNumber = result.cardNumber;
        line.hobex_cardExpiry = result.cardExpiry;
        line.hobex_brand = result.brand;
        line.hobex_cardIssuer = result.cardIssuer;
        line.hobex_transactionType = result.transactionType;
        line.hobex_responseCode = result.responseCode;
        line.hobex_responseText = result.responseText;
        line.hobex_cvm = result.cvm;
        if (result.cvm === 1 && this.pos.env.proxy.printer && result.cvm_receipt) {
            this.print_hobex_receipt(result.cvm_receipt);
        }
    },

    print_hobex_receipt(receipt) {
        this.pos.env.proxy.printer.print_receipt(
            "<div class='pos-receipt'><div class='pos-payment-terminal-receipt'>" +
            receipt.replace(/\r\n/g, "<br/>") +
            "</div></div>"
        );
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
        this._super.apply(this, arguments);
        var order = this.pos.get_order();
        var self = this;
        var line = order.selected_paymentline;
        if (line.amount < 0) {
            return new Promise((resolve) => {
                self.pos.env.posbus.trigger('hobex_error', {
                    'title': _t('Negative Beträge nicht möglich.'),
                    'body': _t('Es ist nicht möglich einen negativen Betrag zurückzubuchen.'),
                });
                line.set_payment_status("force_done");
                resolve(false);
            });
        }
        return new Promise((resolve) => {
            function hobex_done(result) {
                // Do always set the response Code
                line['hobex_responseCode'] = result.responseCode;
                console.log('did set hobex response code ' + result.responseCode);
                // And reset the payment status
                if (result.responseCode === "0") {
                    line.set_payment_status('done');
                    self.update_payment_line_values_from_hobex(line, result);
                    resolve(true);
                } else {
                    line.set_payment_status('retry');
                    if (result['responseCode'] === '8004') {
                        self.pos.env.bus.trigger('hobex_error', {
                            'title': _t('hobex'),
                            'body': _t('Die Transaktion wurde am Terminal abgebrochen'),
                        });
                    } else {
                        self.pos.env.bus.trigger('hobex_error', {
                            'title': _t('hobex Antwort'),
                            'body': result['responseCode'] + ': ' + result['responseText'],
                        });
                    }
                    resolve(false);
                }
            }
            function hobex_status_done(result) {
                // Do always set the response Code
                if (result.state === "INPROGRESS") {
                    line.set_payment_status('waitingCard');
                    resolve(false);
                } else {
                    line['hobex_responseCode'] = result.responseCode;
                    console.log('did set hobex response code ' + result.responseCode);
                    if (result.responseCode === "0") {
                        self.update_payment_line_values_from_hobex(line, result);
                        // Do set the payment status done
                        line.set_payment_status('done');
                        resolve(true);
                    } else {
                        // Payment was not successful - so set the status to retry
                        line.set_payment_status('retry');
                        // Allow to start a new transaction
                        line.transaction_id = null;
                        resolve(false);
                    }
                }
            }
            function hobex_failure(response, textStatus, errorThrow) {
                // only "waiting", "waitingCard", "timeout" will make the payment line not removable
                // retry will allow to remove it
                // but in this state we can not allow to remove it - because payment could be successful
                // waiting will produce a waiting screen without a cancel button
                // waitingCard will produce a waiting screen with a cancel button - which will call send_payment_cancel
                // but send_payment_cancel can not accept a successful payment
                line.set_payment_status('waiting');
                if (response.status === 0) {
                    // This means that the server is not reachable - or browser got a reload
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('Fehler'),
                        'body': _t('Odoo System ist nicht erreichbar.'),
                    });
                    // We do not resolv here - because we do not have a final answer to our request
                } else if (response.status === 404) {
                    // Transaction not found - so we can start a new one
                    line.transaction_id = null;
                    resolve(false);
                } else if (response.responseJSON) {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Antwort'),
                        'body': _t(response.responseJSON.message),
                    });
                    resolve(false);
                } else {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t(response.statusText),
                        'body': _t(response.responseText),
                    });
                    resolve(false);
                }
            }
            // Check if we do have already a transaction_id here - if we do already have an answer from hobex side
            if ((line.transaction_id) && ("hobex_responseCode" in line) && (line.hobex_responseCode != "0")) {
                // There is already a hobex result - but not successful - set lets try with a new transaction
                console.log('do reset transaction id to null');
                line.transaction_id = null;
            } else if ((line.transaction_id) && ("hobex_responseCode" in line) && (line.hobex_responseCode === "0")) {
                // Transaction was already successful - so do resolve true
                line.set_payment_status('done');
                resolve(true);
                return;
            }
            if (line.transaction_id) {
                // There is already a transaction_id - but no responseCode from Hobex
                // So Update the transaction state from the server
                line.set_payment_status('waiting');
                $.ajax({
                    url: "/hobex/api/v2/transactions/" + line.payment_method.id + "/" + line.transaction_id,
                    type: 'get',
                    timeout: 20000,
                }).then(
                    hobex_status_done,
                    hobex_failure
                );
            } else {
                // No transaction_id - so start a new one
                console.log("Starting new transaction");
                line.set_payment_status('waitingCard');
                line.transaction_id = Date.now();
                order.save_to_db();
                var data = {
                    'amount': Math.round(line.amount / this.pos.currency.rounding) * this.pos.currency.rounding,
                    'currency': this.pos.currency.name,
                    'tid': line.payment_method.hobex_terminal_id,
                    'reference': order.uid,
                    'transactionId': line.transaction_id,
                    'pos_payment_mode_id': line.payment_method.id,
                };
                $.ajax({
                    url: "/hobex/api/transaction/payment",
                    type: 'post',
                    data: JSON.stringify({
                        'transaction': data,
                    }),
                    contentType: "application/json",
                    timeout: 120000,
                }).then(
                    hobex_done,
                    hobex_failure
                );
            }
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
        // hobex does not support to cancel running payment requests
        this.pos.env.posbus.trigger('hobex_error', {
            'title': _t('ACHTUNG'),
            'body': _t('Zahlung bitte am Terminal abbrechen !'),
        });
        return Promise.resolve(false);
    },

    async update_payment_status(order, cid){
        var self = this;
        const line = order.paymentlines.find((line) => line.cid === cid);
        line.set_payment_status('waitingCard');
        return new Promise((resolve) => {
            $.ajax({
                url: "/hobex/api/v2/transactions/" + line.payment_method.id + "/" + line.transaction_id,
                type: 'get',
                timeout: 60000,
            }).then(
                function done(result) {
                    line['hobex_responseCode'] = result.responseCode;
                    console.log('did set hobex response code ' + result.responseCode);
                    if ((result.responseCode === "0") && (result.state === "OK")) {
                        self.update_payment_line_values_from_hobex(line, result);
                        line.set_payment_status('done');
                        resolve(true);
                    } else if ((result.responseCode === "0") && (result.state === "VOID")) {
                        self.update_payment_line_values_from_hobex(line, result);
                        line.set_amount(0);
                        line.set_payment_status('reversed');
                        resolve(true);
                    } else {
                        line.set_payment_status('retry');
                        resolve(false);
                    }
                },
                function failure(response) {
                    if (response.status === 0) {
                        // This means that the server is not reachable - or browser got a reload
                        self.pos.env.posbus.trigger('hobex_error', {
                            'title': _t('Fehler'),
                            'body': _t('Odoo System ist nicht erreichbar.'),
                        });
                        // We do not resolve here - because we do not have a final answer to our request
                    } else if (response.status === 404) {
                        // Transaction not found
                        line.set_payment_status('retry');
                        line.transaction_id = null;
                        resolve(true);
                    } else if (response.responseJSON) {
                        self.pos.env.posbus.trigger('hobex_error', {
                            'title': _t('hobex Antwort'),
                            'body': _t(response.responseJSON.message),
                        });
                        resolve(false);
                    } else {
                        self.pos.env.posbus.trigger('hobex_error', {
                            'title': _t(response.statusText),
                            'body': _t(response.responseText),
                        });
                        resolve(false);
                    }
                }
            );
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
        this._super.apply(this, arguments);
        var order = this.pos.get_order();
        var self = this;
        var line = order.selected_paymentline;
        line.set_payment_status('reversing');
        return new Promise((resolve) => {
            $.ajax({
                url: "/hobex/api/transaction/payment/" + line.payment_method.id + "/" + line.hobex_transactionId,
                type: 'delete',
                timeout: 120000,
            }).then(
                function done(result) {
                    resolve(true);
                },
                function failure(response) {
                    self.pos.env.posbus.trigger('hobex_error', {
                        'title': _t('hobex Fehler'),
                        'body': _t(response.responseJSON.message),
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
