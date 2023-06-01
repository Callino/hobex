odoo.define('pos_hobex.models', function (require) {
    "use strict";

    var { Payment } = require('point_of_sale.models');
    var PaymentHobex = require('pos_hobex.payment');
    var models = require('point_of_sale.models');
    const Registries = require('point_of_sale.Registries');

    models.register_payment_method('hobex', PaymentHobex);


    // Extend Paymentline Model - so all hobex_ members will get into the data dict
    const HobexPaymentLine = (Payment) =>
        class extends Payment {
        apply_hobex_values(data) {
            for (const [key, value] of Object.entries(this)) {
                if (key.substr(0, 5) == "hobex") {
                    data[key] = value;
                }
            }
        }
        export_as_JSON() {
            var data = super.export_as_JSON(...arguments);
            this.apply_hobex_values(data);
            return data;
        }
        export_for_printing(){
            var data = super.export_for_printing(...arguments);
            this.apply_hobex_values(data);
            return data;
        }
        init_from_JSON(json){
            super.init_from_JSON(...arguments);
            for (const [key, value] of Object.entries(json)) {
                if (key.substr(0, 5) == "hobex") {
                    this[key] = value;
                }
            }
        }
    }
    Registries.Model.extend(Payment, HobexPaymentLine);
});