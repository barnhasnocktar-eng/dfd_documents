# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
{
    "name": "Difadi - Gestor de Documentos",
    "version": "17.0.1.1.0",
    "license": "LGPL-3",
    "author": "Difadi.com",
    "website": "https://difadi.com",
    "summary": "Gestor de carpetas y documentos con navegación en árbol",
    "category": "Customizations",
    "depends": ["base", "mail", "spiffy_theme_backend"],
    "data": [
        # Security
        "security/ir.model.access.csv",
        # Views
        "views/document_folder_views.xml",
        "views/document_file_views.xml",
        # Wizards
        "wizards/document_folder_create_wizard_views.xml",
        # Vistas que dependen de acciones definidas anteriormente
        "data/ui_menus.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "dfd_documents/static/src/scss/document_folder_kanban.scss",
            "dfd_documents/static/src/js/document_folder_breadcrumb.js",
            "dfd_documents/static/src/js/document_folder_breadcrumb.xml",
        ],
    },
    "installable": True,
    "application": False,
}
