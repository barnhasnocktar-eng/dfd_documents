# Contexto del Módulo: dfd_documents

## Propósito
Gestor de carpetas en el backend de Odoo, con navegación jerárquica en vista kanban y ruta de breadcrumb clicable estilo explorador de archivos. Reescritura desde cero pensada para sustituir a futuro el portal de documentos de `dfd_holidays`, sin depender de él ni de su infraestructura. Fase actual: solo carpetas (nombre + descripción); el modelo de documento/adjunto queda pendiente de diseño. Sin permisos de visibilidad todavía — acceso abierto a todo usuario interno (`base.group_user`).

## Modelos

### DocumentFolder (`document.folder`)
Carpeta jerárquica autoreferenciada. Usa `_parent_store` nativo de Odoo para resolver rutas de forma eficiente.

Campos destacados:
- `parent_id` (many2one a `document.folder`, `ondelete="cascade"`): carpeta padre. `False` = carpeta raíz (nivel superior del árbol).
- `child_ids` (one2many inverso de `parent_id`): subcarpetas directas.
- `parent_path` (`_parent_store`): cadena de ids tipo `"1/4/9/"` mantenida automáticamente por Odoo, usada para reconstruir la ruta completa sin recursión manual.
- `child_count` (computed sobre `child_ids`): número de subcarpetas, mostrado en la tarjeta kanban.

Seguridad: `base.group_user` con acceso completo (CRUD). Sin reglas de dominio ni grupos específicos — pendiente para una fase futura (visibilidad por organigrama, ver nota del proyecto en `INDEX.md`).

### DocumentFolderCreateWizard (`document.folder.create.wizard`, `TransientModel`)
Wizard invocado desde el botón "Nuevo" del kanban (vía atributo `on_create` del arch). Pide `name` y `description`; en `default_get` precarga `parent_id` leyendo `active_folder_id` del contexto de la acción, de forma que la carpeta se crea siempre dentro del nivel que se está viendo.

Seguridad: `base.group_user`, acceso completo.

## Métodos y lógica relevante

### `get_path` — `DocumentFolder`
Devuelve el recordset ordenado de carpetas ancestro (desde la raíz hasta `self` incluida), parseando `parent_path`. Pensado como utilidad de backend; el breadcrumb JS no lo llama directamente (hace su propia lectura de `parent_path` vía ORM desde el cliente), pero ambos resuelven la ruta con la misma lógica.

### `_get_kanban_action` — `DocumentFolder` (`@api.model`)
Construye la `ir.actions.act_window` de `action_document_folder` con `domain=[('parent_id','=', folder_id)]` y `context={'active_folder_id': folder_id}`. Es el punto único que genera la acción de navegación; la usan tanto el clic en tarjeta como el breadcrumb.

### `action_open_folder` — `DocumentFolder`
Método `type="object"` enlazado al atributo `action`/`type` del nodo `<kanban>`. Al hacer clic en una tarjeta, Odoo lo invoca sobre el registro clicado y la acción devuelta reemplaza la vista actual, navegando "dentro" de esa carpeta.

### `action_go_to_folder` — `DocumentFolder` (`@api.model`)
Llamado por RPC desde el componente JS del breadcrumb (`orm.call`) para saltar a un nivel arbitrario del árbol, incluida la raíz (`folder_id=False`).

## Vistas y UI

### Vista kanban (`document_folder_kanban`, JS)
`js_class="document_folder_kanban"` registrado en `document_folder_breadcrumb.js`. No es el kanban nativo de Odoo: extiende `web.KanbanView` con `t-inherit-mode="primary"` (clona el template bajo un nombre propio, `dfd_documents.DocumentFolderKanbanView`) para insertar el componente `DocumentFolderBreadcrumb` justo antes de `t-component="props.Renderer"` — es decir, dentro del área de contenido, encima de las tarjetas, no en la cabecera del control panel (ahí se probó primero con el slot `control-panel-navigation-additional` y quedaba mal ubicado, a la derecha de la cabecera).

`on_create="dfd_documents.action_document_folder_create_wizard"` en el arch hace que el botón "Nuevo" nativo del kanban abra el wizard como diálogo en vez de crear un registro inline.

Navegación por clic en tarjeta: recarga la misma acción `action_document_folder` cambiando el dominio (`parent_id = carpeta pulsada`), no usa una vista jerárquica nativa ni carga hijos in place.

### DocumentFolderBreadcrumb (componente Owl)
Lee `props.activeFolderId` (viene de `props.context.active_folder_id`, propagado por `_get_kanban_action`), hace `orm.read` de `parent_path` y de los nombres de la ruta, y pinta una lista de enlaces separados por `>`. Cada enlace llama a `action_go_to_folder` vía RPC y ejecuta la acción devuelta con `clearBreadcrumbs: true`.

**Detalle importante de la llamada RPC**: `orm.call("document.folder", "action_go_to_folder", [folderId])` — solo el argumento real en el array, sin anteponer `[]` manualmente. Anteponer `[]` (como se hizo en un intento anterior) duplica el recordset vacío que Odoo ya antepone a los métodos `@api.model`, provocando `TypeError: takes from 1 to 2 positional arguments but 3 were given`.

## Dependencias externas
`base`, `mail`. Sin dependencia de `dfd_holidays`, `dfd_base` ni `dfd_attendance` — módulo deliberadamente independiente (decisión explícita al iniciar el módulo, para no arrastrar la infraestructura antigua del portal de documentos).

## Notas para el agente
- Fase 1 de un rediseño más amplio: no existe todavía modelo de documento/adjunto, ni permisos de visibilidad por departamento/organigrama. Ambos quedaron explícitamente pospuestos al definir el módulo.
- Si se añade el modelo de documento, previsiblemente necesitará su propio breadcrumb o reutilizar `DocumentFolderBreadcrumb` — revisar antes de duplicar lógica de ruta.
- El patrón de herencia de vista Owl (`t-inherit-mode="primary"` + `Controller.template` apuntando al nuevo nombre) es el correcto para este caso; `t-inherit-mode="extension"` sobre `web.KanbanView` no registra el template bajo el nuevo nombre y provoca `OwlError: Cannot find the definition of component` en runtime — no volver a intentar esa vía.
