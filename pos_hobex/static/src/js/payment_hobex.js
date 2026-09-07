/** @odoo-module */
import { PaymentInterface } from "@point_of_sale/app/payment/payment_interface";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { _t } from "@web/core/l10n/translation";


export class PaymentHobex extends PaymentInterface{

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    setup() {
        super.setup(...arguments);
        this.enable_reversals();
    }

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
        if (result.cvm === 1 && this.pos.hardwareProxy.printer && result.cvm_receipt) {
            this.print_hobex_receipt(result.cvm_receipt);
        }
    }

    print_hobex_receipt(receipt) {
        const htmlString =
            `<div class='pos-receipt'>
                <div class='pos-payment-terminal-receipt'>
                    ${receipt.replace(/\r\n/g, "<br/>")}
                </div>
            </div>`
        const tempDiv = document.createElement('div'); // Create a temporary container
        tempDiv.innerHTML = htmlString; // Set the HTML string
        const element = tempDiv.firstChild; // Access the first DOM element
        this.pos.hardwareProxy.printer.printReceipt(element);
    }

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
    async send_payment_request(cid) {
        await super.send_payment_request(...arguments);
        var order = this.pos.get_order();
        var self = this;
        const line = order.paymentlines.find((line) => line.cid === cid);
        if (line.amount < 0) {
            return new Promise((resolve) => {
                self.pos.env.bus.trigger('hobex_error', {
                    'title': _t('Negative Beträge nicht möglich.'),
                    'body': _t('Es ist nicht möglich einen negativen Betrag zurückzubuchen.'),
                });
                line.set_payment_status("force_done");
                resolve(false);
            });
        }
        return new Promise((resolve) => {
            function hobex_check_status() {
                // There is a transaction_id - but no final answer from hobex for it yet
                // (e.g. Odoo got a timeout while waiting for the terminal). The payment may
                // still have been completed at the terminal - so never start a new transaction
                // here, ask hobex for the state of this one instead.
                console.log('checking hobex state of transaction ' + line.transaction_id);
                line.set_payment_status('waiting');
                $.ajax({
                    url: "/hobex/api/v2/transactions/" + line.payment_method.id + "/" + line.transaction_id,
                    type: 'get',
                    // the server waits for the terminal itself (up to ~60 seconds)
                    timeout: 120000,
                }).then(
                    hobex_status_done,
                    hobex_failure
                );
            }
            function hobex_done(result) {
                if (result.responseCode === "-1") {
                    // Odoo got no usable answer from hobex (timeout, connection error) - the
                    // outcome is unknown. Do not store -1 as hobex result on the line, the
                    // transaction is still open - check its state.
                    console.log('no hobex result: ' + result.responseText);
                    hobex_check_status();
                    return;
                }
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
                    // Still running on the terminal - keep the transaction_id, the next
                    // "Send" will check the state again
                    line.set_payment_status('waitingCard');
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex'),
                        'body': _t('Die Zahlung ist am Terminal noch in Bearbeitung. Bitte am Terminal abschließen und danach erneut "Senden" drücken.'),
                    });
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
                        self.pos.env.bus.trigger('hobex_error', {
                            'title': _t('hobex Antwort'),
                            'body': result['responseCode'] + ': ' + result['responseText'],
                        });
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
                    // hobex does not know this transaction - it never reached hobex, so it is
                    // safe to start a new one with the next "Send"
                    line.transaction_id = null;
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex'),
                        'body': _t('Die Transaktion ist bei hobex nicht bekannt. Bitte erneut "Senden" drücken um eine neue Zahlung zu starten.'),
                    });
                    resolve(false);
                } else if (response.responseJSON) {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Antwort'),
                        'body': _t(response.responseJSON.responseText || response.responseJSON.message || JSON.stringify(response.responseJSON)),
                    });
                    resolve(false);
                } else {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('Fehler'),
                        'body': _t('Kommunikationsfehler mit dem Odoo Server (HTTP %s). Bitte erneut "Senden" drücken um den Status der Zahlung abzufragen.', response.status),
                    });
                    resolve(false);
                }
            }
            // Check if we do have already a transaction_id here - if we do already have an answer from hobex side
            if (line.transaction_id && line.hobex_responseCode && line.hobex_responseCode !== "0") {
                // There is already a hobex result - but not successful - set lets try with a new transaction
                console.log('do reset transaction id to null');
                line.transaction_id = null;
            } else if (line.transaction_id && line.hobex_responseCode === "0") {
                // Transaction was already successful - so do resolve true
                line.set_payment_status('done');
                resolve(true);
                return;
            }
            if (line.transaction_id) {
                // There is already a transaction_id - but no responseCode from Hobex
                // So Update the transaction state from the server
                hobex_check_status();
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
    }

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
    send_payment_cancel(order, cid) {
        // Hobex does not support to cancel running payment requests
        // We do handle this directly in PaymentScreen deletePaymentLine
        this.pos.env.bus.trigger('hobex_error', {
            title: 'ACHTUNG',
            body: 'Die Zahlung muss am Terminal abgebrochen werden !',
        });
        return Promise.resolve(false);
    }

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
                    if (response.status === 404) {
                        // hobex does not know this transaction - allow to start a new one
                        line.transaction_id = null;
                        line.set_payment_status('retry');
                    } else {
                        line.set_payment_status('waiting');
                    }
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Fehler'),
                        'body': (response.responseJSON && (response.responseJSON.responseText || response.responseJSON.message))
                            || response.responseText
                            || _t('Kommunikationsfehler mit dem Odoo Server (HTTP %s).', response.status),
                    });
                    resolve(false);
                }
            );
        });
    }

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
    async send_payment_reversal(cid) {
        await super.send_payment_reversal(...arguments);
        var order = this.pos.get_order();
        var self = this;
        const line = order.paymentlines.find((line) => line.cid === cid);
        line.set_payment_status('reversing');
        return new Promise((resolve) => {
            $.ajax({
                url: "/hobex/api/transaction/payment/" + line.payment_method.id + "/" + line.transaction_id,
                type: 'delete',
                timeout: 120000,
            }).then(
                function done(result) {
                    resolve(true);
                },
                function failure(response) {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Fehler'),
                        'body': (response.responseJSON && response.responseJSON.message)
                            || response.responseText
                            || _t('Kommunikationsfehler mit dem Odoo Server (HTTP %s).', response.status),
                    });
                    resolve(false);
                }
            );
        });
    }

    /**
     * Called when the payment screen in the POS is closed (by
     * e.g. clicking the "Back" button). Could be used to cancel in
     * progress payments.
     */
    close() {
        console.log("Close got called");
    }
};
