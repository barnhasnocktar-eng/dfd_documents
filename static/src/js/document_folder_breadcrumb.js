/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";
import { Component, onWillStart, useState, onMounted, onWillUnmount } from "@odoo/owl";
import { formatDate, deserializeDateTime } from "@web/core/l10n/dates";

// Formatea un tamaño en bytes a texto legible (KB/MB) para el subtexto de la tarjeta de documento.
function formatFileSize(bytes) {
    if (!bytes) {
        return "0 KB";
    }
    const units = ["bytes", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    const decimals = unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

// Ruta clicable (estilo explorador de archivos) mostrada sobre el kanban de carpetas.
export class DocumentFolderBreadcrumb extends Component {
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({ path: [] });

        onWillStart(async () => {
            await this.loadPath();
        });
    }

    async loadPath() {
        const folderId = this.props.activeFolderId;
        if (!folderId) {
            this.state.path = [];
            return;
        }
        const [folder] = await this.orm.read("document.folder", [folderId], ["parent_path"]);
        const ids = folder.parent_path
            ? folder.parent_path.split("/").filter(Boolean).map(Number)
            : [folderId];
        const records = await this.orm.read("document.folder", ids, ["name"]);
        const byId = Object.fromEntries(records.map((r) => [r.id, r]));
        this.state.path = ids.map((id) => byId[id]).filter(Boolean);
    }

    async goTo(folderId) {
        const action = await this.orm.call("document.folder", "action_go_to_folder", [folderId]);
        await this.action.doAction(action, { clearBreadcrumbs: true });
    }
}
DocumentFolderBreadcrumb.template = "dfd_documents.DocumentFolderBreadcrumb";
DocumentFolderBreadcrumb.props = { activeFolderId: { type: [Number, Boolean], optional: true } };

// Renderer que añade, junto a las carpetas nativas del kanban, las tarjetas de documento.file
// de la misma carpeta activa, y permite subir archivos arrastrándolos sobre el grid.
export class DocumentFolderKanbanRenderer extends KanbanRenderer {
    setup() {
        super.setup();
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.fileState = useState({ files: [], dragging: false });
        // this.rootRef ya lo define KanbanRenderer (useRef("root")) — se reutiliza tal cual.

        onWillStart(async () => {
            await this.loadFiles();
        });

        onMounted(() => {
            const el = this.rootRef.el;
            if (!el) {
                return;
            }
            this._onDragOver = (ev) => this.onDragOver(ev);
            this._onDragLeave = (ev) => this.onDragLeave(ev);
            this._onDrop = (ev) => this.onDrop(ev);
            el.addEventListener("dragover", this._onDragOver);
            el.addEventListener("dragleave", this._onDragLeave);
            el.addEventListener("drop", this._onDrop);
        });

        onWillUnmount(() => {
            const el = this.rootRef.el;
            if (!el) {
                return;
            }
            el.removeEventListener("dragover", this._onDragOver);
            el.removeEventListener("dragleave", this._onDragLeave);
            el.removeEventListener("drop", this._onDrop);
        });
    }

    get activeFolderId() {
        return this.props.list.context.active_folder_id || false;
    }

    async loadFiles() {
        const folderId = this.activeFolderId;
        const files = await this.orm.searchRead(
            "document.file",
            [["folder_id", "=", folderId]],
            ["name", "mimetype", "file_size", "create_date"]
        );
        this.fileState.files = files.map((file) => ({
            ...file,
            sizeLabel: formatFileSize(file.file_size),
            dateLabel: file.create_date ? formatDate(deserializeDateTime(file.create_date)) : "",
        }));
    }

    onDragOver(ev) {
        ev.preventDefault();
        this.fileState.dragging = true;
    }

    onDragLeave(ev) {
        ev.preventDefault();
        this.fileState.dragging = false;
    }

    async onDrop(ev) {
        ev.preventDefault();
        this.fileState.dragging = false;
        const files = [...(ev.dataTransfer?.files || [])];
        if (!files.length) {
            return;
        }
        for (const file of files) {
            await this.uploadFile(file);
        }
        await this.loadFiles();
    }

    uploadFile(file) {
        const folderId = this.activeFolderId;
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Data = reader.result.split(",")[1];
                try {
                    await this.orm.call("document.file", "create_from_upload", [
                        file.name,
                        base64Data,
                        folderId,
                    ]);
                    resolve();
                } catch (error) {
                    this.notification.add(`No se pudo subir "${file.name}".`, { type: "danger" });
                    reject(error);
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async openFile(fileId) {
        const action = await this.orm.call("document.file", "action_download", [fileId]);
        await this.action.doAction(action);
    }
}
DocumentFolderKanbanRenderer.template = "dfd_documents.DocumentFolderKanbanRenderer";

class DocumentFolderKanbanController extends KanbanController {}
DocumentFolderKanbanController.template = "dfd_documents.DocumentFolderKanbanView";
DocumentFolderKanbanController.components = {
    ...KanbanController.components,
    DocumentFolderBreadcrumb,
};

registry.category("views").add("document_folder_kanban", {
    ...kanbanView,
    Controller: DocumentFolderKanbanController,
    Renderer: DocumentFolderKanbanRenderer,
});
