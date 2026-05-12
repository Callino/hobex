import { patch } from "@web/core/utils/patch";
import { onMounted } from "@odoo/owl";
import { PosPaymentProviderCards } from "@point_of_sale/backend/pos_payment_provider_cards/pos_payment_provider_cards";

// Core registers its provider list inside an onWillStart that REPLACES
// state.providers via assignment. OWL runs willStart hooks in parallel
// (Promise.all), so any hook pushing during willStart races with that
// reassignment and loses. onMounted runs after every willStart hook has
// resolved and after the first render, so it's safe to mutate state there.
patch(PosPaymentProviderCards.prototype, {
    setup() {
        super.setup();
        onMounted(async () => {
            if (this.state.providers.some((p) => p.selection === "hobex")) {
                return;
            }
            const res = await this.orm.call("pos.payment.method", "get_provider_status", [
                ["pos_hobex"],
            ]);
            const moduleState = res.state.find((m) => m.name === "pos_hobex");
            if (!moduleState) {
                return;
            }
            this.state.providers.push({
                selection: "hobex",
                provider: "Hobex",
                logo_url: "/pos_hobex/static/src/img/hobex_logo_3.png",
                id: moduleState.id,
                name: moduleState.name,
                state: moduleState.state,
            });
        });
    },
});
