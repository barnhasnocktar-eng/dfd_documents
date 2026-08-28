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
        """Crea, dentro de la carpeta padre configurada en Ajustes (ver
        `x_get_employee_folder_parent`), una carpeta con el nombre del empleado y, dentro de
        ella, las subcarpetas configuradas en document.employee.default.folder.
        """
        self.ensure_one()
        self.x_sync_default_folders()

    def x_action_go_to_employee_folder(self):
        """Navega al explorador de documentos abierto sobre la carpeta del empleado."""
        self.ensure_one()
        return self.env["document.folder"]._get_kanban_action(self.x_document_folder_id.id)

    def x_get_employee_folder_parent(self):
        """Carpeta padre bajo la que se crean las carpetas de empleado, configurable desde
        Ajustes > Empleados > Documentos. Si no hay ninguna configurada (parámetro borrado a
        mano), recae en la carpeta 'Empleados' creada por defecto en los datos del módulo.
        """
        ConfigParameter = self.env["ir.config_parameter"].sudo()
        parent_id = ConfigParameter.get_param("dfd_documents.employee_folder_parent_id")
        root_folder = self.env["document.folder"].browse(int(parent_id)) if parent_id else self.env["document.folder"]
        if not root_folder.exists():
            root_folder = self.env.ref("dfd_documents.document_folder_empleados")
        return root_folder

    def x_sync_default_folders(self):
        """Crea o completa la estructura de carpetas por defecto de cada empleado en `self`.

        Si el empleado no tiene carpeta, la crea desde cero con todas las subcarpetas
        configuradas. Si ya la tiene, comprueba cuáles de las subcarpetas configuradas le
        faltan (por nombre) y crea solo esas; nunca elimina carpetas existentes.
        """
        root_folder = self.x_get_employee_folder_parent()
        default_folders = self.env["document.employee.default.folder"].search([])
        DocumentFolder = self.env["document.folder"]
        for employee in self:
            employee_folder = employee.x_document_folder_id
            if not employee_folder:
                # allowed_employee_ids: el propio empleado queda con acceso automático a su
                # carpeta desde el momento en que se crea, sin tener que pasar luego por el
                # wizard de Permisos a mano. Si el empleado aún no tiene user_id asignado esto
                # no da acceso a nadie todavía (ver document_folder.py), pero queda ya marcado
                # para cuando se le asigne uno.
                employee_folder = DocumentFolder.create({
                    "name": employee.name,
                    "parent_id": root_folder.id,
                    "allowed_employee_ids": [(6, 0, employee.ids)],
                })
                employee.x_document_folder_id = employee_folder.id

            existing_names = set(employee_folder.child_ids.mapped("name"))
            missing_folders = default_folders.filtered(lambda f: f.name not in existing_names)
            if missing_folders:
                DocumentFolder.create([
                    {"name": default_folder.name, "parent_id": employee_folder.id}
                    for default_folder in missing_folders
                ])
