/** @odoo-module **/
// Copyright 2026 Vértice Operativo <soporte@verticeoperativo.com>
// Todos los derechos reservados. Está prohibido la distribución o modificación de este código sin permiso

import { Component, useState, onWillStart, onMounted, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { dragState, callMoveItem, getMoveErrorMessage } from "@dfd_documents/js/document_folder_drag_state";
import { documentFolderBus } from "@dfd_documents/js/document_folder_bus";

// Panel lateral tipo "árbol de carpetas" (estilo explorador de archivos de Windows): pinta
// todas las carpetas anidadas con expand/collapse, permite navegar con un click y aceptar
// sueltos de carpeta o documento (arrastrados desde el grid o el breadcrumb) para moverlos
// dentro de cualquier nodo del árbol, sea ancestro, hijo o rama distinta, sin límite de nivel.
export class DocumentFolderTreeSidebar extends Component {
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.state = useState({ nodesById: {}, rootIds: [], expanded: {}, dragOverFolderId: undefined });

        onWillStart(async () => {
            await this.loadTree();
        });

        // Recarga el árbol cuando otro componente (kanban al borrar una carpeta, el wizard al
        // crearla) avisa un cambio de estructura que este panel no originó él mismo.
        this._onFolderTreeChanged = () => this.loadTree();
        onMounted(() => {
            documentFolderBus.addEventListener("folder-tree-changed", this._onFolderTreeChanged);
        });
        onWillUnmount(() => {
            documentFolderBus.removeEventListener("folder-tree-changed", this._onFolderTreeChanged);
        });
    }

    async loadTree() {
        const folders = await this.orm.call("document.folder", "get_folder_tree", []);
        const nodesById = {};
        const rootIds = [];
        for (const folder of folders) {
            nodesById[folder.id] = { ...folder, childIds: [] };
        }
        for (const folder of folders) {
            if (folder.parent_id && nodesById[folder.parent_id]) {
                nodesById[folder.parent_id].childIds.push(folder.id);
            } else {
                rootIds.push(folder.id);
            }
        }
        this.state.nodesById = nodesById;
        this.state.rootIds = rootIds;
        this.expandAncestors(this.props.activeFolderId);
    }

    // Despliega la rama hasta la carpeta activa para que el árbol la muestre visible al entrar.
    expandAncestors(folderId) {
        let current = folderId ? this.state.nodesById[folderId] : null;
        while (current) {
            this.state.expanded[current.id] = true;
            current = current.parent_id ? this.state.nodesById[current.parent_id] : null;
        }
    }

    isExpanded(folderId) {
        return !!this.state.expanded[folderId];
    }

    toggleExpanded(ev, folderId) {
        ev.stopPropagation();
        this.state.expanded[folderId] = !this.state.expanded[folderId];
    }

    get activeFolderId() {
        return this.props.activeFolderId || false;
    }

    async goTo(folderId) {
        const action = await this.orm.call("document.folder", "action_go_to_folder", [folderId]);
        await this.action.doAction(action, { clearBreadcrumbs: true });
    }

    // Arranque de drag propio del árbol (arrastrar un nodo del árbol hacia otro nodo, o hacia
    // el grid/breadcrumb): comparte el mismo singleton dragState que kanban y breadcrumb.
    onNodeDragStart(ev, folderId) {
        dragState.item = { type: "folder", id: folderId };
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("application/x-dfd-item", "1");
    }

    onNodeDragEnd() {
        dragState.item = null;
        this.state.dragOverFolderId = undefined;
    }

    onNodeDragOver(ev, folderId) {
        if (!dragState.item) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const isSameFolder = dragState.item.type === "folder" && dragState.item.id === folderId;
        this.state.dragOverFolderId = isSameFolder ? undefined : folderId;
    }

    onNodeDragLeave() {
        this.state.dragOverFolderId = undefined;
    }

    async onNodeDrop(ev, folderId) {
        if (!dragState.item || this.state.dragOverFolderId === undefined) {
            dragState.item = null;
            this.state.dragOverFolderId = undefined;
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const item = dragState.item;
        dragState.item = null;
        this.state.dragOverFolderId = undefined;
        try {
            await callMoveItem(this.orm, item, folderId);
        } catch (error) {
            const message = getMoveErrorMessage(error) ||
                (item.type === "folder" ? _t("No se pudo mover la carpeta.") : _t("No se pudo mover el documento."));
            this.notification.add(message, { type: "danger" });
            return;
        }
        await this.loadTree();
        // Recarga siempre la carpeta activa: el elemento movido puede haber salido de ella
        // (kanban y breadcrumb dependen de esta misma acción para refrescarse).
        await this.goTo(this.activeFolderId);
    }
}
DocumentFolderTreeSidebar.template = "dfd_documents.DocumentFolderTreeSidebar";
DocumentFolderTreeSidebar.props = { activeFolderId: { type: [Number, Boolean], optional: true } };
