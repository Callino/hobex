import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { PaymentHobex } from "@pos_hobex/app/payment_hobex";
import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";

register_payment_method("hobex", PaymentHobex);


// Extend Paymentline Model - so all hobex_ members will get into the data dict
patch(PosPayment.prototype, {
    apply_hobex_values(data) {
        for (const [key, value] of Object.entries(this)) {
            if (key.substr(0, 5) == "hobex") {
                if (!((value === false) || (value === null))) {
                    // Do only copy values that are not false or null
                    data[key] = value;
                }
            }
        }
    },

    //@override
    export_for_printing() {
        if (this.payment_method_id.type!="hobex") {
            return super.export_for_printing();
        } else {
            const data = super.export_for_printing();
            this.apply_hobex_values(data);
            return data;
        }
    },
});
