odoo.define('pos_hobex.pos', function (require) {
    "use strict";

    var core = require('web.core');
    var QWeb = core.qweb;
    var models = require('point_of_sale.models');
    var _t = core._t;

    // Define our own Hobex Class - does provide all terminal related functions
    var Hobex = core.Class.extend({
        closed_manual: false,

        init: function(attributes){
            this.pos = attributes.pos;
        },

        payment_terminal_transaction_start: function(line_cid, currency_iso, ref){
            var self = this;
            var order = this.pos.get_order();
            var line = order.paymentlines._byId[line_cid];
            var data = {};
            if (data['amount'] === 0) {
                return;
            }
            if (line.is_return_line === true) {
                if (!ref) {
                    // We should display a popup here to get the original ref number !
                    this.pos.gui.show_popup('hobex_ref', {
                        'callback': function (ref) {
                            line.ref_number = ref;
                            self.payment_terminal_transaction_reversal(line_cid);
                        },
                        'cancel_callback': function (ref) {
                            order.remove_paymentline(line);
                            //self.pos.gui.screen_instances['payment'].render_paymentlines();
                        },
                    });
                    return;
                } else {
                    data = {
                        'transactionType': 1,
                        'amount': line.get_transaction_amount(),
                        'currency': currency_iso,
                        'ref': ref,
                        'tid': line.payment_method.hobex_terminal_id,
                        'transactionId': line.ref_number
                    };
                }
            } else {
                line.ref_number = new Date().getTime();
                data = {
                    'transactionType': 1,
                    'amount': line.get_transaction_amount(),
                    'currency': currency_iso,
                    'tid': line.payment_method.hobex_terminal_id,
                    'reference': line.sequence_number,
                };
            }
            line.hobex_transaction = true;

            // Do start ajax call here
            line.hobex_request = $.ajax({
                url: line.payment_method.hobex_api_address + "/api/transaction/payment",
                type: 'post',
                data: JSON.stringify({transaction: data}),
                contentType: "application/json",
                timeout: 120000,
                headers: {
                    'Token': line.payment_method.hobex_auth_token,
                }
            });
            line.hobex_request.then(
                function done(result) {
                    line.hobex_transaction = false;
                    line.hobex_request = null;
                    self.update_line_with_result(order, line, result);
                },
                function failed() {
                    line.hobex_transaction = false;
                    line.hobex_request = null;
                    line.ref_number = null;
                    // Remove Payment line on failure if auto payment is enabled
                    order.remove_paymentline(line);
                    order.trigger('hobex_error', {
                        'title': _t('Failure'),
                        'body': _t('Communication with payment terminal failed'),
                    });
                }
            );
            // Do rerender the payment lines
            //self.pos.gui.screen_instances['payment'].render_paymentlines();
        },

        update_line_with_result: function(order, line, result) {
            if (result.responseCode === "0") {
                for (const [key, value] of Object.entries(result)) {
                  line['hobex_'+key] = value;
                }
                // Set Amount from transaction
                if (line.is_return_line === true) {
                    line.set_amount(-1 * result.amount);
                } else {
                    line.set_amount(result.amount);
                }
                if (result.cvm === 1) {
                    this.print_receipt(line);
                }
                // Do automatically try to validate order if paymentline has configured it
                if (order.selected_paymentline.payment_method.auto_validate) {
                    this.pos.gui.screen_instances.payment.validate_order();
                }
            } else {
                // Remove Payment line on failure
                order.remove_paymentline(line);
                order.trigger('hobex_error', {
                    'title': _t('Hobex Fehler'),
                    'body': result['responseCode'] + ': ' + result['responseText'],
                });
            }
            //this.pos.gui.screen_instances.payment.render_paymentlines();
        },
        payment_terminal_transaction_status: function(line_cid){
            var self = this;
            var order = this.pos.get_order();
            var line = order.paymentlines._byId[line_cid];
            if (!line.payment_method.use_payment_terminal==='hobex') {
                return;
            }
            $('.payment-terminal-transaction-status[data-cid='+line_cid+']').addClass('oe_hidden');
            $.ajax({
                url: line.payment_method.hobex_api_address + "/api/v2/transactions/" + line.payment_method.hobex_terminal_id + "/" + line.hobex_transactionId,
                type: 'get',
                data: null,
                contentType: "application/json",
                headers: {
                    'Token': line.payment_method.hobex_auth_token,
                }
            }).then(
                function done(result) {
                    self.update_line_with_result(order, line, result);
                    // Show Status Widget
                    self.pos.gui.show_popup('hobex_transaction_status', {
                        'title': _t('Transaktion ') + line.ref_number,
                        'line': line,
                    });
                },
                function failed() {
                    line.hobex_transaction = false;
                    line.hobex_request = null;
                    $('.payment-terminal-transaction-status[data-cid='+line_cid+']').removeClass('oe_hidden');
                }
            );
        },

        payment_terminal_transaction_receipt: function(line_cid){
            var order = this.pos.get_order();
            var line = order.paymentlines._byId[line_cid];
            if (!line.payment_method.use_payment_terminal==='hobex') {
                return;
            }
            var oReq = new XMLHttpRequest();
            oReq.open("GET", line.payment_method.hobex_api_address + "/api/transaction/download?tid=" + line.payment_method.hobex_terminal_id + "&transactionId=" + line.hobex_transactionId + "&raw=True", true);
            oReq.setRequestHeader('Token', line.payment_method.hobex_auth_token);
            oReq.responseType = "blob";
            oReq.onload = function(oEvent) {
                var blob = oReq.response;
                var link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.download = line.hobex_transactionId + ".pdf";
                link.click();
            };

            oReq.send();
        },

        payment_terminal_transaction_reversal: function(line_cid){
            var self = this;
            var order = this.pos.get_order();
            var line = order.paymentlines._byId[line_cid];
            line.hobex_transaction = true;
            $('.payment-terminal-transaction-refund[data-cid=' + line_cid + ']').addClass('oe_hidden');
            $('.payment-terminal-transaction-status[data-cid=' + line_cid + ']').addClass('oe_hidden');
            line.hobex_request = $.ajax({
                url: line.payment_method.hobex_api_address + "/api/transaction/payment/" + line.payment_method.hobex_terminal_id + "/" + line.hobex_transactionId,
                type: 'delete',
                timeout: 120000,
                headers: {
                    'Token': line.payment_method.hobex_auth_token,
                }
            });
            line.hobex_request.then(
                function done(result) {
                    line.hobex_transaction = false;
                    line.hobex_request = null;
                    var order = self.pos.get_order();
                    // This will print the merchant receipt if needed
                    self.update_line_with_result(order, line, result);
                    // Remove payment line
                    order.remove_paymentline(line);
                    //self.pos.gui.screen_instances.payment.render_paymentlines();
                },
                function failed() {
                    line.hobex_transaction = false;
                    self.pos.gui.show_popup('error', {
                        'title': _t('Failure'),
                        'body': _t('Communication with payment terminal failed'),
                    });
                }
            );
        },

        display_receipt: function(title, receipt) {
            $('#hobex_last_receipt').html('<h2>' + title + '</h2>' + receipt);
            $('#hobex_last_receipt').removeClass('oe_hidden');
        },

        print_receipt: function(line) {
            // transactionDate is in the form "2018-10-09T14:07:00.9436463+02:00"
            var transactionDate = line.hobex_transactionDate.substr(0,10);
            var transactionTime = line.hobex_transactionDate.substr(11,8);
            this.pos.proxy.print_receipt(QWeb.render('HobexSignReceipt', {
                line: line,
                transactionDate: transactionDate,
                transactionTime: transactionTime,
                widget: this.pos.chrome.widget.sale_details,   // Just to have a widget to use the format currency function
            }));
        },

    });

    // Add our hobex class to the global pos namespace
    var PosModelSuper = models.PosModel;
    models.PosModel = models.PosModel.extend({
        initialize: function (session, attributes) {
            // Call super call
            PosModelSuper.prototype.initialize.apply(this, arguments);
            // Do connect initialize Hobex Class
            this.hobex = new Hobex({'pos': this});
        },
    });
});
