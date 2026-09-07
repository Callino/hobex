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
        if (response.responseCode === "-1") {
            // Odoo got no usable answer from hobex (timeout, connection error) - the outcome is
            // unknown, the customer may still complete the payment at the terminal. Do not store
            // -1 as hobex result on the line (the transaction is still open) and never start a
            // new transaction - ask hobex for the state of this one instead.
            console.log("no hobex result: " + response.responseText);
            line.setPaymentStatus("waitingCard");
            this._hobex_request_status(line, resolve);
            return;
        }
        line["hobex_responseCode"] = response.responseCode;
        if (response.responseCode === "0") {
            line.setPaymentStatus("done");
            this.update_payment_line_values_from_hobex(line, response);
            resolve(true);
        } else {
            line.setPaymentStatus("retry");
            if (response.responseCode === "8004") {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex"),
                    body: _t("Die Transaktion wurde am Terminal abgebrochen"),
                });
            } else if (response.responseCode === "8003") {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex Gerätefehler"),
                    body: _t(
                        "Das Terminal nicht scheint erreichbar zu sein. Bitte überprüfen Sie die Verbindung des Terminals mit dem Netzwerk und versuchen Sie es erneut."
                    ),
                });
            } else {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("hobex Antwort"),
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
            title: _t("Achtung Fehler"),
            body: _t("Es ist ein Fehler bei der Kommunikation mit dem Odoo / hobex Server aufgetreten !"),
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
        if (line.amount < 0) {
            return new Promise((resolve) => {
                this.pos.env.bus.trigger("hobex_error", {
                    title: _t("Negative Beträge nicht möglich."),
                    body: _t("Es ist nicht möglich einen negativen Betrag zurückzubuchen."),
                });
                line.setPaymentStatus("force_done");
                resolve(false);
            });
        }
        return new Promise((resolve) => {
            // Already have a transaction_id with a non-success answer: reset for a new attempt
            if (line.transaction_id && line.hobex_responseCode && line.hobex_responseCode !== "0") {
                line.transaction_id = null;
            } else if (line.transaction_id && line.hobex_responseCode === "0") {
                // Transaction was already successful
                line.setPaymentStatus("done");
                resolve(true);
                return;
            }
            if (line.transaction_id) {
                // We have a transaction_id but no final answer yet (e.g. Odoo got a timeout while
                // waiting for the terminal). The payment may have been completed at the terminal -
                // so never start a new transaction here, ask hobex for the state of this one.
                line.setPaymentStatus("waitingCard");
                this._hobex_request_status(line, resolve);
            } else {
                // No transaction yet - start a new one
                line.setPaymentStatus("waitingCard");
                line.transaction_id = Date.now();
                const data = {
                    amount:
                        Math.round(line.amount / this.pos.currency.rounding) *
                        this.pos.currency.rounding,
                    currency: this.pos.currency.name,
                    tid: line.payment_method_id.hobex_terminal_id,
                    reference: order.pos_reference || order.uuid,
                    transactionId: line.transaction_id,
                };
                this.pos.data
                    .silentCall("pos.payment.method", "proxy_hobex_payment_request", [
                        [line.payment_method_id.id],
                        data,
                    ])
                    .then(this._hobex_handle_payment_request_done.bind(this, line, resolve))
                    .catch(this._hobex_handle_payment_request_failure.bind(this, line, resolve));
            }
        });
    }

    /**
     * @override
     */
    sendPaymentCancel(order, uuid) {
        // Hobex does not support to cancel running payment requests.
        // We do handle this directly in PaymentScreen.deletePaymentLine.
        this.pos.env.bus.trigger("hobex_error", {
            title: "ACHTUNG",
            body: "Die Zahlung muss am Terminal abgebrochen werden !",
        });
        return Promise.resolve(false);
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
            title: _t("hobex Fehler"),
            body: _t(data && data.message ? data.message : "Es ist ein Fehler bei der Kommunikation mit dem Odoo / hobex Server aufgetreten !"),
        });
        line.setPaymentStatus("retry");
        resolve(false);
    }

    _hobex_handle_status_update_response(line, resolve, response) {
        // silentCall returns `false` on any failure; treat that as a
        // connection error instead of crashing on response.error.
        if (!response) {
            return this._hobex_handle_status_connection_failure(line, resolve);
        }
        if (response.error === true) {
            if (response.code === "not_found") {
                // hobex does not know this transaction - it never reached hobex, so it is
                // safe to start a new one with the next "Send"
                line.transaction_id = null;
            }
            // "no_answer": keep the transaction_id - the next "Send" asks again
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex"),
                body: _t(response.message || "Es ist ein Fehler bei der Kommunikation mit dem Odoo / hobex Server aufgetreten !"),
            });
            line.setPaymentStatus("retry");
            resolve(false);
            return;
        }
        const result = response.res;
        if (result.responseCode === "0" && result.state === "INPROGRESS") {
            // Still running on the terminal. Do NOT store the response code - the line would
            // count as paid on the next "Send" - and keep the transaction_id so that the next
            // "Send" asks for the state again instead of starting a new transaction.
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex"),
                body: _t('Die Zahlung ist am Terminal noch in Bearbeitung. Bitte am Terminal abschließen und danach erneut "Senden" drücken.'),
            });
            line.setPaymentStatus("retry");
            resolve(false);
            return;
        }
        // Final answer from hobex
        line["hobex_responseCode"] = result.responseCode;
        if (result.responseCode === "0" && result.state === "VOID") {
            this.update_payment_line_values_from_hobex(line, result);
            line.setAmount(0);
            line.setPaymentStatus("reversed");
            resolve(true);
        } else if (result.responseCode === "0") {
            // state OK (an unknown state with responseCode 0 is treated as paid, like the server does)
            this.update_payment_line_values_from_hobex(line, result);
            line.setPaymentStatus("done");
            resolve(true);
        } else {
            // Not successful (aborted at the terminal, declined, ...) - allow a new attempt
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex Antwort"),
                body: result.responseCode + ": " + result.responseText,
            });
            line.transaction_id = null;
            line.setPaymentStatus("retry");
            resolve(false);
        }
    }

    _hobex_request_status(line, resolve) {
        // Ask hobex (via Odoo) for the state of the line's transaction. The server waits for
        // the terminal itself while the transaction is in progress (up to ~60 seconds).
        this.pos.data
            .silentCall("pos.payment.method", "proxy_hobex_status_request", [
                [this.payment_method_id.id],
                line.transaction_id,
            ])
            .then(this._hobex_handle_status_update_response.bind(this, line, resolve))
            .catch(this._hobex_handle_status_connection_failure.bind(this, line, resolve));
    }

    async _hobex_update_payment_status(order, uuid) {
        const line = order.payment_ids.find((paymentLine) => paymentLine.uuid === uuid);
        line.setPaymentStatus("waitingCard");
        return new Promise((resolve) => this._hobex_request_status(line, resolve));
    }

    _hobex_handle_reversal_response(line, resolve, response) {
        // silentCall returns `false` on any failure; treat that as a
        // connection error instead of crashing on response.responseCode.
        if (!response) {
            this.pos.env.bus.trigger("hobex_error", {
                title: _t("hobex Fehler"),
                body: _t("Es ist ein Fehler bei der Kommunikation mit dem Odoo / hobex Server aufgetreten !"),
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
                title: _t("hobex Antwort"),
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
