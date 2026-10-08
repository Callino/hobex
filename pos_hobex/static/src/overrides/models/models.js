/** @odoo-module */

import { Payment } from "@point_of_sale/app/store/models";
import { patch } from "@web/core/utils/patch";

// On 17.0 the Payment model is a plain JS object, not an ORM record: core
// builds a fixed dict in export_as_JSON() / export_for_printing() and reads a
// fixed set of keys back in init_from_JSON(). Every hobex_* value the terminal
// puts on the line has to be threaded through all three or it is lost —
// export_as_JSON() feeds pos.order._payment_fields() on the server,
// export_for_printing() feeds pos_hobex.HobexDetails on the receipt, and
// init_from_JSON() restores a line when an order comes back from the server or
// from local storage.
//
// (On 18.0 the payment line *is* an ORM record, so only export_for_printing
// still needs patching. On 19.0 the receipt reads the records directly and the
// whole patch is gone.)
patch(Payment.prototype, {
    apply_hobex_values(data) {
        for (const [key, value] of Object.entries(this)) {
            if (key.startsWith("hobex")) {
                data[key] = value;
            }
        }
    },
    export_as_JSON() {
        const data = super.export_as_JSON(...arguments);
        this.apply_hobex_values(data);
        return data;
    },
    export_for_printing() {
        const data = super.export_for_printing(...arguments);
        this.apply_hobex_values(data);
        return data;
    },
    init_from_JSON(json) {
        super.init_from_JSON(...arguments);
        for (const [key, value] of Object.entries(json)) {
            if (key.startsWith("hobex")) {
                this[key] = value;
            }
        }
    },
});
