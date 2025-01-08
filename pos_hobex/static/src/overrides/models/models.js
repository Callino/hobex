import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { PaymentHobex } from "@pos_hobex/app/payment_hobex";
import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";

register_payment_method('hobex', PaymentHobex);


// Extend Paymentline Model - so all hobex_ members will get into the data dict
patch(PosPayment.prototype, {
    apply_hobex_values(data) {
        for (const [key, value] of Object.entries(this)) {
            if (key.substr(0, 5) == "hobex") {
                data[key] = value;
            }
        }
    },

    export_for_printing(){
        var data = super.export_for_printing(...arguments);
        this.apply_hobex_values(data);
        return data;
    },
});
