import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { useBus } from "@web/core/utils/hooks";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { onMounted } from "@odoo/owl";

// Extend PaymentScreen to display hobex error messages and to handle
// deletion of hobex payment lines that have already triggered a transaction.
patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        useBus(this.env.bus, "hobex_error", this._showHobexError);
        onMounted(async () => {
            const pendingPaymentLine = this.currentOrder.payment_ids.find(
                (paymentLine) =>
                    paymentLine.payment_method_id.use_payment_terminal === "hobex" &&
                    !paymentLine.is_done() &&
                    paymentLine.transaction_id
            );
            if (!pendingPaymentLine) {
                return;
            }
            await pendingPaymentLine.payment_method_id.payment_terminal._hobex_update_payment_status(
                this.currentOrder,
                pendingPaymentLine.uuid
            );
        });
    },
    /**
     * Keep a hobex line on "cancelling" until hobex reports the outcome.
     *
     * Core sets the line back to 'waitingCard' whenever send_payment_cancel
     * resolves falsy (payment_screen.js), and our terminal deliberately does
     * resolve falsy: the abort only asks hobex to stop the terminal, the
     * still-open payment request is what reports the result (8004) and frees
     * the line. Between those two moments hobex can take half a minute, and
     * the cashier would stare at an unchanged "waiting for card" line - so
     * leave it on 'waitingCancel', which renders as "Request sent" with a
     * spinner and keeps the Force cancel escape hatch available.
     *
     * @override
     */
    async sendPaymentCancel(line) {
        if (line.payment_method_id.use_payment_terminal !== "hobex") {
            return await super.sendPaymentCancel(...arguments);
        }
        line.set_payment_status("waitingCancel");
        await line.payment_method_id.payment_terminal.send_payment_cancel(
            this.currentOrder,
            line.uuid
        );
    },
    _showHobexError(error) {
        this.env.services.dialog.add(AlertDialog, {
            title: error.detail.title,
            body: error.detail.body,
        });
    },
    //@Override
    deletePaymentLine(uuid) {
        const order = this.pos.get_order();
        const line = order.payment_ids.find((line) => line.uuid === uuid);
        if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.get_payment_status() === "retry"
        ) {
            // Payment status is retry - safe to delete the line
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "0"
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Attention"),
                body: _t("The payment was successful and cannot be deleted."),
            });
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8004"
        ) {
            // 8004 = aborted at terminal
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8003"
        ) {
            // 8003 = device error
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("hobex response"),
                body: "Code: " + line.hobex_responseCode + "\n" + line.hobex_responseText,
            });
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id
        ) {
            // The line is still in flight. Deleting it here would orphan a
            // transaction that hobex may still complete, so point the cashier
            // at the Cancel button, which sends the abort command.
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Attention"),
                body: _t(
                    "The payment is still running. Please cancel it with \"Cancel\" or directly on the terminal."
                ),
            });
        } else {
            super.deletePaymentLine(...arguments);
        }
    },
});
