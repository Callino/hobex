import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { onMounted } from "@odoo/owl";

// Extend PaymentScreen to pick up a Hobex payment that was still running when
// the screen was left, and to handle deletion of Hobex payment lines that have
// already triggered a transaction.
patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        onMounted(async () => {
            const pendingPaymentLine = this.currentOrder.payment_ids.find(
                (paymentLine) =>
                    paymentLine.payment_method_id.payment_provider === "hobex" &&
                    !paymentLine.isDone() &&
                    paymentLine.transaction_id &&
                    // Only lines still waiting for their result: a line with a
                    // final answer already shows it, polling it again would only
                    // repeat the old error every time the screen opens.
                    !paymentLine.hobex_responseCode
            );
            if (!pendingPaymentLine) {
                return;
            }
            await pendingPaymentLine.payment_interface._hobex_update_payment_status(
                this.currentOrder,
                pendingPaymentLine.uuid
            );
        });
    },
    /**
     * Start the Hobex payment as soon as the line is added, as up to Odoo 19.
     *
     * Odoo 20 only sends bank QR lines on its own and leaves terminal lines
     * on "Payment request pending" until Send is pressed. Switchable per
     * payment method (hobex_auto_start). Refund orders keep the explicit
     * Refund button, like before.
     *
     * @override
     */
    async addNewPaymentLine(paymentMethod) {
        const added = await super.addNewPaymentLine(...arguments);
        if (
            added &&
            paymentMethod.payment_provider === "hobex" &&
            paymentMethod.hobex_auto_start &&
            !this.isRefundOrder
        ) {
            this.sendPaymentRequest(this.paymentLines.at(-1));
        }
        return added;
    },
    /**
     * Keep a Hobex line on "cancelling" until Hobex reports the outcome.
     *
     * Core sets the line back to 'waitingCard' whenever sendPaymentCancel
     * resolves falsy (PosPayment.handlePaymentCancelResponse), and our
     * terminal deliberately does resolve falsy: the abort only asks Hobex to
     * stop the terminal, the
     * still-open payment request is what reports the result (8004) and frees
     * the line. Between those two moments Hobex can take half a minute, and
     * the cashier would stare at an unchanged "waiting for card" line - so
     * leave it on 'waitingCancel', which renders as "Request sent" with a
     * spinner and keeps the Force cancel escape hatch available.
     *
     * @override
     */
    async sendPaymentCancel(line) {
        if (line.payment_method_id.payment_provider !== "hobex") {
            return await super.sendPaymentCancel(...arguments);
        }
        line.setPaymentStatus("waitingCancel");
        await line.payment_interface.sendPaymentCancel(line);
    },
    //@Override
    deletePaymentLine(uuid) {
        const order = this.pos.getOrder();
        const line = order.payment_ids.find((line) => line.uuid === uuid);
        if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id &&
            line.getPaymentStatus() === "retry"
        ) {
            // Payment status is retry - safe to delete the line
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "0"
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Attention"),
                body: _t("The payment was successful and cannot be deleted."),
            });
        } else if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8004"
        ) {
            // 8004 = aborted at terminal
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8003"
        ) {
            // 8003 = device error
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Hobex response"),
                body: "Code: " + line.hobex_responseCode + "\n" + line.hobex_responseText,
            });
        } else if (
            line.payment_method_id.payment_provider === "hobex" &&
            line.transaction_id
        ) {
            // The line is still in flight. Deleting it here would orphan a
            // transaction that Hobex may still complete, so point the cashier
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
