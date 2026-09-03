/* hobex payment api */
import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

export class PaymentHobex extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.supports_reversals = true;
    }

    /**
     * Updates the payment line values by appending data from the result object,
     * and optionally prints a receipt if specific conditions are met.
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
        if (result.cvm === 1 && this.pos.hardwareProxy?.printer && result.cvm_receipt) {
            this.print_hobex_receipt(result.cvm_receipt);
        }
    }

    print_hobex_receipt(receipt) {
        // Convert *any* line terminator (CRLF, LF, or bare CR) to <br/> so a
        // hobex receipt returned with Unix line endings still prints with
        // line breaks instead of one squashed line.
        const body = receipt.replace(/\r\n|\r|\n/g, "<br/>");
        const htmlString =
            `<div class='pos-receipt'>` +
                `<div class='pos-payment-terminal-receipt'>${body}</div>` +
            `</div>`;
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = htmlString;
        // firstElementChild skips any stray TextNode (whitespace/comments),
        // so the printer always gets the receipt <div> even if someone
        // reformats the template literal above.
        const element = tempDiv.firstElementChild;
        if (!element) {
            return;
        }
        this.pos.hardwareProxy.printer.printReceipt(element);
    }

    _hobex_handle_payment_request_done(line, resolve, response) {
        // pos.data.silentCall swallows every error and resolves with `false`.
        // Reaching this handler with a falsy response therefore means the
        // server call failed — route it through the regular failure path
        // instead of crashing on response.responseCode.
        if (!response) {
            return this._hobex_handle_payment_request_failure(line, resolve);
        }
        line["hobex_responseCode"] = response.responseCode;
        if (response.responseCode === "0") {
            line.setPaymentStatus("done");
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            line.setPaymentStatus("retry");
            if (response.hobex_forbidden) {
                // HTTP 403 from hobex: the account is not cleared for this
                // operation. In practice this is the refund (Gutschrift)
                // function, which hobex enables per account.
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex refund not enabled"),
                    body: _t(
                        "The refund function is not enabled for this hobex account. Please ask hobex to activate it."
                    ),
                });
            } else if (response.responseCode === "8004") {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex"),
                    body: _t("The transaction was aborted at the terminal."),
                });
            } else if (response.responseCode === "8003") {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex device error"),
                    body: _t(
                        "The terminal does not seem to be reachable. Please check that it is connected to the network and try again."
                    ),
                });
            } else {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex response"),
                    body: response.responseCode + ": " + response.responseText,
                });
            }
            resolve(false);
        }
    }

    _hobex_handle_payment_request_failure(line, resolve) {
        // Network failure or odoo exception
        line.setPaymentStatus("retry");
        this.pos.env.bus.trigger("hobex_error", {
            title: _t("hobex error"),
            body: _t("A communication error with the Odoo / hobex server occurred."),
        });
        resolve(false);
    }

    /**
     * @override
     */
    async sendPaymentRequest(uuid) {
        await super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        // A negative payment line is a refund order: book a standalone credit
        // (Gutschrift) via /api/transaction/refund. hobex needs no reference to
        // the original sale for that, but it does want a positive amount — the
        // sign stays in the Odoo payment line.
        const isRefund = line.amount < 0;
        return new Promise((resolve) => {
            // Already have a transaction_id with a non-success answer: reset for a new attempt
            if (line.transaction_id && "hobex_responseCode" in line && line.hobex_responseCode !== "0") {
                line.transaction_id = null;
            } else if (line.transaction_id && "hobex_responseCode" in line && line.hobex_responseCode === "0") {
                // Transaction was already successful
                line.setPaymentStatus("done");
                resolve(true);
                return;
            }
            if (line.transaction_id) {
                // We have a transaction_id but no answer yet - poll the server
                this._hobex_update_payment_status(order, uuid);
            } else {
                // No transaction yet - start a new one
                line.setPaymentStatus("waitingCard");
                line.transaction_id = Date.now();
                const data = {
                    // Absolute value first: hobex wants a positive amount on
                    // a refund, and Math.round() breaks ties towards
                    // +Infinity, so rounding the negative value first would be
                    // off by one step on an exact half.
                    amount:
                        Math.round(Math.abs(line.amount) / this.pos.currency.rounding) *
                        this.pos.currency.rounding,
                    currency: this.pos.currency.name,
                    tid: line.payment_method_id.hobex_terminal_id,
                    reference: order.pos_reference || order.uuid,
                    transactionId: line.transaction_id,
                };
                this.pos.data
                    .silentCall(
                        "pos.payment.method",
                        isRefund ? "proxy_hobex_refund_request" : "proxy_hobex_payment_request",
                        [[line.payment_method_id.id], data]
                    )
                    .then(this._hobex_handle_payment_request_done.bind(this, line, resolve))
                    .catch(this._hobex_handle_payment_request_failure.bind(this, line, resolve));
            }
        });
    }

    /**
     * Abort a transaction that is still running on the terminal.
     *
     * The abort is a separate command (TID + transaction ID); it does not
     * interrupt the payment request that is still open. That request answers
     * on its own with responseCode 8004, and _hobex_handle_payment_request_done
     * is what moves the line to 'retry' and tells the cashier.
     *
     * We therefore resolve with `false` on success: PaymentScreen puts the line
     * back to 'waitingCard' on a falsy result, which is exactly right — the
     * line keeps waiting for the pending response instead of being freed for
     * deletion while hobex is still talking to the terminal.
     *
     * @override
     */
    sendPaymentCancel(order, uuid) {
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        if (!line || !line.transaction_id) {
            // Nothing was started on the terminal yet, so there is nothing to
            // abort and the line can be released right away.
            return Promise.resolve(true);
        }
        return this.pos.data
            .silentCall("pos.payment.method", "proxy_hobex_abort_request", [
                [line.payment_method_id.id],
                line.transaction_id,
            ])
            .then((response) => {
                // silentCall resolves with `false` when the server call failed.
                if (!response || response.error) {
                    // hobex explains why it refused (device unreachable, unknown
                    // transaction, ...). Passing that through is the difference
                    // between "try again" and "walk over to the terminal", so
                    // show it instead of swallowing it.
                    this.pos.env.bus.trigger("hobex_error", {
                        title: _t("hobex abort failed"),
                        body: response?.message
                            ? _t(
                                  "The abort could not be sent to hobex: %s Please cancel the payment directly on the terminal.",
                                  response.message
                              )
                            : _t(
                                  "The abort could not be sent to hobex. Please cancel the payment directly on the terminal."
                              ),
                    });
                }
                // Note the small race: if the payment request happens to
                // settle while the abort is in flight, PaymentScreen still
                // resets the line to 'waitingCard' here. Tapping the line
                // again heals it — sendPaymentRequest sees the stored
                // hobex_responseCode and restores 'done' or starts a retry.
                return false;
            });
    }

    _hobex_handle_status_connection_failure(line, resolve, data = {}) {
        // Bound as the `.catch` handler for the status/reversal silentCalls.
        // We must resolve(false) here — otherwise the outer Promise created
        // in _hobex_update_payment_status / sendPaymentReversal hangs forever
        // (silentCall never rejects today, but a future switch to `call`
        // would land us here). We also avoid `Promise.reject(...)` which
        // would surface as an "Uncaught (in promise)" warning since we have
        // no further `.catch` downstream.
        this.pos.env.bus.trigger("hobex_error", {
            title: _t("hobex error"),
            body: _t(data && data.message ? data.message : "A communication error with the Odoo / hobex server occurred."),
        });
        line.setPaymentStatus("retry");
        resolve(false);
    }

    _hobex_handle_status_update_response(line, resolve, response) {
        // silentCall returns `false` on any failure; treat that as a
        // connection error instead of crashing on response.error.
        if (!response) {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex error"),
                body: _t("A communication error with the Odoo / hobex server occurred."),
            });
            line.setPaymentStatus("retry");
            resolve(false);
            return;
        }
        if (response.error === true) {
            line.setPaymentStatus("retry");
            resolve(false);
        } else {
            const result = response.res;
            if (result.responseCode === null || result.responseCode === undefined) {
                // Transaction Status V2 reports a null responseCode while the
                // terminal is still working on the transaction. Putting the
                // line on "retry" here would invite a second charge for a
                // payment the customer is about to complete, so keep waiting.
                line.setPaymentStatus("waitingCard");
                resolve(false);
                return;
            }
            line["hobex_responseCode"] = result.responseCode;
            // The spec writes the state lowercase ("ok, void, failed"), the
            // example response uppercase ("OK"). Compare case-insensitively.
            const state = String(result.state || "").toUpperCase();
            if (result.responseCode === "0" && state === "OK") {
                this.update_payment_line_values_from_hobex(line, result);
                line.setPaymentStatus("done");
                resolve(true);
            } else if (result.responseCode === "0" && state === "VOID") {
                this.update_payment_line_values_from_hobex(line, result);
                line.setAmount(0);
                line.setPaymentStatus("reversed");
                resolve(true);
            } else {
                line.setPaymentStatus("retry");
                resolve(false);
            }
        }
    }

    async _hobex_update_payment_status(order, uuid) {
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.setPaymentStatus("waitingCard");
        return new Promise((resolve) => {
            this.pos.data
                .silentCall("pos.payment.method", "proxy_hobex_status_request", [
                    [this.payment_method_id.id],
                    line.transaction_id,
                ])
                .then(this._hobex_handle_status_update_response.bind(this, line, resolve))
                .catch(this._hobex_handle_status_connection_failure.bind(this, line, resolve));
        });
    }

    _hobex_handle_reversal_response(line, resolve, response) {
        // silentCall returns `false` on any failure; treat that as a
        // connection error instead of crashing on response.responseCode.
        if (!response) {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex error"),
                body: _t("A communication error with the Odoo / hobex server occurred."),
            });
            line.setPaymentStatus("done");
            resolve(false);
            return;
        }
        line["hobex_responseCode"] = response.responseCode;
        if (response.responseCode === "0") {
            line.setPaymentStatus("reversed");
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex response"),
                body: _t(response.responseCode + ": " + response.responseText),
            });
            resolve(false);
        }
    }

    /**
     * @override
     */
    sendPaymentReversal(uuid) {
        super.sendPaymentReversal(...arguments);
        const order = this.pos.getOrder();
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.setPaymentStatus("reversing");
        return new Promise((resolve) => {
            this.pos.data
                .silentCall("pos.payment.method", "proxy_hobex_reversal_request", [
                    [this.payment_method_id.id],
                    line.transaction_id,
                ])
                .then(this._hobex_handle_reversal_response.bind(this, line, resolve))
                .catch(this._hobex_handle_status_connection_failure.bind(this, line, resolve));
        });
    }
}

register_payment_method("hobex", PaymentHobex);
