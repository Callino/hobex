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
        var line = order.selected_paymentline;
        if (!line.transaction_id) {
            line.transaction_id = Date.now();
        }
        if (line.amount < 0) {
            return new Promise((resolve) => {
                self.pos.env.posbus.trigger('hobex_error', {
                    'title': _t('Negative Beträge nicht möglich.'),
                    'body': _t('Es ist nicht möglich einen negativen Betrag zurückzubuchen.'),
                });
                resolve(false);
            });
        }
        line.set_payment_status('waitingCard');
        var data = {
            'transactionType': 1,
            'amount': Math.round(line.amount / this.pos.currency.rounding) * this.pos.currency.rounding,
            'currency': this.pos.currency.name,
            'tid': line.payment_method.hobex_terminal_id,
            'reference': line.transaction_id,
            'pos_payment_mode_id': line.payment_method.id,
        };
        return new Promise((resolve) => {
            this.transactionResolve = resolve;
            $.ajax({
                url: "/hobex/api/transaction/payment",
                type: 'post',
                data: JSON.stringify({
                    'transaction': data,
                }),
                contentType: "application/json",
                timeout: 120000,
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
                        self.pos.env.bus.trigger('hobex_error', {
                            'title': _t('hobex Fehler'),
                            'body': result['responseCode'] + ': ' + result['responseText'],
                        });
                        resolve(false);
                    }
                },
                function failed(response) {
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Fehler'),
                        'body': _t(response.responseJSON.message),
                    });
                    resolve(false);
                }
            );
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
        this.pos.env.bus.trigger('hobex_error', {
            'title': _t('ACHTUNG'),
            'body': _t('Zahlung bitte am Terminal abbrechen !'),
        });
        return new Promise((resolve) => {
            resolve(true);
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
                    self.pos.env.bus.trigger('hobex_error', {
                        'title': _t('hobex Fehler'),
                        'body': _t(response.responseJSON.message),
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
    close() {}
};
