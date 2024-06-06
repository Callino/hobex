/** @odoo-module */

import { Payment } from "@point_of_sale/app/store/models";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { PaymentHobex } from '@pos_hobex/js/payment_hobex';
import { patch } from "@web/core/utils/patch";

    register_payment_method('hobex', PaymentHobex);


    // Extend Paymentline Model - so all hobex_ members will get into the data dict
    patch(Payment.prototype, {
        apply_hobex_values(data) {
            for (const [key, value] of Object.entries(this)) {
                if (key.substr(0, 5) == "hobex") {
                    data[key] = value;
                }
            }
        },
        export_as_JSON() {
            var data = super.export_as_JSON(...arguments);
            this.apply_hobex_values(data);
            return data;
        },
        export_for_printing(){
            var data = super.export_for_printing(...arguments);
            this.apply_hobex_values(data);
            return data;
        },
        init_from_JSON(json){
            super.init_from_JSON(...arguments);
            for (const [key, value] of Object.entries(json)) {
                if (key.substr(0, 5) == "hobex") {
                    this[key] = value;
                }
            }
        },
    });