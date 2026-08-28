# Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
# Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso
from odoo import fields, models


class EmployeeDefaultFolder(models.Model):
    _name = "document.employee.default.folder"
    _description = "Carpeta por defecto de empleados"
    _order = "sequence, name"

    name = fields.Char(string="Nombre", required=True)
    sequence = fields.Integer(string="Secuencia", default=10)
