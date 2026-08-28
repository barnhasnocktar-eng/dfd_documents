/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";
import { Component, onWillStart, useState, onMounted, onPatched, onWillUnmount, reactive } from "@odoo/owl";
import { formatDate, deserializeDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";

// Estado compartido entre DocumentFolderKanbanRenderer (donde arranca el drag de una carpeta o
// documento) y DocumentFolderBreadcrumb (donde se puede soltar para mover a un ancestro): son
// componentes hermanos sin relación padre-hijo, así que se comunican por este singleton reactivo
// en vez de por props. Solo vive el tiempo del drag en curso.
const dragState = reactive({ item: null });

// Llama al método ORM que mueve `item` (carpeta o documento) a `targetFolderId`. Función libre
// (no método de componente) porque la usan tanto DocumentFolderKanbanRenderer como
// DocumentFolderBreadcrumb, cada uno con su propio refresco tras el move.
async function callMoveItem(orm, item, targetFolderId) {
    const { type, id } = item;
    if (type === "folder") {
        await orm.call("document.folder", "move_folder", [id, targetFolderId]);
    } else {
        await orm.call("document.file", "move_file", [id, targetFolderId]);
    }
}

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
        this.notification = useService("notification");
        this.state = useState({ path: [], dragOverFolderId: undefined });

        onWillStart(async () => {
            await this.loadPath();
        });

        // El tema spiffy_theme_backend fuerza noBreadcrumbs:false desde JS (parche propio
        // de View), por lo que el breadcrumb nativo de Odoo no se puede ocultar por config
        // ni por CSS (sus reglas usan !important y ganan la cascada). Se oculta a mano
        // por DOM, ya que este componente solo se monta en la vista de carpetas.
        onMounted(() => this.hideNativeBreadcrumb());
        onWillUnmount(() => this.showNativeBreadcrumb());
    }

    hideNativeBreadcrumb() {
        // Solo el <ol> de la ruta clicable ("Documentos / Documentos"): el título de la
        // vista y los botones de acciones viven en el mismo contenedor .o_breadcrumb
        // pero fuera de este <ol>, así que no se ven afectados.
        const el = document.querySelector(".o_control_panel_breadcrumbs ol.breadcrumb");
        if (el) {
            el.style.display = "none";
        }
    }

    showNativeBreadcrumb() {
        const el = document.querySelector(".o_control_panel_breadcrumbs ol.breadcrumb");
        if (el) {
            el.style.display = "";
        }
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

    // Zona de drop de cada segmento del breadcrumb: permite sacar una carpeta o documento hacia
    // cualquier carpeta ancestro (o a la raíz) de un solo arrastre, sin tener que subir nivel a
    // nivel. `folderId` es false para el segmento raíz ("Documentos").
    onFolderDragOver(ev, folderId) {
        if (!dragState.item) {
            return;
        }
        ev.preventDefault();
        const isSameFolder = dragState.item.type === "folder" && dragState.item.id === folderId;
        const isActiveFolder = folderId === (this.props.activeFolderId || false);
        this.state.dragOverFolderId = isSameFolder || isActiveFolder ? undefined : folderId;
    }

    onFolderDragLeave() {
        this.state.dragOverFolderId = undefined;
    }

    async onFolderDrop(ev, folderId) {
        if (!dragState.item || this.state.dragOverFolderId === undefined) {
            dragState.item = null;
            this.state.dragOverFolderId = undefined;
            return;
        }
        ev.preventDefault();
        const item = dragState.item;
        dragState.item = null;
        this.state.dragOverFolderId = undefined;
        try {
            await callMoveItem(this.orm, item, folderId);
        } catch (error) {
            this.notification.add(
                item.type === "folder" ? _t("No se pudo mover la carpeta.") : _t("No se pudo mover el documento."),
                { type: "danger" }
            );
            return;
        }
        // Recarga la carpeta activa: el elemento movido ha salido de ella, y esta misma llamada
        // refresca tanto el breadcrumb como el kanban (comparten la misma acción).
        await this.goTo(this.props.activeFolderId || false);
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

        // Tarjeta carpeta sobre la que está el cursor, solo para resaltarla con CSS mientras
        // dura el drag. El elemento arrastrado en sí (carpeta o documento) vive en dragState,
        // compartido con DocumentFolderBreadcrumb para poder soltar sobre la ruta superior.
        this.dragOverEl = null;

        onWillStart(async () => {
            await this.loadFiles();
        });

        onMounted(() => {
            const el = this.rootRef.el;
            if (!el) {
                return;
            }
            this._onDragStart = (ev) => this.onFolderDragStart(ev);
            this._onDragEnd = (ev) => this.onFolderDragEnd(ev);
            this._onDragOver = (ev) => this.onDragOver(ev);
            this._onDragLeave = (ev) => this.onDragLeave(ev);
            this._onDrop = (ev) => this.onDrop(ev);
            el.addEventListener("dragstart", this._onDragStart);
            el.addEventListener("dragend", this._onDragEnd);
            el.addEventListener("dragover", this._onDragOver);
            el.addEventListener("dragleave", this._onDragLeave);
            el.addEventListener("drop", this._onDrop);
            this.makeFolderCardsDraggable();
        });

        // El renderer se vuelve a pintar en cada reload (tras crear/mover/borrar carpetas), así
        // que hay que reaplicar draggable a las tarjetas cada vez que cambia la lista de registros.
        onPatched(() => this.makeFolderCardsDraggable());

        onWillUnmount(() => {
            const el = this.rootRef.el;
            if (!el) {
                return;
            }
            el.removeEventListener("dragstart", this._onDragStart);
            el.removeEventListener("dragend", this._onDragEnd);
            el.removeEventListener("dragover", this._onDragOver);
            el.removeEventListener("dragleave", this._onDragLeave);
            el.removeEventListener("drop", this._onDrop);
        });
    }

    // Marca cada tarjeta de carpeta nativa como draggable y le graba el resId real en
    // data-folder-res-id. `record.id` (el que Odoo pinta como data-id) es el id interno del
    // datapoint, no el id de document.folder en BD, así que no sirve para la llamada ORM: hay
    // que casar cada tarjeta con su record por posición (el DOM se pinta en el mismo orden que
    // props.list.records) y anotar aparte el resId real.
    //
    // Las tarjetas de documento se marcan aquí también (por JS, en vez de con t-att-draggable en
    // la plantilla): el atributo draggable puesto solo por template no siempre arranca el drag
    // en Chrome cuando el gesto empieza sobre un <img> hijo, así que se fuerza igual que carpetas.
    makeFolderCardsDraggable() {
        const el = this.rootRef.el;
        if (!el) {
            return;
        }
        const cards = el.querySelectorAll(".o_kanban_record[data-id]");
        const records = this.props.list.records || [];
        cards.forEach((card, index) => {
            const record = records[index];
            if (!record) {
                return;
            }
            card.draggable = true;
            card.dataset.folderResId = record.resId;
        });
        for (const fileCard of el.querySelectorAll("[data-doc-file-id]")) {
            fileCard.draggable = true;
        }
    }

    getFolderCard(target) {
        return target?.closest?.(".o_kanban_record[data-folder-res-id]") || null;
    }

    getFileCard(target) {
        return target?.closest?.("[data-doc-file-id]") || null;
    }

    onFolderDragStart(ev) {
        const folderCard = this.getFolderCard(ev.target);
        if (folderCard) {
            dragState.item = { type: "folder", id: Number(folderCard.dataset.folderResId) };
        } else {
            const fileCard = this.getFileCard(ev.target);
            if (!fileCard) {
                return;
            }
            dragState.item = { type: "file", id: Number(fileCard.dataset.docFileId) };
        }
        ev.dataTransfer.effectAllowed = "move";
        // Tipo propio para distinguir en onDrop un drag interno (carpeta o documento) de un
        // drag de archivos/carpetas arrastrados desde el explorador del sistema operativo.
        ev.dataTransfer.setData("application/x-dfd-item", "1");
    }

    onFolderDragEnd() {
        dragState.item = null;
        this.clearDragOver();
    }

    // Mueve `item` (carpeta o documento) a `targetFolderId`, usado al soltar sobre una tarjeta
    // carpeta del grid, y refresca esta vista (el elemento movido puede haber salido de ella).
    async moveItemToFolder(item, targetFolderId) {
        try {
            await callMoveItem(this.orm, item, targetFolderId);
        } catch (error) {
            this.notification.add(
                item.type === "folder" ? _t("No se pudo mover la carpeta.") : _t("No se pudo mover el documento."),
                { type: "danger" }
            );
        }
        await this.loadFiles();
        await this.props.list.model.load();
    }

    clearDragOver() {
        if (this.dragOverEl) {
            this.dragOverEl.classList.remove("o_dfd_folder_drag_over");
            this.dragOverEl = null;
        }
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
        // Drag interno (carpeta o documento): no activa el overlay de "subir archivo", solo
        // resalta la tarjeta carpeta bajo el cursor (si hay una) como posible destino. Un
        // documento siempre puede soltarse sobre cualquier carpeta; una carpeta no sobre sí misma.
        if (dragState.item) {
            const card = this.getFolderCard(ev.target);
            if (card !== this.dragOverEl) {
                this.clearDragOver();
                const isSameFolder =
                    dragState.item.type === "folder" &&
                    card &&
                    Number(card.dataset.folderResId) === dragState.item.id;
                if (card && !isSameFolder) {
                    card.classList.add("o_dfd_folder_drag_over");
                    this.dragOverEl = card;
                }
            }
            return;
        }
        this.fileState.dragging = true;
    }

    onDragLeave(ev) {
        ev.preventDefault();
        if (dragState.item) {
            return;
        }
        this.fileState.dragging = false;
    }

    async onDrop(ev) {
        ev.preventDefault();
        this.fileState.dragging = false;

        // Drag interno (carpeta o documento): mueve el elemento arrastrado dentro de la carpeta
        // soltada (o a la raíz si se suelta fuera de cualquier tarjeta) en vez de subir archivos.
        if (dragState.item) {
            const { type, id } = dragState.item;
            const targetCard = this.getFolderCard(ev.target);
            this.clearDragOver();
            dragState.item = null;
            const targetFolderId = targetCard ? Number(targetCard.dataset.folderResId) : this.activeFolderId;
            if (type === "folder" && targetFolderId === id) {
                return;
            }
            if (type === "file" && !targetCard) {
                // Soltado fuera de cualquier tarjeta carpeta: se queda donde estaba, no hay
                // "mover a la carpeta activa" porque el documento ya vive en la carpeta activa.
                return;
            }
            await this.moveItemToFolder({ type, id }, targetFolderId);
            return;
        }

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
