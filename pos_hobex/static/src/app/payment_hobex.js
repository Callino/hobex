/* hobex payment api */
import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/payment/payment_interface";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";

export class PaymentHobex extends PaymentInterface {
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

    _hobex_handle_payment_request_done(line, resolve, response) {
        // Do always set the response Code
        line['hobex_responseCode'] = response.responseCode;
        console.log('did set hobex response code ' + response.responseCode);
        // And reset the payment status
        if (response.responseCode === "0") {
            line.set_payment_status('done');
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            line.set_payment_status('retry');
            if (response['responseCode'] === '8004') {
                this.pos.env.bus.trigger('hobex_error', {
                    'title': _t('hobex'),
                    'body': _t('Die Transaktion wurde am Terminal abgebrochen'),
                });
            } else if (response['responseCode'] === '8003') {
                this.pos.env.bus.trigger('hobex_error', {
                    'title': _t('hobex Gerätefehler'),
                    'body': _t('Das Terminal nicht scheint erreichbar zu sein. Bitte überprüfen Sie die Verbindung des Terminals mit dem Netzwerk und versuchen Sie es erneut.'),
                });
            } else {
                this.pos.env.bus.trigger('hobex_error', {
                    'title': _t('hobex Antwort'),
                    'body': response['responseCode'] + ': ' + response['responseText'],
                });
            }
            resolve(false);
        }
    }

    _hobex_handle_payment_request_failure(line, resolve, response, textStatus, errorThrow) {
        /**
         * This will get called if a failure on network side or a direct odoo exception was thrown
         */
        line.set_payment_status('retry');
        this.pos.env.bus.trigger('hobex_error', {
            'title': _t('Achtung Fehler'),
            'body': _t('Es ist ein Fehler bei der Kommunikation mit dem Odoo / hobex Server aufgetreten !'),
        });
        resolve(false);
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
    /**
     * @override
     */
    async send_payment_request(uuid) {
        await super.send_payment_request(...arguments);
        var order = this.pos.get_order();
        var self = this;
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
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
            // Check if we do have already a transaction_id here - if we do already have an answer from hobex side
            if ((line.transaction_id) && ("hobex_responseCode" in line) && (line.hobex_responseCode != "0")) {
                // There is already a hobex result - but not successful - set lets try with a new transaction
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
                this._hobex_update_payment_status(order, uuid);
            } else {
                // No transaction_id - so start a new one
                line.set_payment_status('waitingCard');
                line.transaction_id = Date.now();
                var data = {
                    'amount': Math.round(line.amount / this.pos.currency.rounding) * this.pos.currency.rounding,
                    'currency': this.pos.currency.name,
                    'tid': line.payment_method_id.hobex_terminal_id,
                    'reference': order.pos_reference,
                    'transactionId': line.transaction_id,
                };
                this.pos.data.silentCall("pos.payment.method", "proxy_hobex_payment_request", [
                    [line.payment_method_id.id],
                    data,
                ]).then(
                    this._hobex_handle_payment_request_done.bind(this, line, resolve),
                ).catch(
                    this._hobex_handle_payment_request_failure.bind(this, line, resolve),
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

    /**
     * @override
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

    _hobex_handle_status_connection_failure(line, data={}) {
        this.pos.env.bus.trigger('hobex_error', {
            'title': _t('hobex Fehler'),
            'body': _t(data.message),
        });
        line.set_payment_status('waiting');
        return Promise.reject(data);
    }
    _hobex_handle_status_update_response(line, resolve, response, textStatus, errorThrow) {
        if (response['error']===true) {
            line.set_payment_status('retry');
            resolve(false);
        } else {
            let result = response['res'];
            line['hobex_responseCode'] = result.responseCode;
            console.log('did set hobex response code ' + result.responseCode);
            if ((result.responseCode === "0") && (result.state === "OK")) {
                this.update_payment_line_values_from_hobex(line, result);
                line.set_payment_status('done');
                resolve(true);
            } else if ((result.responseCode === "0") && (result.state === "VOID")) {
                this.update_payment_line_values_from_hobex(line, result);
                line.set_amount(0);
                line.set_payment_status('reversed');
                resolve(true);
            } else {
                line.set_payment_status('retry');
                resolve(false);
            }
        }
    }
    async _hobex_update_payment_status(order, uuid){
        var self = this;
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.set_payment_status('waitingCard');
        return new Promise((resolve) => {
            this.pos.data.silentCall("pos.payment.method", "proxy_hobex_status_request", [
                [this.payment_method_id.id],
                line.transaction_id,
            ]).then(
                this._hobex_handle_status_update_response.bind(this, line, resolve)
            ).catch(
                this._hobex_handle_status_connection_failure.bind(this, line)
            );
        });
    }

    _hobex_handle_reversal_response(line, resolve, response) {
        // Do always set the response Code
        line['hobex_responseCode'] = response.responseCode;
        console.log('did set hobex response code ' + response.responseCode);
        // And reset the payment status
        if (response.responseCode === "0") {
            line.set_payment_status('reversed');
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            this.pos.env.bus.trigger('hobex_error', {
                'title': _t('hobex Antwort'),
                'body': _t(response.responseCode + ": " + response.responseText),
            });
            resolve(false);
        }
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
    /**
     * @override
     */
    send_payment_reversal(uuid) {
        super.send_payment_reversal(...arguments);
        var order = this.pos.get_order();
        var self = this;
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.set_payment_status('reversing');
        return new Promise((resolve) => {
            this.pos.data.silentCall("pos.payment.method", "proxy_hobex_reversal_request", [
                [this.payment_method_id.id],
                line.transaction_id,
            ]).then(
                this._hobex_handle_reversal_response.bind(this, line, resolve)
            ).catch(
                this._hobex_handle_status_connection_failure.bind(this, line)
            );
        });
    }
}

register_payment_method("hobex", PaymentHobex);
