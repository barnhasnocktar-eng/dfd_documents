# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from dateutil.relativedelta import relativedelta

from odoo import api, fields, models


class DocumentMovementLog(models.Model):
    _name = "document.movement.log"
    _description = "Historial de movimientos de carpetas y documentos"
    _order = "date desc, id desc"

    # Sin Many2one hacia document.folder/document.file a propósito: esos registros se
    # pueden borrar (incluso en cascada), y esta tabla debe sobrevivir intacta a eso.
    # res_id/res_name/folder_path son "fotos" tomadas en el momento del evento.
    event_type = fields.Selection(
        [
            ("create", "Creación"),
            ("rename", "Renombrado"),
            ("move", "Movido"),
            ("lock", "Bloqueado"),
            ("unlock", "Desbloqueado"),
            ("permissions", "Cambio de permisos"),
            ("unlink", "Eliminado"),
        ],
        string="Tipo de evento",
        required=True,
    )
    res_model = fields.Selection(
        [
            ("document.folder", "Carpeta"),
            ("document.file", "Documento"),
        ],
        string="Modelo",
        required=True,
    )
    res_id = fields.Integer(string="ID del registro", required=True)
    res_name = fields.Char(string="Nombre", required=True)
    folder_path = fields.Char(string="Ruta")
    user_id = fields.Many2one("res.users", string="Usuario", ondelete="set null")
    date = fields.Datetime(string="Fecha", required=True, default=fields.Datetime.now)
    description = fields.Char(string="Descripción")
    detail = fields.Text(string="Detalle")

    @api.model
    def cron_clean_movement_logs(self):
        """Purga diaria de entradas antiguas del historial (ver ajuste "Días de retención
        del historial de movimientos" en Ajustes > Empleados). 0 desactiva la purga."""
        retention_days = int(
            self.env["ir.config_parameter"].sudo().get_param(
                "dfd_documents.movement_log_retention_days", default=30
            )
        )
        if retention_days <= 0:
            return
        threshold = fields.Datetime.now() - relativedelta(days=retention_days)
        old_logs = self.sudo().search([("date", "<", threshold)])
        old_logs.unlink()
