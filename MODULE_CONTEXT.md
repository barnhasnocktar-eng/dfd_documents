# Contexto del Módulo: dfd_documents

## Propósito
Gestor de carpetas y documentos en el backend de Odoo, con navegación jerárquica en vista kanban y ruta de breadcrumb clicable estilo explorador de archivos. Reescritura desde cero pensada para sustituir a futuro el portal de documentos de `dfd_holidays`, sin depender de él ni de su infraestructura. Carpetas y documentos conviven en el mismo kanban: los documentos se suben arrastrándolos (drag&drop) directamente sobre la carpeta abierta. Sin permisos de visibilidad todavía — acceso abierto a todo usuario interno (`base.group_user`).

## Modelos

### DocumentFolder (`document.folder`)
Carpeta jerárquica autoreferenciada. Usa `_parent_store` nativo de Odoo para resolver rutas de forma eficiente.

Campos destacados:
- `parent_id` (many2one a `document.folder`, `ondelete="cascade"`): carpeta padre. `False` = carpeta raíz (nivel superior del árbol).
- `child_ids` (one2many inverso de `parent_id`): subcarpetas directas.
- `file_ids` (one2many inverso de `document.file.folder_id`): documentos contenidos directamente en la carpeta.
- `parent_path` (`_parent_store`): cadena de ids tipo `"1/4/9/"` mantenida automáticamente por Odoo, usada para reconstruir la ruta completa sin recursión manual.
- `child_count` (computed sobre `child_ids`): número de subcarpetas, mostrado en la tarjeta kanban.
- `file_count` (computed sobre `file_ids`): número de documentos directos, mostrado en la misma línea que `child_count` en la tarjeta kanban ("N subcarpeta(s), M documento(s)").

Seguridad: `base.group_user` con acceso completo (CRUD). Sin reglas de dominio ni grupos específicos — pendiente para una fase futura (visibilidad por organigrama, ver nota del proyecto en `INDEX.md`).

### DocumentFolderCreateWizard (`document.folder.create.wizard`, `TransientModel`)
Wizard invocado desde el botón "Nuevo" del kanban (vía atributo `on_create` del arch). Pide `name` y `description`; en `default_get` precarga `parent_id` leyendo `active_folder_id` del contexto de la acción, de forma que la carpeta se crea siempre dentro del nivel que se está viendo.

Seguridad: `base.group_user`, acceso completo.

### DocumentFile (`document.file`)
Documento (archivo) contenido dentro de una carpeta. No duplica el binario: delega el almacenamiento en `ir.attachment` vía `attachment_id`.

Campos destacados:
- `folder_id` (many2one a `document.folder`, requerido, `ondelete="cascade"`): carpeta contenedora. No existe documento sin carpeta — subir a la raíz (`active_folder_id=False`) no está soportado, produce error de campo obligatorio.
- `attachment_id` (many2one a `ir.attachment`, requerido, `ondelete="cascade"`): binario real.
- `mimetype`, `file_size` (related de `attachment_id`): expuestos para mostrar tipo/tamaño sin leer el adjunto aparte; `file_size` se formatea a texto legible (KB/MB) en el cliente JS antes de pintarlo en la tarjeta. La tarjeta también muestra `create_date` (campo nativo de Odoo, sin necesidad de related) formateado con `formatDate`/`deserializeDateTime` de `@web/core/l10n/dates`, en línea propia bajo el tamaño, con texto "Fecha Subida: {fecha}".

Seguridad: `base.group_user` con acceso completo (CRUD), misma línea que `document.folder`.

## Métodos y lógica relevante

### `get_path` — `DocumentFolder`
Devuelve el recordset ordenado de carpetas ancestro (desde la raíz hasta `self` incluida), parseando `parent_path`. Pensado como utilidad de backend; el breadcrumb JS no lo llama directamente (hace su propia lectura de `parent_path` vía ORM desde el cliente), pero ambos resuelven la ruta con la misma lógica.

### `_get_kanban_action` — `DocumentFolder` (`@api.model`)
Construye la `ir.actions.act_window` de `action_document_folder` con `domain=[('parent_id','=', folder_id)]` y `context={'active_folder_id': folder_id}`. Es el punto único que genera la acción de navegación; la usan tanto el clic en tarjeta como el breadcrumb.

### `action_open_folder` — `DocumentFolder`
Método `type="object"` enlazado al atributo `action`/`type` del nodo `<kanban>`. Al hacer clic en una tarjeta, Odoo lo invoca sobre el registro clicado y la acción devuelta reemplaza la vista actual, navegando "dentro" de esa carpeta.

### `action_go_to_folder` — `DocumentFolder` (`@api.model`)
Llamado por RPC desde el componente JS del breadcrumb (`orm.call`) para saltar a un nivel arbitrario del árbol, incluida la raíz (`folder_id=False`).

### `create_from_upload` — `DocumentFile` (`@api.model`)
Punto de entrada único para subir un documento desde el kanban: recibe `name`, `data` (base64, ya recortado del prefijo `data:...;base64,` en el cliente) y `folder_id`, crea el `ir.attachment` y el `document.file` en la misma llamada, y enlaza `attachment.res_id` al documento recién creado. Invocado vía `orm.call` desde `DocumentFolderKanbanRenderer.uploadFile` (JS) en el evento `drop`.

### `action_download` — `DocumentFile`
Devuelve una acción `ir.actions.act_url` hacia `/web/content/{attachment_id}?download=true`. Se dispara al pulsar (clic) la tarjeta de un documento en el kanban, vía `DocumentFolderKanbanRenderer.openFile` (JS).

## Vistas y UI

### Vista kanban (`document_folder_kanban`, JS)
`js_class="document_folder_kanban"` registrado en `document_folder_breadcrumb.js`. No es el kanban nativo de Odoo: extiende `web.KanbanView` con `t-inherit-mode="primary"` (clona el template bajo un nombre propio, `dfd_documents.DocumentFolderKanbanView`) para insertar el componente `DocumentFolderBreadcrumb` justo antes de `t-component="props.Renderer"` — es decir, dentro del área de contenido, encima de las tarjetas, no en la cabecera del control panel (ahí se probó primero con el slot `control-panel-navigation-additional` y quedaba mal ubicado, a la derecha de la cabecera).

`on_create="dfd_documents.action_document_folder_create_wizard"` en el arch hace que el botón "Nuevo" nativo del kanban abra el wizard como diálogo en vez de crear un registro inline.

Navegación por clic en tarjeta: recarga la misma acción `action_document_folder` cambiando el dominio (`parent_id = carpeta pulsada`), no usa una vista jerárquica nativa ni carga hijos in place.

### DocumentFolderBreadcrumb (componente Owl)
Lee `props.activeFolderId` (viene de `props.context.active_folder_id`, propagado por `_get_kanban_action`), hace `orm.read` de `parent_path` y de los nombres de la ruta, y pinta una lista de enlaces separados por `>`. Cada enlace llama a `action_go_to_folder` vía RPC y ejecuta la acción devuelta con `clearBreadcrumbs: true`.

**Detalle importante de la llamada RPC**: `orm.call("document.folder", "action_go_to_folder", [folderId])` — solo el argumento real en el array, sin anteponer `[]` manualmente. Anteponer `[]` (como se hizo en un intento anterior) duplica el recordset vacío que Odoo ya antepone a los métodos `@api.model`, provocando `TypeError: takes from 1 to 2 positional arguments but 3 were given`.

### DocumentFolderKanbanRenderer (componente Owl, extiende `KanbanRenderer`)
Mezcla en un mismo kanban dos modelos distintos sin duplicar el modelo de carpeta: además de las carpetas nativas (`props.list.records`, pintadas por el `KanbanRenderer` base), hace su propia `orm.searchRead` a `document.file` filtrando por `folder_id = active_folder_id` (leído de `props.list.context.active_folder_id`) y pinta una tarjeta adicional por cada documento, insertada justo después del `t-foreach` nativo de carpetas (`getGroupsOrRecords()`) para que quede en el mismo contenedor flex de la fila. Cada tarjeta de documento reutiliza directamente las clases nativas `o_kanban_record d-flex flex-grow-1 flex-md-shrink-1 flex-shrink-0` (las mismas que aplica `KanbanRecord.getRecordClasses()` a las carpetas) — sin esto, la tarjeta queda fuera del flujo flex de la fila y se descuadra visualmente.

Registra el mismo `rootRef` que ya expone `KanbanRenderer` (`useRef("root")`, heredado — no se debe volver a declarar `t-ref="root"` en el xpath de herencia, Owl no permite dos `t-ref` en un mismo nodo) para escuchar `dragover`/`dragleave`/`drop` sobre el grid completo. En `drop`, cada `File` del `dataTransfer` se lee con `FileReader.readAsDataURL`, se recorta el prefijo `data:...;base64,` y se envía a `document.file.create_from_upload` vía `orm.call`; al terminar recarga `loadFiles()` para refrescar las tarjetas de documento del nivel actual. El contador `file_count` de la carpeta *padre* (vista un nivel arriba) no se refresca en caliente tras un upload — se recalcula solo al volver a cargar esa vista, comportamiento nativo de Odoo, no requiere lógica adicional.

`formatFileSize` (función suelta en el mismo archivo JS) convierte bytes a texto legible (bytes/KB/MB/GB) para el subtexto de tamaño en la tarjeta de documento.

## Dependencias externas
`base`, `mail`. Sin dependencia de `dfd_holidays`, `dfd_base` ni `dfd_attendance` — módulo deliberadamente independiente (decisión explícita al iniciar el módulo, para no arrastrar la infraestructura antigua del portal de documentos).

## Notas para el agente
- Documento (`document.file`) siempre requiere `folder_id`: subir a la raíz del árbol (`active_folder_id=False`) no está soportado y produce error de campo obligatorio al intentar `create_from_upload`. Si en el futuro se quiere permitir documentos sueltos en la raíz, hay que decidir explícitamente el diseño (¿carpeta raíz especial? ¿folder_id opcional?) antes de tocarlo.
- El patrón de herencia de vista Owl (`t-inherit-mode="primary"` + `Controller.template` apuntando al nuevo nombre) es el correcto para este caso; `t-inherit-mode="extension"` sobre `web.KanbanView` no registra el template bajo el nuevo nombre y provoca `OwlError: Cannot find the definition of component` en runtime — no volver a intentar esa vía.
- Mismo patrón de herencia aplicado también al `KanbanRenderer` (no solo al `KanbanView`) para mezclar carpetas y documentos en un solo grid — ver `DocumentFolderKanbanRenderer`. Cualquier tarjeta añadida a mano en ese Renderer necesita las clases nativas `o_kanban_record d-flex flex-grow-1 flex-md-shrink-1 flex-shrink-0` para integrarse en el flujo flex de la fila junto a las carpetas.
- Se intentó (y se revirtió a petición del usuario) forzar que el contenido de las tarjetas "arranque siempre arriba" cuando conviven carpetas con distinta cantidad de texto (nombre+descripción+contador) junto a documentos más cortos — el ajuste de `align-items`/`min-height` probado no llegó a identificarse como la causa raíz antes de descartarse, así que el pequeño desalineamiento visual entre tarjetas de distinta altura en la misma fila sigue presente. Si se retoma, no asumir que `align-items` en `.o_kanban_record` o `height:100%` en el hijo son suficientes — no se confirmó su efecto real vía inspección del DOM.
