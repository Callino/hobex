odoo.define('pos_hobex.models', function (require) {
    "use strict";

    var models = require('point_of_sale.models');
    var PaymentHobex = require('pos_hobex.payment');

    models.register_payment_method('hobex', PaymentHobex);
    // Include the hobex fields
    models.load_fields("pos.payment.method", ["hobex_terminal_id", "hobex_api_address", "hobex_auth_token", "auto_validate", "open_cashdrawer"]);

    // Extend Paymentline Model
    var PaymentlineModelParent = models.Paymentline;
    models.Paymentline = models.Paymentline.extend({
        apply_hobex_values: function(json) {
            for (const [key, value] of Object.entries(this)) {
                if (key.substr(0, 5) == "hobex") {
                    json[key] = value;
                }
            }
        },
        export_as_JSON: function() {
            var json = PaymentlineModelParent.prototype.export_as_JSON.apply(this, arguments);
            this.apply_hobex_values(json);
            return json;
        },
        export_for_printing: function(){
            var json = PaymentlineModelParent.prototype.export_for_printing.apply(this, arguments);
            this.apply_hobex_values(json);
            return json;
        },
        init_from_JSON: function(json){
            PaymentlineModelParent.prototype.init_from_JSON.apply(this, arguments);
            for (const [key, value] of Object.entries(json)) {
                if (key.substr(0, 5) == "hobex") {
                    this[key] = value;
                }
            }
        },
    });
});