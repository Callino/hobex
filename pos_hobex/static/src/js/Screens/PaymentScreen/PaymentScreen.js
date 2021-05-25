odoo.define('pos_hobex.PaymentScreen', function (require) {
    "use strict";

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');
    const { onChangeOrder } = require('point_of_sale.custom_hooks');

    // Extend Paymentscreen to be able to display a hobex error message
    const HobexPaymentScreen = (PaymentScreen) =>
        class extends PaymentScreen {
            constructor() {
                super(...arguments);
                onChangeOrder(this._removeErrorListener, this._addErrorListener);
            }
            _removeErrorListener(order) {
                order.off('hobex_error');
            }
            _addErrorListener(order) {
                var self = this;
                order.on('hobex_error', function(error) {
                    self.showPopup('ErrorPopup',{
                        'title': error.title,
                        'body': error.body,
                    });
                });
            }
        };

    Registries.Component.extend(PaymentScreen, HobexPaymentScreen);

    return PaymentScreen;

});