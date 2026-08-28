# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import api, fields, models
from odoo.exceptions import ValidationError


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

    @api.model
    def create_from_upload(self, name, data, folder_id):
        """Crea el adjunto y el documento a partir de un archivo subido por drag&drop en el kanban.

        `data` llega en base64 (tal cual lo produce FileReader.readAsDataURL recortando el prefijo
        'data:...;base64,' en el cliente).
        """
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
