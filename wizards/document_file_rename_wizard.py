# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import UserError


class DocumentFileRenameWizard(models.TransientModel):
    _name = "document.file.rename.wizard"
    _description = "Asistente para renombrar el documento actual"

    file_id = fields.Many2one("document.file", string="Documento", required=True)
    name = fields.Char(string="Nombre", required=True)

    @api.model
    def default_get(self, fields_list):
        # Precarga el documento activo (pulsado en el kanban) y su nombre actual, igual mecanismo
        # que DocumentFolderRenameWizard pero leyendo active_file_id en vez de active_folder_id.
        res = super().default_get(fields_list)
        active_file_id = self.env.context.get("active_file_id")
        if not active_file_id:
            raise UserError("No se ha indicado el documento a renombrar.")
        if "file_id" in fields_list:
            res["file_id"] = active_file_id
        if "name" in fields_list:
            res["name"] = self.env["document.file"].browse(active_file_id).name
        return res

    def action_rename_file(self):
        self.ensure_one()
        self.file_id.write({"name": self.name})
        return {"type": "ir.actions.act_window_close"}
