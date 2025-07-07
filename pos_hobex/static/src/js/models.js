/** @odoo-module */
import { Payment } from "@point_of_sale/app/store/models";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { PaymentHobex } from '@pos_hobex/js/payment_hobex';
import { patch } from "@web/core/utils/patch";

register_payment_method('hobex', PaymentHobex);

patch(Payment.prototype, {
    setup() {
        super.setup(...arguments);
        // Do initialize the hobex values
        this.hobex_receipt = this.hobex_receipt || null;
        this.hobex_approvalCode = this.hobex_approvalCode || null;
        this.hobex_actionCode = this.hobex_actionCode || null;
        this.hobex_aid = this.hobex_aid || null;
        this.hobex_reference = this.hobex_reference || null;
        this.hobex_tid = this.hobex_tid || null;
        this.hobex_transactionId = this.hobex_transactionId || null;
        this.hobex_transactionDate = this.hobex_transactionDate || null;
        this.hobex_cardNumber = this.hobex_cardNumber || null;
        this.hobex_cardExpiry = this.hobex_cardExpiry || null;
        this.hobex_brand = this.hobex_brand || null;
        this.hobex_cardIssuer = this.hobex_cardIssuer || null;
        this.hobex_transactionType = this.hobex_transactionType || null;
        this.hobex_responseCode = this.hobex_responseCode || null;
        this.hobex_responseText = this.hobex_responseText || null;
        this.hobex_cvm = this.hobex_cvm || null;
    },
    //@override
    export_as_JSON() {
        var json = super.export_as_JSON(...arguments);
        if (json) {
            // Do set the hobex values in the json result
            json.hobex_receipt = this.hobex_receipt;
            json.hobex_approvalCode = this.hobex_approvalCode;
            json.hobex_actionCode = this.hobex_actionCode;
            json.hobex_aid = this.hobex_aid;
            json.hobex_reference = this.hobex_reference;
            json.hobex_tid = this.hobex_tid;
            json.hobex_transactionId = this.hobex_transactionId;
            json.hobex_transactionDate = this.hobex_transactionDate;
            json.hobex_cardNumber = this.hobex_cardNumber;
            json.hobex_cardExpiry = this.hobex_cardExpiry;
            json.hobex_brand = this.hobex_brand;
            json.hobex_cardIssuer = this.hobex_cardIssuer;
            json.hobex_transactionType = this.hobex_transactionType;
            json.hobex_responseCode = this.hobex_responseCode;
            json.hobex_responseText = this.hobex_responseText;
            json.hobex_cvm = this.hobex_cvm;
        }
        return json;
    },
    //@override
    init_from_JSON(json){
        super.init_from_JSON(...arguments);
        // Do set the hobex values from the json values
        this.hobex_receipt = json.hobex_receipt;
        this.hobex_approvalCode = json.hobex_approvalCode;
        this.hobex_actionCode = json.hobex_actionCode;
        this.hobex_aid = json.hobex_aid;
        this.hobex_reference = json.hobex_reference;
        this.hobex_tid = json.hobex_tid;
        this.hobex_transactionId = json.hobex_transactionId;
        this.hobex_transactionDate = json.hobex_transactionDate;
        this.hobex_cardNumber = json.hobex_cardNumber;
        this.hobex_cardExpiry = json.hobex_cardExpiry;
        this.hobex_brand = json.hobex_brand;
        this.hobex_cardIssuer = json.hobex_cardIssuer;
        this.hobex_transactionType = json.hobex_transactionType;
        this.hobex_responseCode = json.hobex_responseCode;
        this.hobex_responseText = json.hobex_responseText;
        this.hobex_cvm = json.hobex_cvm;
    },
    export_for_printing(){
        var data = super.export_for_printing(...arguments);
        // This is the key value for OrderReceipt to decide if we should print the hobex values
        data.hobex_transactionId = this.hobex_transactionId;
        // these are the values we do print in the HobexDetails
        data.hobex_tid = this.hobex_tid;
        data.hobex_receipt = this.hobex_receipt;
        data.hobex_cardIssuer = this.hobex_cardIssuer;
        data.hobex_cardNumber = this.hobex_cardNumber;
        data.hobex_transactionType = this.hobex_transactionType;
        data.hobex_approvalCode = this.hobex_approvalCode;
        data.hobex_aid = this.hobex_aid;
        data.hobex_responseCode = this.hobex_responseCode;
        data.hobex_responseText = this.hobex_responseText;
        data.hobex_actionCode = this.hobex_actionCode;
        data.hobex_cvm = this.hobex_cvm;
        return data;
    },
});