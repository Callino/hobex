import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";

// Core's onDoRefund() bails out with a bare `return` in two situations
// (ticket_screen.js): when no orderline can be prepared, and when the sum of
// the quantities marked for refund is zero. Both are reached by simply
// pressing Refund on an order that cannot be refunded any further - a refund
// order itself, or one whose lines are already fully refunded - and the
// cashier gets no feedback at all. Explain the reason instead of doing
// nothing.
patch(TicketScreen.prototype, {
    async onDoRefund() {
        const order = this.getSelectedOrder();
        const reason = order && this._refundBlockedReason(order);
        if (reason) {
            this.dialog.add(AlertDialog, {
                title: _t("Refund not possible"),
                body: reason,
            });
            return;
        }
        return await super.onDoRefund(...arguments);
    },

    /**
     * Why pressing Refund on this order would do nothing, or false when it
     * would in fact go through. Mirrors the conditions core checks, in the
     * order that produces the most specific message.
     *
     * @param {object} order the order selected in the ticket screen
     * @returns {string|false}
     */
    _refundBlockedReason(order) {
        if (this._isRefundOrder(order)) {
            return _t(
                "This order is a refund of another order. A refund cannot be refunded again. " +
                    "Open the original order to refund more of it."
            );
        }
        const lines = order.get_orderlines();
        if (lines.length && lines.every((line) => line.qty - line.refunded_qty <= 0)) {
            let body = _t(
                "Every line of this order has already been refunded, so there is nothing left to refund."
            );
            // The reversal hint only holds for an order actually paid on a
            // hobex terminal. This patch itself is payment-method agnostic:
            // it runs on every order once the module is installed, so the
            // hobex-specific half has to be gated.
            if (this._hasHobexCardPayment(order)) {
                body +=
                    " " +
                    _t(
                        "A card payment from today can still be reversed at the terminal, but only from " +
                            "the back end (Orders / Payments) and it does not correct the order in Odoo."
                    );
            }
            return body;
        }
        if (!this.getHasItemsToRefund()) {
            return _t(
                "No quantity is selected for the refund. Pick a line and enter the quantity to refund."
            );
        }
        return false;
    },

    /**
     * True when this order is itself the refund of another order.
     *
     * Odoo 18 has no `is_refund` flag on pos.order (that field only exists
     * from 19.0 on). What identifies a refund order here is its lines: each
     * of them points back at the line it refunds.
     *
     * @param {object} order the order selected in the ticket screen
     * @returns {boolean}
     */
    _isRefundOrder(order) {
        return order.get_orderlines().some((line) => line.refunded_orderline_id);
    },

    /**
     * True when the order carries a settled payment on a hobex terminal.
     *
     * @param {object} order the order selected in the ticket screen
     * @returns {boolean}
     */
    _hasHobexCardPayment(order) {
        return (order.payment_ids || []).some(
            (payment) =>
                payment.payment_method_id?.use_payment_terminal === "hobex" && payment.amount > 0
        );
    },
});
