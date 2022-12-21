odoo.define('pos_hobex.PaymentScreen', function (require) {
    "use strict";

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');
    const { useListener } = require("@web/core/utils/hooks");

    // Extend Paymentscreen to be able to display a hobex error message
    const HobexPaymentScreen = (PaymentScreen) =>
        class extends PaymentScreen {
            setup() {
                super.setup();
                useListener('hobex_error', this._showHobexError);
            }
            _showHobexError(error) {
                self.showPopup('ErrorPopup',{
                    'title': error.title,
                    'body': error.body,
                });
            }
        };

    Registries.Component.extend(PaymentScreen, HobexPaymentScreen);

    return PaymentScreen;

});