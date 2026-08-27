# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import ValidationError


class DocumentFolder(models.Model):
    _name = "document.folder"
    _description = "Carpeta de documentos"
    _order = "name"
    _parent_store = True
    _parent_name = "parent_id"

    name = fields.Char(string="Nombre", required=True)
    description = fields.Text(string="Descripción")
    parent_id = fields.Many2one(
        "document.folder",
        string="Carpeta padre",
        ondelete="cascade",
        index=True,
    )
    child_ids = fields.One2many("document.folder", "parent_id", string="Subcarpetas")
    parent_path = fields.Char(index=True, unaccent=False)
    child_count = fields.Integer(string="Nº de subcarpetas", compute="_compute_child_count")

    @api.depends("child_ids")
    def _compute_child_count(self):
        for folder in self:
            folder.child_count = len(folder.child_ids)

    @api.constrains("parent_id")
    def _check_parent_recursion(self):
        if not self._check_recursion():
            raise ValidationError("No se puede crear una recursividad de carpetas.")

    def get_path(self):
        """Devuelve el camino de carpetas desde la raíz hasta esta carpeta (incluida), para el breadcrumb."""
        self.ensure_one()
        if not self.parent_path:
            return self
        ids = [int(i) for i in self.parent_path.split("/") if i]
        return self.browse(ids)

    @api.model
    def _get_kanban_action(self, folder_id=False):
        """Construye la acción kanban de carpetas situada en el nivel de folder_id (o raíz si es False)."""
        action = self.env["ir.actions.act_window"]._for_xml_id("dfd_documents.action_document_folder")
        action["domain"] = [("parent_id", "=", folder_id)]
        action["context"] = dict(self.env.context, active_folder_id=folder_id)
        return action

    def action_open_folder(self):
        """Navega dentro de la carpeta pulsada en el kanban (recarga la misma acción filtrando por su parent_id)."""
        self.ensure_one()
        return self._get_kanban_action(self.id)

    @api.model
    def action_go_to_folder(self, folder_id=False):
        """Navega a un nivel concreto del árbol (usado por el breadcrumb); sin folder_id navega a la raíz."""
        return self._get_kanban_action(folder_id)
