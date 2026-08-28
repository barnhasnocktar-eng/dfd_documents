# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import UserError


class DocumentFolderRenameWizard(models.TransientModel):
    _name = "document.folder.rename.wizard"
    _description = "Asistente para renombrar la carpeta actual"

    folder_id = fields.Many2one("document.folder", string="Carpeta", required=True)
    name = fields.Char(string="Nombre", required=True)

    @api.model
    def default_get(self, fields_list):
        # Precarga la carpeta activa (nivel del kanban abierto) y su nombre actual. La raíz de
        # Documentos no es un registro document.folder (active_folder_id llega a False ahí), así
        # que se corta con un aviso claro en vez de dejar el wizard abrirse sin carpeta que renombrar.
        res = super().default_get(fields_list)
        active_folder_id = self.env.context.get("active_folder_id")
        if not active_folder_id:
            raise UserError("La carpeta raíz de Documentos no se puede renombrar.")
        if "folder_id" in fields_list:
            res["folder_id"] = active_folder_id
        if "name" in fields_list:
            res["name"] = self.env["document.folder"].browse(active_folder_id).name
        return res

    def action_rename_folder(self):
        self.ensure_one()
        self.folder_id.write({"name": self.name})
        return {"type": "ir.actions.act_window_close"}
