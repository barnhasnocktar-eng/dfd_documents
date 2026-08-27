/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { Component, onWillStart, useState } from "@odoo/owl";

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

class DocumentFolderKanbanController extends KanbanController {}
DocumentFolderKanbanController.template = "dfd_documents.DocumentFolderKanbanView";
DocumentFolderKanbanController.components = {
    ...KanbanController.components,
    DocumentFolderBreadcrumb,
};

registry.category("views").add("document_folder_kanban", {
    ...kanbanView,
    Controller: DocumentFolderKanbanController,
});
