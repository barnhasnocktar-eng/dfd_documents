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
    parent_id = fields.Many2one(
        "document.folder",
        string="Carpeta padre",
        ondelete="cascade",
        index=True,
    )
    child_ids = fields.One2many("document.folder", "parent_id", string="Subcarpetas")
    file_ids = fields.One2many("document.file", "folder_id", string="Documentos")
    parent_path = fields.Char(index=True, unaccent=False)
    child_count = fields.Integer(string="Nº de subcarpetas", compute="_compute_child_count")
    file_count = fields.Integer(string="Nº de documentos", compute="_compute_file_count")

    @api.depends("child_ids")
    def _compute_child_count(self):
        for folder in self:
            folder.child_count = len(folder.child_ids)

    @api.depends("file_ids")
    def _compute_file_count(self):
        for folder in self:
            folder.file_count = len(folder.file_ids)

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

    @api.model
    def move_folder(self, folder_id, target_folder_id):
        """Anida `folder_id` dentro de `target_folder_id` (drag&drop de carpeta sobre carpeta en el kanban).

        Rechaza mover una carpeta sobre sí misma o sobre una de sus propias subcarpetas
        (evitaría la recursividad ya cubierta por `_check_parent_recursion`, pero se corta
        antes para devolver un error claro al JS en vez de una ValidationError genérica).
        """
        folder = self.browse(folder_id)
        target = self.browse(target_folder_id)
        if folder == target:
            raise ValidationError("Una carpeta no se puede mover dentro de sí misma.")
        if target.parent_path and folder.parent_path and target.parent_path.startswith(folder.parent_path):
            raise ValidationError("No se puede mover una carpeta dentro de una de sus propias subcarpetas.")
        folder.write({"parent_id": target.id})

    @api.model
    def get_folder_tree(self):
        """Devuelve todas las carpetas (id, name, parent_id) para pintar el árbol lateral completo.

        Una sola llamada en vez de expandir bajo demanda: el volumen esperado de carpetas
        es pequeño y así el JS arma el árbol entero en cliente sin ida y vuelta por nodo.
        """
        folders = self.search_read([], ["name", "parent_id"])
        for folder in folders:
            folder["parent_id"] = folder["parent_id"][0] if folder["parent_id"] else False
        return folders

    @api.model
    def search_and_go(self, search_term):
        """Resuelve el texto tecleado en el buscador del kanban de carpetas.

        Si hace match con una carpeta, devuelve la acción para entrar en ella. Si hace
        match con un documento (document.file), devuelve la acción de la carpeta que lo
        contiene. Ante varios resultados se queda con el primero (orden alfabético por
        nombre). Sin ningún match devuelve False, para que el JS avise "sin resultados".
        """
        folder = self.search([("name", "ilike", search_term)], order="name", limit=1)
        if folder:
            return self._get_kanban_action(folder.id)
        document = self.env["document.file"].search(
            [("name", "ilike", search_term)], order="name", limit=1
        )
        if document:
            return self._get_kanban_action(document.folder_id.id)
        return False

    @api.model
    def create_from_upload_tree(self, tree, folder_id):
        """Recrea recursivamente en `folder_id` un árbol de carpetas/archivos subido por drag&drop.

        `tree` es una lista de nodos {"type": "file"|"folder", "name": ..., "data": <base64>,
        "children": [...]} tal como lo construye el JS al recorrer los DataTransferItem con
        webkitGetAsEntry(). Reutiliza document.file.create_from_upload para cada archivo.
        """
        DocumentFile = self.env["document.file"]
        for node in tree:
            if node.get("type") == "folder":
                subfolder = self.create({
                    "name": node.get("name"),
                    "parent_id": folder_id,
                })
                self.create_from_upload_tree(node.get("children") or [], subfolder.id)
            else:
                DocumentFile.create_from_upload(node.get("name"), node.get("data"), folder_id)
