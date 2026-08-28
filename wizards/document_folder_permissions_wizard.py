# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import UserError


class DocumentFolderPermissionsWizard(models.TransientModel):
    _name = "document.folder.permissions.wizard"
    _description = "Asistente para gestionar los grupos y empleados permitidos de la carpeta actual"

    folder_id = fields.Many2one("document.folder", string="Carpeta", required=True)
    allowed_group_ids = fields.Many2many(
        "res.groups",
        string="Grupos permitidos",
        help="Grupos con acceso a esta carpeta y a su contenido, además de los grupos "
        "permitidos ya heredados de carpetas antepasadas y de los grupos de sistema, "
        "que siempre tienen acceso y no aparecen aquí porque no hace falta marcarlos.",
    )
    inherited_group_ids = fields.Many2many(
        "res.groups",
        relation="document_folder_permissions_wizard_inherited_group_rel",
        string="Grupos heredados (solo lectura)",
        help="Grupos con acceso a esta carpeta por ser grupo permitido de alguna carpeta "
        "antepasada. No se pueden quitar desde aquí: hay que editarlos en la carpeta antepasada.",
    )
    allowed_employee_ids = fields.Many2many(
        "hr.employee",
        string="Empleados permitidos",
        help="Empleados con acceso a esta carpeta y a su contenido a través de su usuario "
        "relacionado, además de los ya heredados de carpetas antepasadas. Un empleado sin "
        "usuario relacionado no obtiene acceso por esta vía hasta que se le asigne uno.",
    )
    inherited_employee_ids = fields.Many2many(
        "hr.employee",
        relation="document_folder_permissions_wizard_inherited_employee_rel",
        string="Empleados heredados (solo lectura)",
        help="Empleados con acceso a esta carpeta por ser empleado permitido de alguna carpeta "
        "antepasada. No se pueden quitar desde aquí: hay que editarlos en la carpeta antepasada.",
    )

    @api.model
    def default_get(self, fields_list):
        # Misma lógica que el wizard de renombrar: la raíz de Documentos no es un
        # document.folder real, así que no tiene permisos propios que gestionar aquí.
        res = super().default_get(fields_list)
        active_folder_id = self.env.context.get("active_folder_id")
        if not active_folder_id:
            raise UserError("La carpeta raíz de Documentos no tiene permisos que gestionar.")
        folder = self.env["document.folder"].browse(active_folder_id)
        folder._check_can_manage_self()
        if "folder_id" in fields_list:
            res["folder_id"] = folder.id
        if "allowed_group_ids" in fields_list:
            res["allowed_group_ids"] = [(6, 0, folder.allowed_group_ids.ids)]
        if "inherited_group_ids" in fields_list:
            parent_groups = folder.parent_id.effective_group_ids if folder.parent_id else self.env.ref("base.group_system")
            res["inherited_group_ids"] = [(6, 0, parent_groups.ids)]
        if "allowed_employee_ids" in fields_list:
            res["allowed_employee_ids"] = [(6, 0, folder.allowed_employee_ids.ids)]
        if "inherited_employee_ids" in fields_list:
            parent_employees = folder.parent_id.effective_employee_ids if folder.parent_id else self.env["hr.employee"]
            res["inherited_employee_ids"] = [(6, 0, parent_employees.ids)]
        return res

    def action_save_permissions(self):
        self.ensure_one()
        self.folder_id.write({
            "allowed_group_ids": [(6, 0, self.allowed_group_ids.ids)],
            "allowed_employee_ids": [(6, 0, self.allowed_employee_ids.ids)],
        })
        return {"type": "ir.actions.act_window_close"}
