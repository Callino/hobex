/* Hobex payment api */
import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/payment/payment_interface";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";

export class PaymentHobex extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.enable_reversals();
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
        // Hobex receipt returned with Unix line endings still prints with
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
        if (response.responseCode === "-1") {
            // Odoo got no usable answer from Hobex (timeout, connection error).
            // The outcome is unknown: the customer may still be completing the
            // payment at the terminal. Storing -1 on the line would make the
            // next Send reset transaction_id and start a *second* transaction,
            // so leave the line untouched and ask Hobex for the state of the
            // one that is already running.
            console.log("no Hobex result: " + response.responseText);
            return this._hobex_poll_after_no_answer(line, resolve);
        }
        line["hobex_responseCode"] = response.responseCode;
        if (response.responseCode === "0") {
            line.set_payment_status("done");
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            line.set_payment_status("retry");
            this._hobex_notify_failure(response);
            resolve(false);
        }
    }

    /**
     * Tell the cashier why a transaction did not go through.
     *
     * Used for the direct answer of a payment request and for a final
     * answer fetched with the status request, so both read the same.
     */
    _hobex_notify_failure(response) {
        if (response.hobex_forbidden) {
            // HTTP 403 from Hobex: the account is not cleared for this
            // operation. In practice this is the refund (Gutschrift)
            // function, which Hobex enables per account.
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex refund not enabled"),
                body: _t(
                    "The refund function is not enabled for this Hobex account. Please ask Hobex to activate it."
                ),
            });
        } else if (response.responseCode === "8004") {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex"),
                body: _t("The transaction was aborted at the terminal."),
            });
        } else if (response.responseCode === "8003") {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex device error"),
                body: _t(
                    "The terminal does not seem to be reachable. Please check that it is connected to the network and try again."
                ),
            });
        } else {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex response"),
                body: response.responseCode + ": " + response.responseText,
            });
        }
    }

    _hobex_poll_after_no_answer(line, resolve) {
        // Same call as _hobex_update_payment_status, but resolving the promise
        // that sendPaymentRequest is already waiting on - the transaction id
        // stays on the line so the poll can be repeated by tapping the line.
        this.pos.data
            .silentCall("pos.payment.method", "proxy_hobex_status_request", [
                [line.payment_method_id.id],
                line.transaction_id,
            ])
            .then(this._hobex_handle_status_update_response.bind(this, line, resolve))
            .catch(this._hobex_handle_status_connection_failure.bind(this, line, resolve));
    }

    _hobex_handle_payment_request_failure(line, resolve) {
        // Network failure or odoo exception
        line.set_payment_status("retry");
        this.pos.env.bus.trigger("hobex_error", {
            title: _t("Hobex error"),
            body: _t("A communication error with the Odoo / Hobex server occurred."),
        });
        resolve(false);
    }

    /**
     * @override
     */
    async send_payment_request(uuid) {
        await super.send_payment_request(...arguments);
        const order = this.pos.get_order();
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        // A negative payment line is a refund order: book a standalone credit
        // (Gutschrift) via /api/transaction/refund. Hobex needs no reference to
        // the original sale for that, but it does want a positive amount — the
        // sign stays in the Odoo payment line.
        const isRefund = line.amount < 0;
        return new Promise((resolve) => {
            // Already have a transaction_id with a non-success answer: reset for a new attempt.
            // Test the value, not `"hobex_responseCode" in line`: the field is
            // part of the loaded pos.payment model, so that test is always true
            // and a still running transaction would be dropped for a second one.
            if (line.transaction_id && line.hobex_responseCode && line.hobex_responseCode !== "0") {
                line.transaction_id = null;
            } else if (line.transaction_id && line.hobex_responseCode === "0") {
                // Transaction was already successful
                line.set_payment_status("done");
                resolve(true);
                return;
            }
            if (line.transaction_id) {
                // We have a transaction_id but no answer yet - poll the server.
                // The poll has to resolve *this* promise: PaymentScreen awaits
                // what send_payment_request returns, so handing the work to a
                // second promise would leave the line hanging forever.
                line.set_payment_status("waitingCard");
                this._hobex_poll_after_no_answer(line, resolve);
            } else {
                // No transaction yet - start a new one
                line.set_payment_status("waitingCard");
                line.transaction_id = Date.now();
                // Forget the result of an earlier attempt: it belongs to the old
                // transaction, and while it is set the next "Send" would treat
                // this new, possibly still running one as finished and start
                // another payment.
                line.hobex_responseCode = false;
                const data = {
                    // Absolute value first: Hobex wants a positive amount on
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
     * deletion while Hobex is still talking to the terminal.
     *
     * @override
     */
    send_payment_cancel(order, uuid) {
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
                    // Hobex explains why it refused (device unreachable, unknown
                    // transaction, ...). Passing that through is the difference
                    // between "try again" and "walk over to the terminal", so
                    // show it instead of swallowing it.
                    this.pos.env.bus.trigger("hobex_error", {
                        title: _t("Hobex abort failed"),
                        body: response?.message
                            ? _t(
                                  "The abort could not be sent to Hobex: %s Please cancel the payment directly on the terminal.",
                                  response.message
                              )
                            : _t(
                                  "The abort could not be sent to Hobex. Please cancel the payment directly on the terminal."
                              ),
                    });
                }
                // Note the small race: if the payment request happens to
                // settle while the abort is in flight, PaymentScreen still
                // resets the line to 'waitingCard' here. Tapping the line
                // again heals it — send_payment_request sees the stored
                // hobex_responseCode and restores 'done' or starts a retry.
                return false;
            });
    }

    _hobex_handle_status_connection_failure(line, resolve, data = {}) {
        // Bound as the `.catch` handler for the status/reversal silentCalls.
        // We must resolve(false) here — otherwise the outer Promise created
        // in _hobex_update_payment_status / send_payment_reversal hangs forever
        // (silentCall never rejects today, but a future switch to `call`
        // would land us here). We also avoid `Promise.reject(...)` which
        // would surface as an "Uncaught (in promise)" warning since we have
        // no further `.catch` downstream.
        this.pos.env.bus.trigger("hobex_error", {
            title: _t("Hobex error"),
            body: _t(data && data.message ? data.message : "A communication error with the Odoo / Hobex server occurred."),
        });
        line.set_payment_status("retry");
        resolve(false);
    }

    _hobex_handle_status_update_response(line, resolve, response) {
        // silentCall returns `false` on any failure; treat that as a
        // connection error instead of crashing on response.error.
        if (!response) {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex error"),
                body: _t("A communication error with the Odoo / Hobex server occurred."),
            });
            line.set_payment_status("retry");
            resolve(false);
            return;
        }
        if (response.error === true) {
            if (response.code === "no_answer") {
                // The state of the transaction is still unknown - keep it and
                // let the cashier ask again instead of freeing the line for a
                // new transaction.
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("Hobex"),
                    body: response.message,
                });
                line.set_payment_status("waitingCard");
                resolve(false);
                return;
            }
            if (response.code === "not_found") {
                // Hobex never saw this transaction, so a new one may be started.
                line.transaction_id = null;
                // Say why the line went back to "retry" - otherwise the
                // press of "Send" looks like it did nothing.
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("Hobex"),
                    // Already translated on the server.
                    body: response.message,
                });
            }
            line.set_payment_status("retry");
            resolve(false);
        } else {
            const result = response.res;
            // The spec writes the state lowercase ("ok, void, failed"), the
            // example response uppercase ("OK"). Compare case-insensitively.
            const state = String(result.state || "").toUpperCase();
            // Hobex may also answer responseCode "0" with state INPROGRESS while
            // the terminal is still busy. Storing that "0" on the line would
            // make the next "Send" count the line as paid, so treat it exactly
            // like the null responseCode below.
            if (
                result.responseCode === null ||
                result.responseCode === undefined ||
                state === "INPROGRESS"
            ) {
                // Transaction Status V2 reports a null responseCode while the
                // terminal is still working on the transaction. Putting the
                // line on "retry" here would invite a second charge for a
                // payment the customer is about to complete, so keep waiting.
                // Say so: core shows the line as "Transaction cancelled" once
                // this resolves falsy, which reads like a failed payment.
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("Hobex"),
                    body: _t(
                        'The payment is still running on the terminal. Please finish it there and press "Send" again to fetch the result.'
                    ),
                });
                line.set_payment_status("waitingCard");
                resolve(false);
                return;
            }
            line["hobex_responseCode"] = result.responseCode;
            if (result.responseCode === "0" && state === "VOID") {
                this.update_payment_line_values_from_hobex(line, result);
                line.set_amount(0);
                line.set_payment_status("reversed");
                resolve(true);
            } else if (result.responseCode === "0") {
                // OK - or a state we do not know: the server books that as
                // 'ok' as well (_update_transaction_with_hobex_result), so the
                // till must not offer a second payment for it.
                this.update_payment_line_values_from_hobex(line, result);
                line.set_payment_status("done");
                resolve(true);
            } else {
                // Final answer, but not a successful one (aborted at the
                // terminal, declined, ...) - say so, like the direct answer does.
                this._hobex_notify_failure(result);
                line.set_payment_status("retry");
                resolve(false);
            }
        }
    }

    async _hobex_update_payment_status(order, uuid) {
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.set_payment_status("waitingCard");
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
            // The reversal may or may not have reached Hobex - the line stays
            // paid, but the cashier has to check the real state.
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex"),
                body: _t(
                    "No answer from Hobex - the state of the reversal is unknown. Please check the transaction in the Hobex portal."
                ),
            });
            line.set_payment_status("done");
            resolve(false);
            return;
        }
        line["hobex_responseCode"] = response.responseCode;
        if (response.responseCode === "0") {
            line.set_payment_status("reversed");
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("Hobex response"),
                body: _t(response.responseCode + ": " + response.responseText),
            });
            resolve(false);
        }
    }

    /**
     * @override
     */
    send_payment_reversal(uuid) {
        super.send_payment_reversal(...arguments);
        const order = this.pos.get_order();
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.set_payment_status("reversing");
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
