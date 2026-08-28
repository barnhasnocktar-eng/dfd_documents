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
    x_grant_manager_department_permissions = fields.Boolean(
        string="Dar permisos al gerente sobre todo su departamento al crear las carpetas",
        config_parameter="dfd_documents.grant_manager_department_permissions",
        default=False,
        help="Al crear o actualizar carpetas de empleados, da acceso automático al gerente del "
        "departamento sobre la carpeta de ese departamento (con lo que alcanza también a las "
        "carpetas de todos sus empleados). Si el empleado no tiene departamento, o su "
        "departamento no tiene gerente asignado, pero el empleado sí tiene un responsable "
        "directo, el permiso se da directamente sobre la carpeta del propio empleado. Aplica "
        "también sobre carpetas ya creadas.",
    )
