/** @odoo-module **/

import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { archParseBoolean } from "@web/views/utils";
import { Component, useState, onWillStart } from "@odoo/owl";
import { STATIC_ACTIONS_GROUP_NUMBER } from "@web/search/action_menus/action_menus";
import { _t } from "@web/core/l10n/translation";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { importRecordsItem } from "@base_import/import_records/import_records";
import { notifyFolderTreeChanged } from "@dfd_documents/js/document_folder_bus";

const cogMenuRegistry = registry.category("cogMenu");

// "Importar registros" (base_import) no aplica a document.folder: sus tarjetas kanban son
// carpetas de navegación, no registros pensados para importación masiva desde CSV/Excel. Se
// reimplementa aquí la condición original (import_records.js) añadiendo la exclusión de modelo,
// en vez de encadenar a un "_super" que los objetos planos de este registry no proveen.
patch(importRecordsItem, {
    isDisplayed({ config, isSmall, searchModel }) {
        return (
            !isSmall &&
            config.actionType === "ir.actions.act_window" &&
            ["kanban", "list"].includes(config.viewType) &&
            archParseBoolean(config.viewArch.getAttribute("import"), true) &&
            archParseBoolean(config.viewArch.getAttribute("create"), true) &&
            searchModel.resModel !== "document.folder"
        );
    },
});

// Condición base común a los tres items de este menú: solo en el kanban de carpetas y con una
// carpeta activa (no en la raíz de Documentos, que no es un document.folder real).
const isFolderCogMenuCandidate = ({ config, isSmall, searchModel }) =>
    !isSmall &&
    config.actionType === "ir.actions.act_window" &&
    config.viewType === "kanban" &&
    searchModel &&
    searchModel.resModel === "document.folder" &&
    Boolean(searchModel.context.active_folder_id);

// "Renombrar" y "Eliminar" dan acceso al CONTENIDO de una carpeta, nunca a la carpeta misma (ver
// _can_manage_self en document_folder.py): por eso, además de isFolderCogMenuCandidate, consultan
// al backend (can_manage_folder) si el usuario puede gestionar esa carpeta en sí (grupo/empleado
// permitido en su carpeta PADRE, o base.group_system). Sin ese permiso, ni la carpeta con acceso
// propio ni ninguna de sus antepasadas (visibles en modo solo lectura, ver
// is_ancestor_of_accessible) deben mostrar estas acciones. La comprobación vive en isDisplayed
// (CogMenu la espera con await antes de decidir si cuenta el item, ver cog_menu.js) y no dentro
// del propio Component: si se hiciera dentro del componente (con un t-if sobre un estado cargado
// en onWillStart) el item se montaría igual, CogMenu lo contaría como "hay items" y el botón de
// engranaje aparecería con el desplegable vacío en vez de no aparecer directamente.
const isDisplayedIfCanManage = async (env) => {
    const { config, isSmall, searchModel } = env;
    if (!isFolderCogMenuCandidate({ config, isSmall, searchModel })) {
        return false;
    }
    const folderId = searchModel.context.active_folder_id;
    return env.services.orm.call("document.folder", "can_manage_folder", [folderId]);
};

// Igual que isDisplayedIfCanManage, pero además oculta el item si la carpeta está bloqueada:
// se usa en "Renombrar" y "Eliminar" (el backend ya rechaza ambas operaciones sobre una carpeta
// con is_locked, ver write()/unlink() en document_folder.py), no en "Bloquear/Desbloquear" ni
// en "Permisos", que deben seguir disponibles para poder desbloquearla o gestionar sus accesos.
const isDisplayedIfCanManageAndUnlocked = async (env) => {
    const { config, isSmall, searchModel } = env;
    if (!isFolderCogMenuCandidate({ config, isSmall, searchModel })) {
        return false;
    }
    const folderId = searchModel.context.active_folder_id;
    const [canManage, [folder]] = await Promise.all([
        env.services.orm.call("document.folder", "can_manage_folder", [folderId]),
        env.services.orm.read("document.folder", [folderId], ["is_locked"]),
    ]);
    return canManage && !folder.is_locked;
};

// El KanbanView nativo (kanban_controller.xml) monta <CogMenu/> sin pasarle props.items, así que
// los bindings de ir.actions.act_window (binding_model_id/binding_view_types) nunca llegan a ese
// menú en kanban. Se registra en su lugar un item propio del cogMenu registry, igual que hace
// base_import con "Importar registros", y se filtra por resModel/contexto en vez de por binding.
export class RenameFolderMenuItem extends Component {
    static template = "dfd_documents.RenameFolderMenuItem";
    static components = { DropdownItem };

    setup() {
        this.action = useService("action");
    }

    async renameFolder() {
        const { context } = this.env.searchModel;
        const result = await this.action.doAction(
            "dfd_documents.action_document_folder_rename_wizard",
            {
                additionalContext: context,
                onClose: () => notifyFolderTreeChanged(),
            }
        );
        return result;
    }
}

export const renameFolderMenuItem = {
    Component: RenameFolderMenuItem,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: isDisplayedIfCanManageAndUnlocked,
};

cogMenuRegistry.add("dfd-rename-folder-menu", renameFolderMenuItem, { sequence: 2 });

// Igual mecanismo que RenameFolderMenuItem (ver comentario más arriba), pero alterna entre
// "Bloquear"/"Desbloquear" según el is_locked actual de la carpeta activa. Necesita leerlo antes
// de pintar (onWillStart), a diferencia de los demás items de este menú que no cambian de texto
// ni icono según el estado de la carpeta.
export class ToggleLockFolderMenuItem extends Component {
    static template = "dfd_documents.ToggleLockFolderMenuItem";
    static components = { DropdownItem };

    setup() {
        this.orm = useService("orm");
        this.state = useState({ isLocked: false });
        onWillStart(async () => {
            const folderId = this.env.searchModel.context.active_folder_id;
            const [folder] = await this.orm.read("document.folder", [folderId], ["is_locked"]);
            this.state.isLocked = folder.is_locked;
        });
    }

    async toggleLock() {
        const folderId = this.env.searchModel.context.active_folder_id;
        await this.orm.write("document.folder", [folderId], { is_locked: !this.state.isLocked });
        this.state.isLocked = !this.state.isLocked;
        // El árbol lateral pinta su propio candado por carpeta (get_folder_tree): sin este aviso
        // se queda con el icono desactualizado hasta la próxima navegación que lo recargue entero.
        notifyFolderTreeChanged();
    }
}

export const toggleLockFolderMenuItem = {
    Component: ToggleLockFolderMenuItem,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: isDisplayedIfCanManage,
};

cogMenuRegistry.add("dfd-toggle-lock-folder-menu", toggleLockFolderMenuItem, { sequence: 3 });

// Igual mecanismo que RenameFolderMenuItem (ver comentario más arriba), para abrir el wizard de
// grupos/empleados permitidos de la carpeta activa. A diferencia de Renombrar/Eliminar, "Permisos"
// se reserva SIEMPRE a base.group_system: gestionar quién tiene acceso es una potestad de
// administración, no algo que deba delegarse solo por tener permiso en la carpeta padre. No hace
// falta RPC para esto: services.user.isAdmin ya viene sincronizado en cliente con base.group_system.
export class PermissionsFolderMenuItem extends Component {
    static template = "dfd_documents.PermissionsFolderMenuItem";
    static components = { DropdownItem };

    setup() {
        this.action = useService("action");
    }

    async openPermissions() {
        const { context } = this.env.searchModel;
        const result = await this.action.doAction(
            "dfd_documents.action_document_folder_permissions_wizard",
            { additionalContext: context }
        );
        return result;
    }
}

export const permissionsFolderMenuItem = {
    Component: PermissionsFolderMenuItem,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: (env) =>
        isFolderCogMenuCandidate(env) && env.services.user.isAdmin,
};

cogMenuRegistry.add("dfd-permissions-folder-menu", permissionsFolderMenuItem, { sequence: 4 });

// Igual mecanismo que RenameFolderMenuItem (ver comentario más arriba), para ofrecer "Eliminar"
// también fuera de la raíz, con la misma confirmación y borrado que ya usa el icono de papelera
// del kanban (deleteRecord en document_folder_breadcrumb.js), ya que este menú no tiene acceso a
// ese controller.
export class DeleteFolderMenuItem extends Component {
    static template = "dfd_documents.DeleteFolderMenuItem";
    static components = { DropdownItem };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.dialog = useService("dialog");
    }

    async deleteFolder() {
        const { context } = this.env.searchModel;
        const folderId = context.active_folder_id;
        const doDelete = async () => {
            const [folder] = await this.orm.read("document.folder", [folderId], ["parent_id"]);
            const parentId = folder.parent_id ? folder.parent_id[0] : false;
            await this.orm.unlink("document.folder", [folderId]);
            notifyFolderTreeChanged();
            const nextAction = await this.orm.call("document.folder", "action_go_to_folder", [parentId]);
            await this.action.doAction(nextAction, { clearBreadcrumbs: true });
        };
        // El botón resaltado (btn-primary) del ConfirmationDialog nativo es siempre el de
        // "confirm", sin prop para cambiarlo (ver web.ConfirmationDialog): para que el botón
        // resaltado sea "No, manténgalo" y no "Eliminar", se invierten los slots — "confirm"
        // (resaltado) cierra sin borrar, "cancel" (secundario) ejecuta el borrado real.
        const confirmEmployeeDeletion = () => {
            this.dialog.add(ConfirmationDialog, {
                title: _t("Eliminar carpeta"),
                body: _t(
                    "La carpeta que estás intentando borrar está asociada a uno o varios " +
                    "empleados. Si la borras será irreversible. ¿Estás seguro?"
                ),
                confirmLabel: _t("No, manténgalo"),
                confirm: () => {},
                cancelLabel: _t("Eliminar"),
                cancel: doDelete,
            });
        };
        const isEmployeeRelated = await this.orm.call("document.folder", "is_employee_related", [folderId]);
        // Doble confirmación: primero el diálogo normal y, solo si ahí se elige "Eliminar",
        // se encadena el segundo diálogo (el aviso específico de empleados) que ya ejecuta
        // el borrado real.
        this.dialog.add(ConfirmationDialog, {
            title: _t("Eliminar carpeta"),
            body: _t("¿Seguro que quieres eliminar esta carpeta y todo su contenido?"),
            confirmLabel: _t("No, manténgalo"),
            confirm: () => {},
            cancelLabel: _t("Eliminar"),
            cancel: isEmployeeRelated ? confirmEmployeeDeletion : doDelete,
        });
    }
}

export const deleteFolderMenuItem = {
    Component: DeleteFolderMenuItem,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: isDisplayedIfCanManageAndUnlocked,
};

cogMenuRegistry.add("dfd-delete-folder-menu", deleteFolderMenuItem, { sequence: 5 });
