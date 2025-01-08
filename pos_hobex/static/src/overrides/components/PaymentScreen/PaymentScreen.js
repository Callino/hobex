import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useBus } from "@web/core/utils/hooks";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

// Extend Paymentscreen to be able to display a hobex error message
patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        useBus(this.env.bus, 'hobex_error', this._showHobexError);
    },
    _showHobexError(error) {
        this.env.services.dialog.add(AlertDialog, {
            title: error.detail.title,
            body: error.detail.body,
        });
    }
});