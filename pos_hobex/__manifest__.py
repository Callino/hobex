# -*- coding: utf-8 -*-
{
    'name': 'hobex Payment Terminal',
    'summary': 'hobex Payment Terminal Integration for Odoo POS',
    'version': '16.0.1.0.0',
    'category': 'Point of Sale',
    'sequence': 6,
    'website': 'https://github.com/callino/hobex',
    'author': 'Callino Software Entwicklung',
    "license": "AGPL-3",
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/pos_payment_method.xml',
        'views/pos_payment.xml',
        'data/cron.xml',
    ],
    'images': [
        'static/description/banner.png',
    ],
    'assets': {
        'point_of_sale.assets': [
            "pos_hobex/static/src/js/models.js",
            "pos_hobex/static/src/js/payment_hobex.js",
            "pos_hobex/static/src/js/Screens/PaymentScreen/PaymentScreen.js",
            "pos_hobex/static/src/xml/ReceiptScreen/OrderReceipt.xml",
        ],
    },

    'installable': True,
    'auto_install': False,
}
