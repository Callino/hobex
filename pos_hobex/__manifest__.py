# -*- coding: utf-8 -*-
{
    'name': 'Hobex Payment Terminal',
    'summary': 'Hobex Payment Terminal Integration for Odoo POS',
    'version': '14.0.0.1',
    'category': 'Point of Sale',
    'sequence': 6,
    'website': 'https://github.com/hobex/odoo',
    'author': 'Wolfgang Pichler (Callino), Gerhard Baumgartner (Callino)',
    "license": "AGPL-3",
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/assets.xml',
        'views/pos_payment_method.xml',
        'views/pos_config.xml',
        'views/pos_payment.xml',
    ],
    'qweb': [
        'static/src/xml/ReceiptScreen/OrderReceipt.xml',
    ],
    'installable': True,
    'auto_install': False,
}
