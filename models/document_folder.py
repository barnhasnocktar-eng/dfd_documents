# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


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
    is_locked = fields.Boolean(
        string="Bloqueada",
        default=False,
        help="Si está marcado, la carpeta no se puede renombrar, mover ni eliminar. Sí se pueden crear carpetas o documentos dentro.",
    )
    allowed_group_ids = fields.Many2many(
        "res.groups",
        "document_folder_allowed_group_rel",
        "folder_id",
        "group_id",
        string="Grupos permitidos",
        help="Grupos con acceso a esta carpeta y a su contenido, además de los que ya tengan "
        "acceso por ser grupo permitido de alguna carpeta antepasada. Los grupos de sistema "
        "(p. ej. Administración/Ajustes técnicos) siempre tienen acceso, estén o no en esta lista.",
    )
    effective_group_ids = fields.Many2many(
        "res.groups",
        "document_folder_effective_group_rel",
        "folder_id",
        "group_id",
        string="Grupos con acceso (heredado)",
        compute="_compute_effective_group_ids",
        store=True,
        recursive=True,
        help="Unión de los grupos permitidos de esta carpeta y de todas sus antepasadas, "
        "más los grupos de sistema siempre presentes.",
    )

    def write(self, vals):
        # Corta aquí (y no solo en move_folder/rename wizard/wizard de permisos) para cubrir
        # también el form nativo y cualquier otra vía de escritura; permite crear contenido
        # dentro, solo bloquea la propia carpeta.
        # name/parent_id se comparan contra el valor actual antes de bloquear: la carga de datos
        # XML (noupdate="0") reescribe esos dos en cada actualización del módulo aunque no
        # cambien, y eso no debe chocar contra el bloqueo (solo tiene sentido ante cambio real).
        # is_locked/allowed_group_ids no los toca ninguna carga XML idempotente, así que ahí
        # basta con que la clave esté presente en vals.
        rename_or_move_keys = vals.keys() & {"name", "parent_id"}
        renamed_or_moved = self.filtered(
            lambda f: any(
                (f[key].id if key == "parent_id" else f[key]) != vals[key]
                for key in rename_or_move_keys
            )
        ) if rename_or_move_keys else self.browse()

        locked = renamed_or_moved.filtered("is_locked")
        if locked:
            raise UserError("No puedes editar o mover esta carpeta.")

        # Cambios que afectan a la carpeta en sí (no a su contenido) exigen permiso en el
        # padre: renombrar/mover, is_locked y allowed_group_ids (los propios permisos de la
        # carpeta también se gestionan "desde fuera", no desde dentro de ella misma).
        guarded_folders = renamed_or_moved
        if vals.keys() & {"is_locked", "allowed_group_ids"}:
            guarded_folders |= self
        guarded_folders._check_can_manage_self()
        return super().write(vals)

    def unlink(self):
        if self.filtered("is_locked"):
            raise UserError("No puedes editar o mover esta carpeta.")
        self._check_can_manage_self()
        return super().unlink()

    def _check_can_manage_self(self):
        """El grupo permitido en una carpeta da acceso a su CONTENIDO (subcarpetas y
        documentos), nunca a la carpeta misma: para renombrarla, moverla, bloquearla,
        eliminarla o cambiar sus propios `allowed_group_ids` hace falta grupo permitido
        en su carpeta PADRE (o `base.group_system`), igual que para crear algo dentro
        de ese padre. Sin padre (carpeta de primer nivel) solo puede tocarla `base.group_system`.
        """
        if self.env.user.has_group("base.group_system"):
            return
        user_group_ids = set(self.env.user.groups_id.ids)
        for folder in self:
            parent = folder.parent_id
            allowed_ids = set(parent.effective_group_ids.ids) if parent else set(
                self._get_always_allowed_groups().ids
            )
            if not (user_group_ids & allowed_ids):
                raise UserError(
                    "No tienes permiso para modificar esta carpeta. "
                    "El permiso sobre una carpeta da acceso a su contenido, no a la carpeta en sí."
                )

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

    @api.model
    def _get_always_allowed_groups(self):
        """Grupos de sistema que siempre tienen acceso a cualquier carpeta, tenga o no
        grupos permitidos propios asignados (p. ej. Administración/Ajustes técnicos)."""
        return self.env.ref("base.group_system")

    @api.depends("allowed_group_ids", "parent_id.effective_group_ids")
    def _compute_effective_group_ids(self):
        always_allowed = self._get_always_allowed_groups()
        for folder in self:
            if folder.parent_id:
                inherited = folder.parent_id.effective_group_ids
            else:
                inherited = always_allowed
            folder.effective_group_ids = inherited | folder.allowed_group_ids | always_allowed

    def _is_accessible_by_current_user(self):
        """True si el usuario actual pertenece a algún grupo efectivo (propio o heredado) de `self`."""
        self.ensure_one()
        user_group_ids = set(self.env.user.groups_id.ids)
        return bool(user_group_ids & set(self.effective_group_ids.ids))

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
