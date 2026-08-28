/** @odoo-module **/
// Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
// Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso

import { reactive } from "@odoo/owl";

// Estado compartido entre todos los componentes que participan en el drag&drop de carpetas o
// documentos (grid kanban, breadcrumb superior y árbol lateral): son componentes hermanos sin
// relación padre-hijo, así que se comunican por este singleton reactivo en vez de por props.
// Solo vive el tiempo del drag en curso.
export const dragState = reactive({ item: null });

// Llama al método ORM que mueve `item` (carpeta o documento) a `targetFolderId`.
export async function callMoveItem(orm, item, targetFolderId) {
    const { type, id } = item;
    if (type === "folder") {
        await orm.call("document.folder", "move_folder", [id, targetFolderId]);
    } else {
        await orm.call("document.file", "move_file", [id, targetFolderId]);
    }
}
