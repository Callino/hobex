/** @odoo-module */

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useBus } from "@web/core/utils/hooks";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import {onMounted} from "@odoo/owl";

// Extend Paymentscreen to be able to display a hobex error message
patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        useBus(this.env.bus, 'hobex_error', this._showHobexError);
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
            await pendingPaymentLine.payment_method.payment_terminal.update_payment_status(
                this.currentOrder,
                pendingPaymentLine.cid
            );
        });
    },
    _showHobexError(error) {
        this.popup.add(ErrorPopup, {
            title: error.detail.title,
            body: error.detail.body,
        });
    },
    //@Override
    deletePaymentLine(cid) {
        const line = this.paymentLines.find((line) => line.cid === cid);
        if ((line.payment_method.use_payment_terminal == "hobex") &&
            (line.transaction_id) &&
            (line.hobex_responseCode === "0")
        ) {
            this.popup.add(ErrorPopup, {
                title: 'ACHTUNG',
                body: 'Die Zahlung war erfolgreich, kann nicht gelöscht werden !',
            });
        } else if ((line.payment_method.use_payment_terminal == "hobex") &&
                   (line.transaction_id) &&
                   (line.hobex_responseCode === "8004")
        ) {
            // Responsecode is 8004 - so we can delete this payment line
            this.currentOrder.remove_paymentline(line);
            this.numberBuffer.reset();
        } else if ((line.payment_method.use_payment_terminal == "hobex") &&
                   (line.transaction_id) &&
                   (line.hobex_responseCode)
        ) {
            // Responsecode is something else - display it
            this.popup.add(ErrorPopup, {
                title: 'hobex Antwort',
                body: 'Code: ' + line.hobex_responseCode + '\n' + line.hobex_responseText,
            });
        } else if ((line.payment_method.use_payment_terminal == "hobex") && (line.transaction_id)) {
            this.popup.add(ErrorPopup, {
                title: 'ACHTUNG',
                body: 'Die Zahlung muss am Terminal abgebrochen werden !',
            });
        } else {
            super.deletePaymentLine(...arguments);
        }
    }
});