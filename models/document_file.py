# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import ValidationError

# Valores por defecto (en MB) de los límites de subida, usados cuando el parámetro del sistema
# correspondiente no está configurado. El proveedor los edita en Ajustes > Empleados >
# Documentos (ver res_config_settings.py), en MB para no obligarle a pensar en bytes.
DEFAULT_MAX_UPLOAD_SIZE_MB = 10
DEFAULT_MAX_TOTAL_STORAGE_SIZE_MB = 100


def get_max_upload_size(env):
    """Límite en bytes para una subida por drag&drop: un archivo suelto, o la suma de todos
    los archivos de una carpeta arrastrada (ver document_folder.create_from_upload_tree)."""
    mb = env["ir.config_parameter"].sudo().get_param(
        "dfd_documents.max_upload_size_mb", default=DEFAULT_MAX_UPLOAD_SIZE_MB
    )
    return int(float(mb) * 1024 * 1024)


def get_max_upload_size_message(env):
    mb = get_max_upload_size(env) / (1024 * 1024)
    mb_label = f"{mb:g}"
    return f"El tamaño máximo permitido para un archivo o carpeta es de {mb_label}MB"


def get_max_total_storage_size(env):
    """Límite en bytes del espacio total ocupado por todos los document.file de la instancia
    (suma de file_size de sus adjuntos). Una subida que deje el total por encima de este tope
    se rechaza entera, aunque el archivo/carpeta en sí cumpla get_max_upload_size."""
    mb = env["ir.config_parameter"].sudo().get_param(
        "dfd_documents.max_total_storage_size_mb", default=DEFAULT_MAX_TOTAL_STORAGE_SIZE_MB
    )
    return int(float(mb) * 1024 * 1024)


MAX_TOTAL_STORAGE_SIZE_MESSAGE = (
    "Subir este archivo excede el máximo total permitido. "
    "Contacte con su proveedor si desea aumentar este límite"
)


def get_base64_size(data):
    """Tamaño real en bytes (decodificado) de un string en base64.

    Evita decodificar todo el contenido en memoria: base64 codifica cada 3 bytes en 4
    caracteres, así que el tamaño real se calcula a partir de la longitud del string y su
    padding ('=' al final), sin llamar a base64.b64decode sobre el archivo completo.
    """
    if not data:
        return 0
    padding = len(data) - len(data.rstrip("="))
    return (len(data) * 3) // 4 - padding


class DocumentFile(models.Model):
    _name = "document.file"
    _description = "Documento dentro de una carpeta"
    _order = "name"

    name = fields.Char(string="Nombre", required=True)
    folder_id = fields.Many2one(
        "document.folder",
        string="Carpeta",
        required=True,
        ondelete="cascade",
        index=True,
    )
    attachment_id = fields.Many2one(
        "ir.attachment",
        string="Adjunto",
        required=True,
        ondelete="cascade",
    )
    mimetype = fields.Char(related="attachment_id.mimetype", string="Tipo de archivo", readonly=True)
    file_size = fields.Integer(related="attachment_id.file_size", string="Tamaño", readonly=True)
    effective_group_ids = fields.Many2many(
        "res.groups",
        related="folder_id.effective_group_ids",
        string="Grupos con acceso (heredado)",
    )
    effective_employee_ids = fields.Many2many(
        "hr.employee",
        related="folder_id.effective_employee_ids",
        string="Empleados con acceso (heredado)",
    )

    @api.model_create_multi
    def create(self, vals_list):
        documents = super().create(vals_list)
        for document in documents:
            document._log_movement("create", "Documento creado")
        return documents

    def write(self, vals):
        snapshots = self._prepare_movement_log_snapshots(vals)
        result = super().write(vals)
        self._write_movement_logs(snapshots)
        return result

    def unlink(self):
        # attachment_id es ondelete="cascade": Odoo gestiona esa cascada él mismo en la capa
        # ORM (no es solo la FK de Postgres), así que super().unlink() ya borra también el
        # ir.attachment asociado. No hace falta (ni hay que) borrarlo aquí explícitamente:
        # intentarlo después de super().unlink() sale con "el registro no existe", porque
        # Odoo ya lo borró como parte de la cascada.
        for document in self:
            document._log_movement("unlink", "Documento eliminado")
        return super().unlink()

    def _get_movement_log_path(self):
        """Ruta legible tipo 'Documentos / Empleados / Juan / archivo.pdf'."""
        self.ensure_one()
        folder_path = " / ".join(self.folder_id.get_path().mapped("name")) if self.folder_id else ""
        return f"{folder_path} / {self.name}" if folder_path else self.name

    def _log_movement(self, event_type, description):
        """Crea una entrada de `document.movement.log` para `self` (un solo documento).
        Ver equivalente en `DocumentFolder._log_movement` para el porqué del `sudo()`."""
        self.ensure_one()
        self.env["document.movement.log"].sudo().create({
            "event_type": event_type,
            "res_model": self._name,
            "res_id": self.id,
            "res_name": self.name,
            "folder_path": self._get_movement_log_path(),
            "user_id": self.env.user.id,
            "description": description,
        })

    def _prepare_movement_log_snapshots(self, vals):
        """Snapshot "antes" de nombre/carpeta, tomado antes de `super().write()`."""
        if not (vals.keys() & {"name", "folder_id"}):
            return []
        return [
            {
                "document_id": document.id,
                "old_name": document.name,
                "old_path": document._get_movement_log_path(),
            }
            for document in self
        ]

    def _write_movement_logs(self, snapshots):
        """Compara el snapshot "antes" contra el estado ya escrito y loguea rename/move."""
        if not snapshots:
            return
        by_id = {snap["document_id"]: snap for snap in snapshots}
        documents = self.browse(list(by_id.keys()))
        for document in documents:
            snap = by_id[document.id]
            if snap["old_name"] != document.name:
                document._log_movement(
                    "rename", f"Renombrado de «{snap['old_name']}» a «{document.name}»"
                )
            new_path = document._get_movement_log_path()
            if snap["old_path"] != new_path:
                document._log_movement(
                    "move", f"Movido de «{snap['old_path']}» a «{new_path}»"
                )

    @api.model
    def get_total_storage_size(self):
        """Suma en bytes de todos los adjuntos de document.file ya existentes en la instancia."""
        result = self.env["ir.attachment"].sudo().read_group(
            [("res_model", "=", self._name)], ["file_size:sum"], []
        )
        return (result[0]["file_size"] if result else 0) or 0

    @api.model
    def get_storage_usage(self):
        """Uso total de espacio para pintar la barra de progreso del árbol de carpetas:
        bytes usados, límite total y porcentaje (0-100, tope en 100 aunque used > max por
        alguna carrera de condición entre validación y creación concurrente)."""
        used = self.get_total_storage_size()
        max_size = get_max_total_storage_size(self.env)
        return {
            "used": used,
            "max": max_size,
            "percent": min(100, round(used * 100 / max_size, 1)) if max_size else 0,
        }

    @api.model
    def get_upload_limits(self):
        """Límites de subida configurados (ver Ajustes > Empleados > Documentos), para que el
        cliente valide antes de leer archivos sin duplicar los valores por defecto en JS."""
        return {
            "max_upload_size": get_max_upload_size(self.env),
            "max_upload_size_message": get_max_upload_size_message(self.env),
        }

    @api.model
    def create_from_upload(self, name, data, folder_id):
        """Crea el adjunto y el documento a partir de un archivo subido por drag&drop en el kanban.

        `data` llega en base64 (tal cual lo produce FileReader.readAsDataURL recortando el prefijo
        'data:...;base64,' en el cliente).
        """
        size = get_base64_size(data)
        if size > get_max_upload_size(self.env):
            raise ValidationError(get_max_upload_size_message(self.env))
        if self.get_total_storage_size() + size > get_max_total_storage_size(self.env):
            raise ValidationError(MAX_TOTAL_STORAGE_SIZE_MESSAGE)
        attachment = self.env["ir.attachment"].create({
            "name": name,
            "datas": data,
            "res_model": self._name,
            "public": False,
        })
        document_file = self.create({
            "name": name,
            "folder_id": folder_id,
            "attachment_id": attachment.id,
        })
        attachment.res_id = document_file.id
        return document_file.id

    @api.model
    def move_file(self, file_id, target_folder_id):
        """Mueve el documento `file_id` a `target_folder_id` (drag&drop de documento sobre carpeta en el kanban).

        `folder_id` es obligatorio en el modelo, así que sin este check un `target_folder_id`
        vacío (soltar sobre la raíz) fallaría con el error genérico de campo requerido.
        """
        if not target_folder_id:
            raise ValidationError("No puedes meter documentos en la carpeta raíz.")
        self.browse(file_id).write({"folder_id": target_folder_id})

    def action_download(self):
        """Descarga el adjunto asociado al documento (invocado al pulsar la tarjeta en el kanban)."""
        self.ensure_one()
        return {
            "type": "ir.actions.act_url",
            "url": f"/web/content/{self.attachment_id.id}?download=true",
            "target": "download",
        }
