/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";
import { Component, onWillStart, useState, onMounted, onWillUnmount } from "@odoo/owl";
import { formatDate, deserializeDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";

// Determina el icono a mostrar en la tarjeta de documento según su mimetype.
const FILE_ICON_BY_MIMETYPE = {
    "application/pdf": "pdf.png",
    "application/msword": "doc.png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc.png",
    "application/vnd.ms-excel": "xls.png",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls.png",
    "application/zip": "rar.png",
    "application/x-zip-compressed": "rar.png",
    "application/x-rar-compressed": "rar.png",
    "application/vnd.rar": "rar.png",
    "application/x-rar": "rar.png",
};

function getFileIcon(mimetype) {
    const fileName = FILE_ICON_BY_MIMETYPE[mimetype] || "file.png";
    return `/dfd_documents/static/src/img/${fileName}`;
}

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
        this.dialog = useService("dialog");
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

    // El kanban nativo solo cuenta document.folder (subcarpetas) para decidir si mostrar
    // el mensaje de "vacío"; los documentos se inyectan aparte en fileState.files, así que
    // hay que tenerlos en cuenta aquí para no marcar como vacía una carpeta con documentos.
    get showNoContentHelper() {
        if (this.fileState.files.length) {
            return false;
        }
        return super.showNoContentHelper;
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
            iconSrc: getFileIcon(file.mimetype),
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
        const items = ev.dataTransfer?.items;
        const entries =
            items && items.length
                ? [...items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
                : [];

        if (entries.length) {
            // Navegador soporta entries (Chrome/Edge/Firefox): recorremos carpetas y subcarpetas.
            const tree = [];
            for (const entry of entries) {
                tree.push(await this.buildTreeNode(entry));
            }
            try {
                await this.orm.call("document.folder", "create_from_upload_tree", [
                    tree,
                    this.activeFolderId,
                ]);
            } catch (error) {
                this.notification.add(_t("No se pudo completar la subida de la carpeta."), {
                    type: "danger",
                });
            }
        } else {
            // Fallback: navegador sin soporte de entries, solo archivos sueltos.
            const files = [...(ev.dataTransfer?.files || [])];
            for (const file of files) {
                await this.uploadFile(file);
            }
        }
        await this.loadFiles();
        await this.props.list.model.load();
    }

    // Convierte recursivamente un FileSystemEntry (archivo o carpeta) en el árbol
    // {type, name, data, children} que espera document.folder.create_from_upload_tree.
    async buildTreeNode(entry) {
        if (entry.isDirectory) {
            const children = await this.readAllEntries(entry.createReader());
            const childNodes = [];
            for (const child of children) {
                childNodes.push(await this.buildTreeNode(child));
            }
            return { type: "folder", name: entry.name, children: childNodes };
        }
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        const data = await this.readFileAsBase64(file);
        return { type: "file", name: entry.name, data };
    }

    // readEntries() solo devuelve hasta 100 resultados por llamada: hay que repetir hasta vaciarla.
    readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            const readBatch = () => {
                reader.readEntries((batch) => {
                    if (!batch.length) {
                        resolve(all);
                        return;
                    }
                    all.push(...batch);
                    readBatch();
                }, reject);
            };
            readBatch();
        });
    }

    readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async uploadFile(file) {
        const folderId = this.activeFolderId;
        try {
            const base64Data = await this.readFileAsBase64(file);
            await this.orm.call("document.file", "create_from_upload", [
                file.name,
                base64Data,
                folderId,
            ]);
        } catch (error) {
            this.notification.add(`No se pudo subir "${file.name}".`, { type: "danger" });
        }
    }

    async openFile(fileId) {
        const action = await this.orm.call("document.file", "action_download", [fileId]);
        await this.action.doAction(action);
    }

    // Pide confirmación y borra una carpeta (recarga la vista para refrescar el listado).
    confirmDeleteFolder(ev, folderId) {
        ev.stopPropagation();
        this.dialog.add(ConfirmationDialog, {
            title: _t("Eliminar carpeta"),
            body: _t("¿Seguro que quieres eliminar esta carpeta y todo su contenido?"),
            confirmLabel: _t("Eliminar"),
            confirm: async () => {
                await this.orm.unlink("document.folder", [folderId]);
                await this.props.list.model.load();
            },
            cancel: () => {},
        });
    }

    // Pide confirmación y borra un documento de la carpeta activa.
    confirmDeleteFile(ev, fileId) {
        ev.stopPropagation();
        this.dialog.add(ConfirmationDialog, {
            title: _t("Eliminar documento"),
            body: _t("¿Seguro que quieres eliminar este documento?"),
            confirmLabel: _t("Eliminar"),
            confirm: async () => {
                await this.orm.unlink("document.file", [fileId]);
                await this.loadFiles();
            },
            cancel: () => {},
        });
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
