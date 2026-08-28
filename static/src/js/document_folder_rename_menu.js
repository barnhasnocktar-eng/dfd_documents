/** @odoo-module **/

import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component } from "@odoo/owl";
import { STATIC_ACTIONS_GROUP_NUMBER } from "@web/search/action_menus/action_menus";
import { _t } from "@web/core/l10n/translation";
import { notifyFolderTreeChanged } from "@dfd_documents/js/document_folder_bus";

const cogMenuRegistry = registry.category("cogMenu");

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
    isDisplayed: ({ config, isSmall, searchModel }) =>
        !isSmall &&
        config.actionType === "ir.actions.act_window" &&
        config.viewType === "kanban" &&
        searchModel &&
        searchModel.resModel === "document.folder" &&
        Boolean(searchModel.context.active_folder_id),
};

cogMenuRegistry.add("dfd-rename-folder-menu", renameFolderMenuItem, { sequence: 2 });
