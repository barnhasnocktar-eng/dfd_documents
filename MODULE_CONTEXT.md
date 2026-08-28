# Contexto del Módulo: dfd_documents

## Propósito
Gestor de carpetas y documentos con navegación en árbol tipo explorador de archivos (kanban de carpetas, sidebar de árbol, breadcrumb clicable y drag&drop), construido sobre `ir.attachment` como almacén real del contenido subido.

## Modelos

### DocumentFolder (`document.folder`)
Carpeta jerárquica (`_parent_store`, `_parent_name="parent_id"`). Puede anidarse sin límite de nivel.

Campos destacados:
- `parent_id` (many2one a sí mismo, `ondelete="cascade"`): borrar una carpeta borra en cascada sus subcarpetas y, por cascada de `document.file.folder_id`, sus documentos.
- `parent_path` (`_parent_store`): usado para resolver el breadcrumb (`get_path`) y para detectar si un destino de drag&drop es descendiente del origen (`move_folder`).
- `child_count` / `file_count` (computed): contadores mostrados en la tarjeta kanban.

Seguridad: `base.group_user` con acceso total (CRUD); sin grupos ni reglas de registro (`ir.rule`) adicionales — cualquier usuario interno ve todas las carpetas.

### DocumentFile (`document.file`)
Documento dentro de una carpeta; envoltorio de negocio sobre un `ir.attachment`.

Campos destacados:
- `folder_id` (many2one, `required`, `ondelete="cascade"`): un documento no puede vivir en la raíz (ver `move_file`).
- `attachment_id` (many2one a `ir.attachment`, `required`, `ondelete="cascade"`): contenido real del fichero.
- `mimetype` / `file_size` (`related` a `attachment_id`, readonly): evitan duplicar datos del adjunto.

Seguridad: `base.group_user` con acceso total; sin reglas especiales.

### DocumentFolderCreateWizard (`document.folder.create.wizard`, TransientModel)
Wizard modal invocado desde el botón "Crear" del kanban de carpetas (`on_create` de la vista).

Campos destacados:
- `parent_id`: precargado en `default_get` desde `active_folder_id` del contexto de navegación (la carpeta abierta en ese momento), para que la nueva carpeta se cree en el nivel actual sin pedirlo al usuario.

## Métodos y lógica relevante

### `_check_parent_recursion` — DocumentFolder
Constraint sobre `parent_id` que usa el helper nativo `_check_recursion()` de Odoo para impedir ciclos en el árbol.

### `_get_kanban_action` / `action_open_folder` / `action_go_to_folder` — DocumentFolder
Patrón de navegación del módulo: no hay vista de detalle por carpeta, sino que **toda navegación reconstruye la misma acción `action_document_folder`** cambiando su `domain` (`parent_id = folder_id`) y su `context` (`active_folder_id`). `action_open_folder` la dispara al pulsar una tarjeta; `action_go_to_folder` es la usada por el breadcrumb y el árbol lateral para saltar a cualquier nivel (incluida la raíz, con `folder_id=False`).

### `move_folder` — DocumentFolder
Backend del drag&drop de carpeta sobre carpeta. Antes de escribir `parent_id`, corta dos casos con mensaje propio en vez de dejar que salte la `ValidationError` genérica de `_check_parent_recursion`: mover una carpeta sobre sí misma, o sobre una de sus propias subcarpetas (detectado comparando `parent_path` con `startswith`).

### `get_folder_tree` — DocumentFolder
Devuelve de una sola vez `(id, name, parent_id)` de **todas** las carpetas del sistema, sin paginar ni filtrar por nivel. El árbol lateral (JS) arma la jerarquía completa en cliente. Asunción explícita: volumen de carpetas esperado bajo; no escala bien si crece mucho.

### `search_and_go` — DocumentFolder
Resuelve el texto del buscador nativo del kanban (interceptado en JS, ver más abajo) contra nombres de carpeta primero y de documento después (`ilike`, primer match alfabético). Devuelve la acción de navegación al resultado, o `False` si no hay ningún match.

### `create_from_upload_tree` — DocumentFolder
Recrea recursivamente en `folder_id` un árbol `{type, name, data, children}` construido en el cliente al arrastrar una carpeta del sistema operativo sobre el kanban (usa `webkitGetAsEntry`). Por cada nodo tipo `folder` crea una `document.folder` y recurre; por cada nodo tipo `file` delega en `DocumentFile.create_from_upload`.

### `create_from_upload` — DocumentFile
Crea primero el `ir.attachment` (`res_model=self._name`, `public=False`) y después el `document.file`, y solo entonces fija `attachment.res_id` al id del documento ya creado (no se puede antes, porque el documento aún no existe). `data` llega en base64 puro, ya sin el prefijo `data:...;base64,` (recortado en el cliente).

### `move_file` — DocumentFile
Backend del drag&drop de documento sobre carpeta. Corta a mano el caso `target_folder_id` vacío (soltar en la raíz) con un mensaje claro, porque el campo `folder_id` es `required` y si no, el error nativo de campo obligatorio sería confuso para el usuario.

### `action_download` — DocumentFile
Devuelve una acción `ir.actions.act_url` hacia `/web/content/{attachment_id}?download=true`; es lo que se dispara al pulsar una tarjeta de documento en el kanban.

## Vistas y UI

- **Kanban de carpetas** (`view_document_folder_kanban`) usa `js_class="document_folder_kanban"` (registrado en `document_folder_bus.js`... realmente en el JS del renderer) y `on_create` apunta al wizard modal en vez de a una quick-create nativa.
- **`action_document_folder`** es la única acción de navegación de todo el módulo (dominio y contexto dinámicos, ver métodos arriba); su vista kanban es la única declarada (`action_document_folder_kanban_view`), no tiene vista lista ni form en el flujo normal (el form de `document.folder`/`document.file` existe pero solo es alcanzable editando el registro directamente, no desde la navegación kanban).

### Frontend JS (OWL), en `static/src/js/`

El grid nativo de carpetas se extiende con overrides de vista registrados como `document_folder_kanban` (`registry.category("views")`):

- **`document_folder_bus.js`**: `EventTarget` singleton (`documentFolderBus`) para avisar "folder-tree-changed" entre componentes hermanos (kanban, wizard, árbol lateral) sin relación padre-hijo.
- **`document_folder_drag_state.js`**: estado reactivo singleton (`dragState.item`) compartido entre kanban, breadcrumb y árbol lateral durante un drag en curso (carpeta o documento); expone `callMoveItem` (despacha a `move_folder`/`move_file` según tipo) y `getMoveErrorMessage` (extrae el mensaje de una `ValidationError` del backend para mostrarlo tal cual en la notificación).
- **`document_folder_tree_sidebar.js`/`.xml`**: `DocumentFolderTreeSidebar`, panel lateral estilo árbol de Windows. Carga el árbol completo con `get_folder_tree`, expande automáticamente la rama de la carpeta activa (`expandAncestors`), y acepta drops de carpeta/documento en cualquier nodo. Se recarga al oír `folder-tree-changed`.
- **`document_folder_breadcrumb.js`/`.xml`**: `DocumentFolderBreadcrumb`, ruta clicable estilo explorador de archivos. **Oculta el breadcrumb nativo de Odoo manipulando el DOM directamente** (`display:none` sobre `.o_control_panel_breadcrumbs ol.breadcrumb`), porque el tema `spiffy_theme_backend` fuerza `noBreadcrumbs:false` desde JS con reglas `!important` que ganan a cualquier CSS o configuración de vista. Cada segmento de la ruta es zona de drop para mover un elemento a ese nivel ancestro de un solo arrastre.
- **`document_folder_kanban.js`** *(archivo del renderer/controller, referenciado en el manifest como parte de los assets aunque no tiene nombre propio de fichero separado — vive repartido en `document_folder_breadcrumb.js` en este árbol de lectura)*: define `DocumentFolderKanbanRenderer` (inyecta tarjetas de `document.file` junto a las carpetas nativas, gestiona upload por drag&drop desde el SO incluyendo árboles de carpetas vía `webkitGetAsEntry`, y borrado con confirmación) y `DocumentFolderKanbanController` (intercepta la búsqueda nativa del control panel para redirigirla a `search_and_go`, reimplementa `createRecord` para enganchar el cierre del wizard modal —el `actionService.doAction` no espera a que el usuario cierre el diálogo— y reimplementa `deleteRecord` para avisar al árbol lateral tras borrar).

Reglas de negocio del drag&drop reforzadas también en cliente (antes de llamar al backend): no se resalta como destino válido la propia carpeta arrastrada, y un documento soltado fuera de cualquier tarjeta en el grid se queda donde está (no intenta "moverse a la carpeta activa", porque ya vive ahí).

## Dependencias externas

- **`spiffy_theme_backend`**: tema de terceros cuyo comportamiento de breadcrumb obliga al workaround de ocultación manual por DOM descrito arriba. Cualquier cambio en ese tema (o su actualización) puede romper el selector `.o_control_panel_breadcrumbs ol.breadcrumb`.
- **`mail`**: dependencia declarada en el manifest; no se usa mensajería/chatter visible en las vistas actuales (ni `mail.thread` ni `mail.activity.mixin` en los modelos).
- **`base`**: estándar.

## Notas para el agente

- Todo el módulo gira en torno a una única acción de navegación (`action_document_folder`) reconstruida con distinto `domain`/`context` en cada salto de nivel; no busques vistas de detalle por carpeta porque no existen en el flujo normal.
- El sidebar de árbol (`get_folder_tree`) trae **todas** las carpetas del sistema sin paginar: si el volumen de carpetas crece mucho, este método es el primer candidato a revisar por rendimiento.
- Cualquier cambio en el nombre de clase, `js_class` o registro `views` de este módulo debe revisarse junto con `spiffy_theme_backend`, ya que este último parchea comportamiento nativo de breadcrumbs desde JS.
- No hay `ir.rule` ni grupos de seguridad propios: todo `base.group_user` ve y edita todo el árbol de carpetas y documentos. Si se pide restringir por usuario/carpeta, hay que añadirlo desde cero.
- Los archivos JS de assets declarados en `__manifest__.py` no se corresponden 1:1 con nombres "obvios": `document_folder_kanban.scss` es solo estilos; la lógica del renderer/controller kanban vive en `document_folder_breadcrumb.js` pese a su nombre (exporta tanto `DocumentFolderBreadcrumb` como `DocumentFolderKanbanRenderer`/`Controller` y hace el `registry.category("views").add(...)`).
