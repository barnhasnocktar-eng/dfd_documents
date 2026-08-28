# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models


class HrEmployee(models.Model):
    _inherit = "hr.employee"

    x_document_folder_id = fields.Many2one(
        "document.folder",
        string="Carpeta de documentos",
        copy=False,
        help="Carpeta de documentos vinculada a este empleado. Se rellena al pulsar 'Crear carpetas', pero puede cambiarse a mano.",
    )

    def x_action_create_employee_folder(self):
        """Crea, dentro de la carpeta raíz 'Empleados', una carpeta con el nombre del empleado
        y, dentro de ella, las subcarpetas configuradas en document.employee.default.folder.
        """
        self.ensure_one()
        root_folder = self.env.ref("dfd_documents.document_folder_empleados")
        employee_folder = self.env["document.folder"].create({
            "name": self.name,
            "parent_id": root_folder.id,
        })
        default_folders = self.env["document.employee.default.folder"].search([])
        self.env["document.folder"].create([
            {"name": default_folder.name, "parent_id": employee_folder.id}
            for default_folder in default_folders
        ])
        self.x_document_folder_id = employee_folder.id

    def x_action_go_to_employee_folder(self):
        """Navega al explorador de documentos abierto sobre la carpeta del empleado."""
        self.ensure_one()
        return self.env["document.folder"]._get_kanban_action(self.x_document_folder_id.id)
