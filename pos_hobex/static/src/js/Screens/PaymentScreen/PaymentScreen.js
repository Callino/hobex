odoo.define('pos_hobex.PaymentScreen', function (require) {
    "use strict";

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');
    const { useBus } = require("@web/core/utils/hooks");

    // Extend Paymentscreen to be able to display a hobex error message
    const HobexPaymentScreen = (PaymentScreen) =>
        class extends PaymentScreen {
            setup() {
                super.setup();
                useBus(this.env.posbus, 'hobex_error', this._showHobexError);
            }
            _showHobexError(error) {
                this.showPopup('ErrorPopup',{
                    'title': error.detail.title,
                    'body': error.detail.body,
                });
            }
        };

    Registries.Component.extend(PaymentScreen, HobexPaymentScreen);

    return PaymentScreen;

});