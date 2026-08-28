# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
{
    "name": "Difadi - Gestor de Documentos",
    "version": "17.0.1.17.2",
    "license": "LGPL-3",
    "author": "Difadi.com",
    "website": "https://difadi.com",
    "summary": "Gestor de carpetas y documentos con navegación en árbol",
    "category": "Customizations",
    "depends": ["base", "base_import", "mail", "hr", "spiffy_theme_backend"],
    "data": [
        # Security
        "security/ir.model.access.csv",
        "data/access_permissions.xml",
        # Views
        "views/document_folder_views.xml",
        "views/document_file_views.xml",
        "views/employee_default_folder_views.xml",
        "views/hr_employee_views.xml",
        "views/res_config_settings_views.xml",
        # Wizards
        "wizards/document_folder_create_wizard_views.xml",
        "wizards/document_folder_rename_wizard_views.xml",
        "wizards/document_folder_permissions_wizard_views.xml",
        "wizards/employee_folder_sync_wizard_views.xml",
        # Vistas que dependen de acciones definidas anteriormente
        "data/ui_menus.xml",
        # Datos por defecto
        "data/document_folder_data.xml",
        "data/employee_default_folder_data.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "dfd_documents/static/src/scss/document_folder_kanban.scss",
            "dfd_documents/static/src/js/document_folder_drag_state.js",
            "dfd_documents/static/src/js/document_folder_bus.js",
            "dfd_documents/static/src/js/document_folder_tree_sidebar.js",
            "dfd_documents/static/src/js/document_folder_tree_sidebar.xml",
            "dfd_documents/static/src/js/document_folder_breadcrumb.js",
            "dfd_documents/static/src/js/document_folder_breadcrumb.xml",
            "dfd_documents/static/src/js/document_folder_rename_menu.js",
            "dfd_documents/static/src/js/document_folder_rename_menu.xml",
        ],
    },
    "installable": True,
    "application": False,
}
