# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models


class DocumentFolderCreateWizard(models.TransientModel):
    _name = "document.folder.create.wizard"
    _description = "Asistente para crear una nueva carpeta"

    name = fields.Char(string="Nombre", required=True)
    parent_id = fields.Many2one("document.folder", string="Carpeta padre")

    @api.model
    def default_get(self, fields_list):
        # Precarga la carpeta padre según el contexto de navegación actual (nivel del kanban abierto)
        res = super().default_get(fields_list)
        active_folder_id = self.env.context.get("active_folder_id")
        if active_folder_id and "parent_id" in fields_list:
            res["parent_id"] = active_folder_id
        return res

    def action_create_folder(self):
        self.ensure_one()
        self.env["document.folder"].create({
            "name": self.name,
            "parent_id": self.parent_id.id,
        })
        return {"type": "ir.actions.act_window_close"}
