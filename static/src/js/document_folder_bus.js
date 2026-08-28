/** @odoo-module **/
// Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
// Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso

// Bus de eventos compartido entre los componentes de la vista de carpetas (grid kanban, wizard
// de creación de carpeta y árbol lateral): son componentes hermanos o sin relación padre-hijo,
// así que usan este EventTarget para avisarse cambios de estructura (alta/baja de carpeta) que
// el árbol lateral debe reflejar aunque él no haya sido quien los originó.
export const documentFolderBus = new EventTarget();

// Dispara "folder-tree-changed" para que cualquier árbol lateral montado se recargue.
export function notifyFolderTreeChanged() {
    documentFolderBus.dispatchEvent(new Event("folder-tree-changed"));
}
