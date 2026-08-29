/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";
import { Component, onWillStart, useState, onMounted, onPatched, onWillUnmount } from "@odoo/owl";
import { formatDate, deserializeDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog, deleteConfirmationMessage } from "@web/core/confirmation_dialog/confirmation_dialog";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { dragState, callMoveItem, getMoveErrorMessage } from "@dfd_documents/js/document_folder_drag_state";
import { notifyFolderTreeChanged } from "@dfd_documents/js/document_folder_bus";
import { DocumentFolderTreeSidebar } from "@dfd_documents/js/document_folder_tree_sidebar";

// Límite de subida por drag&drop (archivo suelto, o suma de todos los archivos de una carpeta
// arrastrada): igual valor que MAX_UPLOAD_SIZE en document_file.py. Se valida aquí también,
// antes de leer los archivos, para no gastar memoria/red en una subida que el backend rechazará.
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const MAX_UPLOAD_SIZE_MESSAGE = _t("El tamaño máximo permitido para un archivo o carpeta es de 100MB");

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
            const message = getMoveErrorMessage(error) ||
                (item.type === "folder" ? _t("No se pudo mover la carpeta.") : _t("No se pudo mover el documento."));
            this.notification.add(message, { type: "danger" });
            return;
        }
        if (item.type === "folder") {
            notifyFolderTreeChanged();
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
        // uploadState.total > 0 mientras dura una subida (uno o varios archivos, sueltos o en
        // carpeta): pinta el overlay de progreso "X de Y" en vez del overlay de "soltar aquí".
        this.fileState = useState({ files: [], dragging: false });
        this.uploadState = useState({ current: 0, total: 0 });
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
            const message = getMoveErrorMessage(error) ||
                (item.type === "folder" ? _t("No se pudo mover la carpeta.") : _t("No se pudo mover el documento."));
            this.notification.add(message, { type: "danger" });
        }
        if (item.type === "folder") {
            notifyFolderTreeChanged();
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
            // Primero se suma el tamaño real de todos los archivos (sin leer su contenido) para
            // cortar antes de gastar memoria/red si ya se sabe que la carpeta excede el límite.
            const totalSize = await this.getEntriesTotalSize(entries);
            if (totalSize > MAX_UPLOAD_SIZE) {
                this.notification.add(MAX_UPLOAD_SIZE_MESSAGE, { type: "danger" });
                await this.loadFiles();
                await this.props.list.model.load();
                return;
            }
            // El árbol completo viaja en una sola llamada ORM, así que aquí no hay progreso fino
            // por archivo: solo se marca "hay una subida en curso" (total=1) para el overlay.
            this.uploadState.current = 0;
            this.uploadState.total = 1;
            try {
                const tree = [];
                for (const entry of entries) {
                    tree.push(await this.buildTreeNode(entry));
                }
                await this.orm.call("document.folder", "create_from_upload_tree", [
                    tree,
                    this.activeFolderId,
                ]);
                this.notification.add(_t("Carpeta subida correctamente."), { type: "success" });
            } catch (error) {
                this.notification.add(
                    getMoveErrorMessage(error) || _t("No se pudo completar la subida de la carpeta."),
                    { type: "danger" }
                );
            } finally {
                this.uploadState.current = 0;
                this.uploadState.total = 0;
            }
        } else {
            // Fallback: navegador sin soporte de entries, solo archivos sueltos.
            const files = [...(ev.dataTransfer?.files || [])];
            this.uploadState.current = 0;
            this.uploadState.total = files.length;
            for (const file of files) {
                await this.uploadFile(file);
                this.uploadState.current++;
            }
            this.uploadState.current = 0;
            this.uploadState.total = 0;
        }
        await this.loadFiles();
        await this.props.list.model.load();
    }

    // Suma el tamaño real (File.size, sin leer contenido) de todos los archivos de un árbol de
    // FileSystemEntry, recorriendo subcarpetas. Se usa para validar el límite de subida antes
    // de construir el árbol base64 completo en buildTreeNode.
    async getEntriesTotalSize(entries) {
        let total = 0;
        for (const entry of entries) {
            if (entry.isDirectory) {
                const children = await this.readAllEntries(entry.createReader());
                total += await this.getEntriesTotalSize(children);
            } else {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                total += file.size;
            }
        }
        return total;
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
        if (file.size > MAX_UPLOAD_SIZE) {
            this.notification.add(MAX_UPLOAD_SIZE_MESSAGE, { type: "danger" });
            return;
        }
        try {
            const base64Data = await this.readFileAsBase64(file);
            await this.orm.call("document.file", "create_from_upload", [
                file.name,
                base64Data,
                folderId,
            ]);
            this.notification.add(_t('"%s" subido correctamente.', file.name), { type: "success" });
        } catch (error) {
            this.notification.add(
                getMoveErrorMessage(error) || _t('No se pudo subir "%s".', file.name),
                { type: "danger" }
            );
        }
    }

    async downloadFile(fileId) {
        const action = await this.orm.call("document.file", "action_download", [fileId]);
        await this.action.doAction(action);
    }

    // Abre el wizard de renombrado del documento, mismo mecanismo que RenameFolderMenuItem
    // (document_folder_rename_menu.js) pero pasando active_file_id en vez de active_folder_id.
    async renameFile(fileId) {
        await this.action.doAction("dfd_documents.action_document_file_rename_wizard", {
            additionalContext: { active_file_id: fileId },
            onClose: () => this.loadFiles(),
        });
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
                notifyFolderTreeChanged();
                await this.props.list.model.load();
            },
            cancel: () => {},
        });
    }

    // Pide confirmación y borra un documento de la carpeta activa.
    //
    // El botón resaltado (btn-primary) del ConfirmationDialog nativo es siempre el de
    // "confirm", sin prop para cambiarlo (ver web.ConfirmationDialog): para que el botón
    // resaltado sea "No, manténgalo" y no "Eliminar", se invierten los slots — "confirm"
    // (resaltado) cierra sin borrar, "cancel" (secundario) ejecuta el borrado real.
    confirmDeleteFile(ev, fileId) {
        ev.stopPropagation();
        this.dialog.add(ConfirmationDialog, {
            title: _t("Eliminar documento"),
            body: _t("¿Seguro que quieres eliminar este documento? Esta acción es irreversible."),
            confirmLabel: _t("No, manténgalo"),
            confirm: () => {},
            cancelLabel: _t("Eliminar"),
            cancel: async () => {
                await this.orm.unlink("document.file", [fileId]);
                await this.loadFiles();
            },
        });
    }
}
DocumentFolderKanbanRenderer.template = "dfd_documents.DocumentFolderKanbanRenderer";
DocumentFolderKanbanRenderer.components = {
    ...KanbanRenderer.components,
    Dropdown,
    DropdownItem,
};

class DocumentFolderKanbanController extends KanbanController {
    setup() {
        super.setup();
        this.orm = useService("orm");
        this.notification = useService("notification");

        // El buscador nativo del control panel solo filtra document.folder por nombre dentro
        // del nivel actual (domain fijo de la action), así que nunca encuentra documentos ni
        // navega a otra carpeta. Se intercepta aquí: en vez de dejar que el filtro nativo se
        // aplique, se resuelve el texto contra carpetas y documentos (server-side) y se navega
        // directo al resultado, con el mismo comportamiento "ir dentro" que un click de tarjeta.
        this._onSearchUpdate = () => this.onSearchUpdate();
        onMounted(() => {
            this.env.searchModel.addEventListener("update", this._onSearchUpdate);
        });
        onWillUnmount(() => {
            this.env.searchModel.removeEventListener("update", this._onSearchUpdate);
        });
    }

    // Extrae el texto libre tecleado en la barra de búsqueda (facet tipo "field"), lo resuelve
    // contra carpetas/documentos y navega. Limpia siempre la query para no dejar el filtro
    // nativo aplicado (ya sea porque se navegó a otro sitio o porque no hubo resultados).
    async onSearchUpdate() {
        const searchTerm = this.env.searchModel.facets
            .filter((facet) => facet.type === "field")
            .flatMap((facet) => facet.values)
            .join(" ")
            .trim();
        if (!searchTerm) {
            return;
        }
        this.env.searchModel.clearQuery();
        const action = await this.orm.call("document.folder", "search_and_go", [searchTerm]);
        if (!action) {
            this.notification.add(_t("No se encontró ninguna carpeta o documento con ese nombre."), {
                type: "warning",
            });
            return;
        }
        await this.actionService.doAction(action, { clearBreadcrumbs: true });
    }

    // El wizard de creación de carpeta (on_create) se abre en un diálogo modal vía actionService;
    // KanbanController.createRecord dispara ese doAction pero la promesa se resuelve al ABRIR el
    // diálogo, no al cerrarlo (el actionService no espera al usuario) — envolver "await
    // super.createRecord()" no sirve, notifyFolderTreeChanged() se dispararía antes de crear la
    // carpeta. Hay que enganchar el propio onClose del wizard, así que se reimplementa aquí en
    // vez de llamar a super().
    async createRecord() {
        const { onCreate } = this.props.archInfo;
        const { root } = this.model;
        if (this.canQuickCreate && onCreate === "quick_create") {
            await super.createRecord();
            return;
        }
        if (onCreate && onCreate !== "quick_create") {
            await this.actionService.doAction(onCreate, {
                additionalContext: root.context,
                onClose: async () => {
                    await root.load();
                    this.model.useSampleModel = false;
                    this.render(true);
                    notifyFolderTreeChanged();
                },
            });
        } else {
            await this.props.createRecord();
        }
    }

    // El icono de papelera de cada tarjeta (type="delete" en el arch) borra la carpeta a través
    // de este método nativo, no del confirmDeleteFolder del renderer; hay que avisar aquí al
    // árbol lateral igual que en createRecord, o se queda con la carpeta borrada hasta refrescar.
    //
    // El botón resaltado (btn-primary) del ConfirmationDialog nativo es siempre el de "confirm",
    // sin prop para cambiarlo (ver web.ConfirmationDialog): para que el botón resaltado sea "No,
    // manténgalo" y no "Eliminar", se invierten los slots — "confirm" (resaltado) cierra sin
    // borrar, "cancel" (secundario) ejecuta el borrado real.
    async deleteRecord(record) {
        const doDelete = async () => {
            await this.model.root.deleteRecords([record]);
            notifyFolderTreeChanged();
        };
        const confirmEmployeeDeletion = () => {
            this.dialog.add(ConfirmationDialog, {
                title: _t("Bye-bye, record!"),
                body: _t(
                    "La carpeta que estás intentando borrar está asociada a uno o varios " +
                    "empleados. Si la borras será irreversible. ¿Estás seguro?"
                ),
                confirmLabel: _t("No, keep it"),
                confirm: () => {},
                cancelLabel: _t("Delete"),
                cancel: doDelete,
            });
        };
        const isEmployeeRelated = await this.orm.call("document.folder", "is_employee_related", [record.resId]);
        // Doble confirmación: primero el diálogo normal y, solo si ahí se elige "Delete", se
        // encadena el segundo diálogo (el aviso específico de empleados) que ya ejecuta el
        // borrado real.
        this.dialog.add(ConfirmationDialog, {
            title: _t("Bye-bye, record!"),
            body: deleteConfirmationMessage,
            confirmLabel: _t("No, keep it"),
            confirm: () => {},
            cancelLabel: _t("Delete"),
            cancel: isEmployeeRelated ? confirmEmployeeDeletion : doDelete,
        });
    }
}
DocumentFolderKanbanController.template = "dfd_documents.DocumentFolderKanbanView";
DocumentFolderKanbanController.components = {
    ...KanbanController.components,
    DocumentFolderBreadcrumb,
    DocumentFolderTreeSidebar,
};

registry.category("views").add("document_folder_kanban", {
    ...kanbanView,
    Controller: DocumentFolderKanbanController,
    Renderer: DocumentFolderKanbanRenderer,
});
