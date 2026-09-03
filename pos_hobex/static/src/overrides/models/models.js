import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";

// The receipt template does not see the pos.payment records themselves: the
// order builds `props.data.paymentlines` from export_for_printing(), which in
// core returns nothing but amount / name / ticket. Everything
// pos_hobex.HobexDetails prints has to be added here, or the hobex block on
// the receipt stays empty.
//
// (In 19.0 the receipt reads the payment records directly and this patch is
// gone. It is still needed on 18.0.)
patch(PosPayment.prototype, {
    export_for_printing() {
        const data = super.export_for_printing(...arguments);
        // The key the receipt tests to decide whether to print a hobex block.
        data.hobex_transactionId = this.hobex_transactionId;
        // The values printed inside pos_hobex.HobexDetails.
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
