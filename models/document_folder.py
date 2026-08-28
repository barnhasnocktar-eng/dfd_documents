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
    allowed_employee_ids = fields.Many2many(
        "hr.employee",
        "document_folder_allowed_employee_rel",
        "folder_id",
        "employee_id",
        string="Empleados permitidos",
        help="Empleados con acceso a esta carpeta y a su contenido a través de su usuario "
        "relacionado, además de los ya permitidos por grupo o heredados de alguna carpeta "
        "antepasada. Un empleado sin usuario relacionado no obtiene acceso por esta vía "
        "hasta que se le asigne uno.",
    )
    effective_employee_ids = fields.Many2many(
        "hr.employee",
        "document_folder_effective_employee_rel",
        "folder_id",
        "employee_id",
        string="Empleados con acceso (heredado)",
        compute="_compute_effective_group_ids",
        store=True,
        recursive=True,
        help="Unión de los empleados permitidos de esta carpeta y de todas sus antepasadas.",
    )
    is_ancestor_of_accessible = fields.Boolean(
        string="Es antepasada de una carpeta accesible",
        compute="_compute_is_ancestor_of_accessible",
        search="_search_is_ancestor_of_accessible",
        help="Técnico: True si el usuario actual no tiene acceso real a esta carpeta pero sí "
        "a alguna de sus descendientes, para poder mostrarla en modo solo lectura como parte "
        "del camino de navegación (ver `ir.rule` de lectura en data/access_permissions.xml).",
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
        # padre: renombrar/mover, is_locked y allowed_group_ids/allowed_employee_ids (los
        # propios permisos de la carpeta también se gestionan "desde fuera", no desde dentro
        # de ella misma).
        guarded_folders = renamed_or_moved
        if vals.keys() & {"is_locked", "allowed_group_ids", "allowed_employee_ids"}:
            guarded_folders |= self
        guarded_folders._check_can_manage_self()
        return super().write(vals)

    def unlink(self):
        if self.filtered("is_locked"):
            raise UserError("No puedes editar o mover esta carpeta.")
        self._check_can_manage_self()
        return super().unlink()

    def _check_can_manage_self(self):
        """Versión que lanza `UserError` de `_can_manage_self()` (ver ahí la explicación
        completa de la regla). Se usa en los puntos donde el rechazo debe cortar la
        operación (`write`/`unlink`/`default_get` del wizard de permisos)."""
        not_allowed = self.filtered(lambda f: not f._can_manage_self())
        if not_allowed:
            raise UserError(
                "No tienes permiso para modificar esta carpeta. "
                "El permiso sobre una carpeta da acceso a su contenido, no a la carpeta en sí."
            )

    def _can_manage_self(self):
        """True si el usuario actual puede renombrar/mover/bloquear/eliminar `self` (una
        sola carpeta) o cambiar sus propios `allowed_group_ids`/`allowed_employee_ids`.

        El grupo o empleado permitido en una carpeta da acceso a su CONTENIDO (subcarpetas
        y documentos), nunca a la carpeta misma: hace falta grupo o empleado permitido en
        su carpeta PADRE (o `base.group_system`), igual que para crear algo dentro de ese
        padre. Sin padre (carpeta de primer nivel) solo puede tocarla `base.group_system`.
        Usado también desde el JS (vía `can_manage_folder`) para decidir si mostrar las
        acciones "Renombrar"/"Eliminar" del cogMenu sobre la carpeta activa.
        """
        self.ensure_one()
        if self.env.user.has_group("base.group_system"):
            return True
        user = self.env.user
        parent = self.parent_id
        if parent:
            allowed_group_ids = set(parent.effective_group_ids.ids)
            allowed_user_ids = set(parent.effective_employee_ids.user_id.ids)
        else:
            allowed_group_ids = set(self._get_always_allowed_groups().ids)
            allowed_user_ids = set()
        has_group = bool(set(user.groups_id.ids) & allowed_group_ids)
        has_employee = user.id in allowed_user_ids
        return has_group or has_employee

    @api.model
    def can_manage_folder(self, folder_id):
        """Envoltorio RPC de `_can_manage_self()` para un folder_id concreto, usado por el
        cogMenu (JS) para decidir si mostrar "Renombrar"/"Eliminar" sobre la carpeta activa."""
        return self.browse(folder_id)._can_manage_self()

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

    @api.depends(
        "allowed_group_ids", "parent_id.effective_group_ids",
        "allowed_employee_ids", "parent_id.effective_employee_ids",
    )
    def _compute_effective_group_ids(self):
        always_allowed = self._get_always_allowed_groups()
        for folder in self:
            if folder.parent_id:
                inherited_groups = folder.parent_id.effective_group_ids
                inherited_employees = folder.parent_id.effective_employee_ids
            else:
                inherited_groups = always_allowed
                inherited_employees = self.env["hr.employee"]
            folder.effective_group_ids = inherited_groups | folder.allowed_group_ids | always_allowed
            folder.effective_employee_ids = inherited_employees | folder.allowed_employee_ids

    def _is_accessible_by_current_user(self):
        """True si el usuario actual pertenece a algún grupo efectivo, o es el usuario
        relacionado de algún empleado efectivo (propio o heredado), de `self`."""
        self.ensure_one()
        user_group_ids = set(self.env.user.groups_id.ids)
        if user_group_ids & set(self.effective_group_ids.ids):
            return True
        return self.env.user.id in self.effective_employee_ids.user_id.ids

    def _compute_is_ancestor_of_accessible(self):
        """Ver ayuda del campo `is_ancestor_of_accessible`. No depends() a propósito: es
        `search`-only en la práctica (siempre se filtra antes de listar), pero Odoo exige
        que todo campo compute también sepa calcularse por si se lee directamente."""
        is_admin = self.env.user.has_group("base.group_system")
        for folder in self:
            folder.is_ancestor_of_accessible = (
                not is_admin
                and not folder._is_accessible_by_current_user()
                and folder._has_accessible_descendant()
            )

    def _has_accessible_descendant(self):
        """True si alguna carpeta descendiente de `self` (sin incluirla) es accesible
        (grupo o empleado efectivo) para el usuario actual. `sudo()` porque este chequeo
        debe poder atravesar carpetas que la `ir.rule` normal ocultaría a este mismo
        usuario (son precisamente las hermanas por las que no debe pasar la respuesta,
        pero sí necesita poder MIRARLAS para saber que no dan acceso)."""
        self.ensure_one()
        user = self.env.user
        descendant_domain = [
            ("id", "child_of", self.id),
            ("id", "!=", self.id),
            "|",
            ("effective_group_ids", "in", user.groups_id.ids),
            ("effective_employee_ids.user_id", "=", user.id),
        ]
        return bool(self.env["document.folder"].sudo().search_count(descendant_domain))

    @api.model
    def _search_is_ancestor_of_accessible(self, operator, value):
        """Traduce `is_ancestor_of_accessible = True/False` a un domain evaluable en SQL:
        "soy antepasada de una carpeta accesible" equivale a "alguna carpeta accesible tiene
        mi id en su `parent_path`", que es exactamente `id = parent_of <accesibles>` invertido
        a través de `child_ids` recursivo. Se resuelve en Python por simplicidad (volumen de
        carpetas esperado bajo, ver `get_folder_tree`) y se devuelve como `id in (...)`.
        """
        want_true = (operator == "=" and value) or (operator == "!=" and not value)
        user = self.env.user
        if user.has_group("base.group_system"):
            ancestor_ids = []
        else:
            accessible_ids = self.sudo().search([
                "|",
                ("effective_group_ids", "in", user.groups_id.ids),
                ("effective_employee_ids.user_id", "=", user.id),
            ]).ids
            ancestor_ids = set()
            for folder in self.sudo().browse(accessible_ids):
                if folder.parent_path:
                    ancestor_ids.update(int(i) for i in folder.parent_path.split("/") if i)
            ancestor_ids -= set(accessible_ids)
            ancestor_ids = list(ancestor_ids)

        return [("id", "in", ancestor_ids)] if want_true else [("id", "not in", ancestor_ids)]

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
