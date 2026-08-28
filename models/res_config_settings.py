# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    x_employee_folder_parent_id = fields.Many2one(
        "document.folder",
        string="Carpeta de Empleados",
        config_parameter="dfd_documents.employee_folder_parent_id",
        help="Carpeta donde se crearán las carpetas de cada empleado y sus subcarpetas.",
    )
