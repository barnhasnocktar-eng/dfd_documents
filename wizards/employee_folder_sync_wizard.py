# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import models


class EmployeeFolderSyncWizard(models.TransientModel):
    _name = "document.employee.folder.sync.wizard"
    _description = "Asistente para crear/completar las carpetas de documentos de los empleados"

    def action_sync_folders(self):
        self.env["hr.employee"].search([]).x_sync_default_folders()
        return {"type": "ir.actions.client", "tag": "reload"}
