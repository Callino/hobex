import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
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
                    !paymentLine.isDone() &&
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
    _showHobexError(error) {
        this.env.services.dialog.add(AlertDialog, {
            title: error.detail.title,
            body: error.detail.body,
        });
    },
    //@Override
    deletePaymentLine(uuid) {
        const order = this.pos.getOrder();
        const line = order.payment_ids.find((line) => line.uuid === uuid);
        if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.getPaymentStatus() === "retry"
        ) {
            // Payment status is retry - safe to delete the line
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "0"
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: "ACHTUNG",
                body: "Die Zahlung war erfolgreich, kann nicht gelöscht werden !",
            });
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8004"
        ) {
            // 8004 = aborted at terminal
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode === "8003"
        ) {
            // 8003 = device error
            this.currentOrder.removePaymentline(line);
            this.numberBuffer.reset();
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id &&
            line.hobex_responseCode
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: "hobex Antwort",
                body: "Code: " + line.hobex_responseCode + "\n" + line.hobex_responseText,
            });
        } else if (
            line.payment_method_id.use_payment_terminal === "hobex" &&
            line.transaction_id
        ) {
            this.env.services.dialog.add(AlertDialog, {
                title: "ACHTUNG",
                body: "Die Zahlung muss am Terminal abgebrochen werden !",
            });
        } else {
            super.deletePaymentLine(...arguments);
        }
    },
});
