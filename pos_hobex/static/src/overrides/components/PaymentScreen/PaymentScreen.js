/** @odoo-module */

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { useBus } from "@web/core/utils/hooks";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { onMounted } from "@odoo/owl";

// Extend PaymentScreen to display Hobex error messages and to handle
// deletion of Hobex payment lines that have already triggered a transaction.
//
// 17.0 shows these messages through the popup service (ErrorPopup); the
// dialog service with AlertDialog only arrives in 18.0.
patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        useBus(this.env.bus, "hobex_error", this._showHobexError);
        onMounted(async () => {
            const pendingPaymentLine = this.currentOrder.paymentlines.find(
                (paymentLine) =>
                    paymentLine.payment_method.use_payment_terminal === "hobex" &&
                    !paymentLine.is_done() &&
                    paymentLine.transaction_id
            );
            if (!pendingPaymentLine) {
                return;
            }
            await pendingPaymentLine.payment_method.payment_terminal._hobex_update_payment_status(
                this.currentOrder,
                pendingPaymentLine.cid
            );
        });
    },
    /**
     * Keep a Hobex line on "cancelling" until Hobex reports the outcome.
     *
     * Core sets the line back to 'waitingCard' whenever send_payment_cancel
     * resolves falsy (payment_screen.js), and our terminal deliberately does
     * resolve falsy: the abort only asks Hobex to stop the terminal, the
     * still-open payment request is what reports the result (8004) and frees
     * the line. Between those two moments Hobex can take half a minute, and
     * the cashier would stare at an unchanged "waiting for card" line - so
     * leave it on 'waitingCancel', which renders as "Request sent" with a
     * spinner.
     *
     * @override
     */
    async sendPaymentCancel(line) {
        if (line.payment_method.use_payment_terminal !== "hobex") {
            return await super.sendPaymentCancel(...arguments);
        }
        line.set_payment_status("waitingCancel");
        await line.payment_method.payment_terminal.send_payment_cancel(
            this.currentOrder,
            line.cid
        );
    },
    _showHobexError(error) {
        this.popup.add(ErrorPopup, {
            title: error.detail.title,
            body: error.detail.body,
        });
    },
    //@Override
    deletePaymentLine(cid) {
        const order = this.pos.get_order();
        const line = order.paymentlines.find((line) => line.cid === cid);
        const isHobex = line.payment_method.use_payment_terminal === "hobex";
        if (!isHobex || !line.transaction_id) {
            super.deletePaymentLine(...arguments);
        } else if (line.get_payment_status() === "retry") {
            // Payment status is retry - safe to delete the line
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (line.hobex_responseCode === "0") {
            this.popup.add(ErrorPopup, {
                title: _t("Attention"),
                body: _t("The payment was successful and cannot be deleted."),
            });
        } else if (line.hobex_responseCode === "8004") {
            // 8004 = aborted at terminal
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (line.hobex_responseCode === "8003") {
            // 8003 = device error
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (line.hobex_responseCode) {
            this.popup.add(ErrorPopup, {
                title: _t("Hobex response"),
                body: "Code: " + line.hobex_responseCode + "\n" + line.hobex_responseText,
            });
        } else {
            // The line is still in flight. Deleting it here would orphan a
            // transaction that Hobex may still complete, so point the cashier
            // at the Cancel button, which sends the abort command.
            this.popup.add(ErrorPopup, {
                title: _t("Attention"),
                body: _t(
                    "The payment is still running. Please cancel it with \"Cancel\" or directly on the terminal."
                ),
            });
        }
    },
});
