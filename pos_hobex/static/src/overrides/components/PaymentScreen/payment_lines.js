import { PaymentScreenPaymentLines } from "@point_of_sale/app/screens/payment_screen/payment_lines/payment_lines";
import { patch } from "@web/core/utils/patch";

// "Force done" books a payment in Odoo without asking Hobex, so the order can
// be closed while the terminal still charges or has already declined the card.
// Hobex always reports the outcome itself - a running payment answers on its
// own, and an aborted one with 8004 - so the shortcut is never needed and only
// invites a wrong booking. Core offers it in the 'force_done', the waiting for
// card and the 'waiting' state; drop it there.
patch(PaymentScreenPaymentLines.prototype, {
    getPaymentActionState(line) {
        const state = super.getPaymentActionState(...arguments);
        if (line.payment_provider === "hobex") {
            state.actions = state.actions.filter((action) => action.id !== "force_done");
        }
        return state;
    },
});
