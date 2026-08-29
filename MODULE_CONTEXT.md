# Contexto del Módulo: dfd_documents

## Propósito
Gestor de carpetas y documentos con navegación en árbol tipo explorador de archivos (kanban de carpetas, sidebar de árbol, breadcrumb clicable y drag&drop), construido sobre `ir.attachment` como almacén real del contenido subido. Incluye carpetas automáticas por empleado/departamento e historial de movimientos con purga programada.

## Modelos

### DocumentFolder (`document.folder`)
Carpeta jerárquica (`_parent_store`, `_parent_name="parent_id"`). Puede anidarse sin límite de nivel.

Campos destacados:
- `parent_id` (many2one a sí mismo, `ondelete="cascade"`): borrar una carpeta borra en cascada sus subcarpetas y, por cascada de `document.file.folder_id`, sus documentos.
- `parent_path` (`_parent_store`): usado para resolver el breadcrumb (`get_path`) y para detectar si un destino de drag&drop es descendiente del origen (`move_folder`).
- `child_count` / `file_count` (computed): contadores mostrados en la tarjeta kanban.
- `allowed_group_ids` (`res.groups`, m2m): grupos permitidos asignados explícitamente a **esta** carpeta desde el wizard de Permisos. No incluye lo heredado.
- `effective_group_ids` (`res.groups`, m2m, computed **store=True**, `recursive=True`): unión de `allowed_group_ids` propio + `effective_group_ids` del `parent_id` + `base.group_system` (siempre presente, ver `_get_always_allowed_groups`). Es el campo real contra el que filtra la `ir.rule`. Al ser store y depender de `parent_id.effective_group_ids`, escribir `allowed_group_ids` en una carpeta recalcula en cascada todas sus descendientes.
- `allowed_employee_ids` (`hr.employee`, m2m): empleados concretos permitidos explícitamente en **esta** carpeta (acceso vía su `user_id`, no vía grupo). Mismo patrón que `allowed_group_ids`, calculado y gestionado en paralelo.
- `effective_employee_ids` (`hr.employee`, m2m, computed **store=True**, `recursive=True`, calculado en el mismo método que `effective_group_ids`): unión de `allowed_employee_ids` propio + `effective_employee_ids` del `parent_id`. Sin equivalente a `base.group_system`: no hay "empleado de sistema" que tenga acceso siempre.
- `is_ancestor_of_accessible` (Boolean, computed **no store**, con `search` propio `_search_is_ancestor_of_accessible`): True si el usuario actual no tiene acceso real a la carpeta pero sí a alguna de sus descendientes. Es un campo técnico pensado para usarse solo dentro de dominios de búsqueda/`ir.rule`, no para leerse directamente sobre un recordset ya cargado (el compute por registro existe solo porque Odoo lo exige, pero es más costoso que el `search`).

Seguridad: `base.group_user` con acceso total (CRUD) a nivel de `ir.model.access`, pero filtrado por `ir.rule` global (`data/access_permissions.xml`) con dominio `OR` de tres ramas: acceso real por grupo (`effective_group_ids`), acceso real por empleado (`effective_employee_ids.user_id`), o **visibilidad de solo lectura por ser antepasada de una carpeta accesible** (`is_ancestor_of_accessible`). **Herencia acumulativa hacia abajo** en las dos primeras vías: lo permitido en una carpeta (grupo o empleado) se suma a lo de sus descendientes (subcarpetas y documentos); no se puede "quitar" nada heredado de un antepasado, solo añadir más. Una carpeta sin nada propio ni heredado de ningún antepasado solo es visible para `base.group_system` (administradores). Un empleado permitido sin `user_id` asignado no da acceso a nadie hasta que se le asigne un usuario (comprobado de forma implícita: `effective_employee_ids.user_id` sale vacío para ese empleado).

**Navegación por el camino de carpetas antepasadas (regla de negocio explícita del cliente)**: si Juan solo tiene acceso real a `Documentos/Empleados/Juan`, puede navegar y VER `Documentos` y `Documentos/Empleados` (para llegar hasta la suya desde la raíz), pero **no** puede editarlas/moverlas/eliminarlas (`_check_can_manage_self` sigue exigiendo acceso real en el padre, `is_ancestor_of_accessible` NUNCA cuenta como acceso real) **ni** ve otras carpetas hermanas por el camino (dentro de `Empleados`, solo aparece `Juan`, no `María` ni `Pedro`, porque la `ir.rule` filtra igual el listado de subcarpetas que cualquier otra búsqueda). Esto sale gratis de la misma `ir.rule`: el kanban de cualquier nivel usa `search`/`search_read` internamente, así que el filtrado de hermanas no necesita lógica aparte en `_get_kanban_action` ni en `get_folder_tree`.

**Tener grupo o empleado permitido en una carpeta X da acceso a su CONTENIDO (subcarpetas y documentos dentro de X), nunca a X misma.** Para renombrar, mover, bloquear (`is_locked`), eliminar X o cambiar los `allowed_group_ids`/`allowed_employee_ids` propios de X hace falta grupo o empleado permitido en el **padre** de X (o `base.group_system`) — igual que hace falta para poder crear algo dentro de ese padre. Sin padre (carpeta de primer nivel), solo `base.group_system` puede tocarla. Reforzado en código por `_check_can_manage_self()`, invocado desde `write`/`unlink` de `DocumentFolder` y desde el `default_get` del wizard de permisos; es independiente y se suma al bloqueo ya existente por `is_locked`.

### DocumentFile (`document.file`)
Documento dentro de una carpeta; envoltorio de negocio sobre un `ir.attachment`.

Campos destacados:
- `folder_id` (many2one, `required`, `ondelete="cascade"`): un documento no puede vivir en la raíz (ver `move_file`).
- `attachment_id` (many2one a `ir.attachment`, `required`, `ondelete="cascade"`): contenido real del fichero.
- `mimetype` / `file_size` (`related` a `attachment_id`, readonly): evitan duplicar datos del adjunto.

Seguridad: `base.group_user` con acceso total; sin reglas especiales.

### DocumentMovementLog (`document.movement.log`)
Historial inmutable de eventos sobre carpetas y documentos (creación, renombrado, movido, bloqueo/desbloqueo, cambio de permisos, eliminación). Sin `create`/`edit`/`delete` en sus vistas (solo lectura desde UI).

Campos destacados:
- `res_model` / `res_id` / `res_name` / `folder_path`: "foto" del registro afectado en el momento del evento, sin `Many2one` real hacia `document.folder`/`document.file` a propósito — esos registros pueden borrarse (incluso en cascada) y el historial debe sobrevivir intacto.
- `detail` (Text, opcional): usado solo en el evento `permissions` para listar grupos/empleados antes y después del cambio.

Seguridad: solo lectura (`perm_read`) para `base.group_system`; nadie más tiene acceso al modelo.

### EmployeeFolderSyncWizard (`document.employee.folder.sync.wizard`, TransientModel)
Wizard sin campos, invocado desde el menú Configuración > Empleados > "Actualizar/Crear carpetas". `action_sync_folders` llama `x_sync_default_folders()` sobre **todos** los empleados del sistema (`search([])`) y recarga la página; es la vía masiva equivalente al botón individual de la ficha de empleado (`x_action_create_employee_folder`), ambos delegan en el mismo método de `hr.employee`.

### DocumentFolderCreateWizard (`document.folder.create.wizard`, TransientModel)
Wizard modal invocado desde el botón "Crear" del kanban de carpetas (`on_create` de la vista).

Campos destacados:
- `parent_id`: precargado en `default_get` desde `active_folder_id` del contexto de navegación (la carpeta abierta en ese momento), para que la nueva carpeta se cree en el nivel actual sin pedirlo al usuario.

### DocumentFolderPermissionsWizard (`document.folder.permissions.wizard`, TransientModel)
Wizard modal invocado desde la entrada "Permisos" del cogMenu del kanban (junto a "Renombrar" y "Eliminar"), igual mecanismo que estas (`document_folder_rename_menu.js`). Deja ver/editar `allowed_group_ids` y `allowed_employee_ids` de la carpeta activa (`active_folder_id`).

Campos destacados:
- `allowed_group_ids` / `allowed_employee_ids`: precargados desde los campos homónimos de la carpeta (no desde `effective_*`: no se mezcla lo propio con lo heredado). `action_save_permissions` escribe ambos many2many completos con `(6, 0, ids)` en la misma llamada a `write`.
- `inherited_group_ids` / `inherited_employee_ids`: solo lectura, muestran `folder.parent_id.effective_group_ids`/`effective_employee_ids` (grupos: `base.group_system` si es de primer nivel; empleados: vacío si es de primer nivel) para que el usuario entienda qué ya tiene acceso sin necesidad de marcarlo aquí.

**Gestionar permisos es potestad exclusiva de `base.group_system`, siempre, sin excepción** (a diferencia de renombrar/mover/eliminar, que sí puede un usuario normal con grupo/empleado permitido en el padre): `_check_is_admin()` corta tanto en `default_get` (el wizard ni abre) como en `action_save_permissions` (por si se invoca el guardado sin volver a pasar por `default_get`, p. ej. reescribiendo un wizard ya creado por RPC). No reutiliza `_check_can_manage_self()` de `DocumentFolder` a propósito: esa función sí dejaría pasar a cualquiera con permiso en el padre, que es precisamente lo que aquí se quiere excluir.

### DocumentFileRenameWizard (`document.file.rename.wizard`, TransientModel)
Wizard modal para renombrar un documento, mismo mecanismo que `DocumentFolderRenameWizard` pero sobre `document.file`, invocado desde el menú contextual de la tarjeta de documento (`document_folder_breadcrumb.js`, no del cogMenu como las carpetas). Sin comprobación de permiso propia (a diferencia de la carpeta): `document.file` no tiene equivalente a `_check_can_manage_self`, el acceso ya lo filtra el `ir.model.access.csv` estándar de `base.group_user`.

Campos destacados:
- `file_id`: precargado en `default_get` desde `active_file_id` del contexto (pasado a mano en `additionalContext` al abrir la acción, no viene de `searchModel.context` porque el documento no es un registro Owl real del kanban).

## Métodos y lógica relevante

### `_check_parent_recursion` — DocumentFolder
Constraint sobre `parent_id` que usa el helper nativo `_check_recursion()` de Odoo para impedir ciclos en el árbol.

### `_compute_effective_group_ids` / `_check_can_manage_self` — DocumentFolder
`_compute_effective_group_ids` arma, en un único método (pese al nombre, calcula tanto `effective_group_ids` como `effective_employee_ids`), la unión acumulativa de grupos y de empleados (ver campos arriba). `_check_can_manage_self` es el guardián de "el permiso da acceso al contenido, no a la carpeta en sí": comprueba que el usuario pertenezca a algún grupo de `effective_group_ids` del **padre**, o sea el `user_id` de algún empleado de `effective_employee_ids` del **padre** (no de la propia carpeta), o sea `base.group_system`, antes de dejar pasar `write`/`unlink` sobre la carpeta o abrir el wizard de permisos sobre ella.

### `_search_is_ancestor_of_accessible` / `_has_accessible_descendant` — DocumentFolder
Implementan `is_ancestor_of_accessible` (ver campo arriba). `_search_is_ancestor_of_accessible` es la vía real (usada por la `ir.rule`): busca con `sudo()` todas las carpetas con acceso real del usuario, junta sus `parent_path` en un solo set de ids de antepasados, y le resta las que ya son accesibles de por sí (para no marcar como "solo ancestro" una carpeta que además tiene acceso real, evitando conflicto con las otras dos ramas del `OR` de la `ir.rule`). `_has_accessible_descendant` hace lo mismo pero por registro (`child_of` en vez de `parent_path`), usado solo por el `compute` de respaldo que Odoo exige tener aunque en la práctica no se llame (el campo se consume casi siempre vía `search`, nunca leyendo el valor de un registro suelto).

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
Devuelve una acción `ir.actions.act_url` hacia `/web/content/{attachment_id}?download=true`; se dispara desde la opción "Descargar" del menú contextual de la tarjeta de documento en el kanban (antes se disparaba con el click directo sobre la tarjeta; ver Vistas y UI).

### `write` / `unlink` / `_log_movement` / `_prepare_movement_log_snapshots` / `_write_movement_logs` — DocumentFolder y DocumentFile
Cada `create`/`write`/`unlink` de carpeta o documento escribe en `document.movement.log` vía `sudo()` (quien mueve/borra no tiene por qué tener permiso de escritura sobre el historial, de solo lectura para administración). El snapshot "antes" (nombre, ruta, `is_locked`, grupos/empleados) se toma siempre ANTES de `super().write()`, porque después ya no se puede reconstruir el valor previo; se compara contra el estado ya escrito para decidir qué eventos disparar (un mismo `write` puede generar varios: p. ej. renombrar y mover a la vez). En `unlink` de `DocumentFolder`, se loguea cada carpeta afectada por la cascada (no solo las pedidas explícitamente) antes de que `super().unlink()` las borre, congelando su `folder_path` de una vez.

### `cron_clean_movement_logs` — DocumentMovementLog
Cron diario (`ir.cron`, ver `data/cron_document_movement_log_cleanup.xml`) que purga entradas de historial más antiguas que `dfd_documents.movement_log_retention_days` (Ajustes, 30 por defecto). 0 desactiva la purga (no borra nunca).

### `x_grant_manager_folder_permissions` — HrEmployee (`hr_employee.py`)
Aplica la regla de negocio del ajuste `dfd_documents.grant_manager_department_permissions`
("Dar permisos al gerente sobre todo su departamento al crear las carpetas", checkbox en
Ajustes junto a "Carpeta de Empleados", desactivado por defecto): si el empleado tiene
departamento **y** ese departamento tiene `manager_id`, da acceso (`allowed_employee_ids`,
`(4, manager.id)`) al gerente sobre la carpeta del **departamento** (alcanza a todas las
carpetas de empleado de dentro por herencia acumulativa normal, sin tener que tocarlas una a
una). Si no (sin departamento, o departamento sin gerente) pero el empleado tiene manager
directo (`parent_id`), da el acceso directamente sobre la carpeta del **empleado**. Sin
departamento-con-gerente ni manager directo, no hace nada. Solo añade, nunca quita, y evita
`write` redundante si el gerente ya está en la lista. Llamado desde `x_sync_default_folders`
en cada pasada cuando el ajuste está activo — no solo al crear, también sobre carpetas ya
existentes, así que activar el checkbox y volver a lanzar "Actualizar/Crear carpetas" (o el
botón individual de un empleado) basta para poner al día los permisos ya creados.

### `x_sync_default_folders` / `x_get_department_folder` — HrEmployee (`hr_employee.py`)
Único punto donde se crea la carpeta raíz de un empleado (dentro de `dfd_documents.document_folder_empleados`, o del parámetro configurado); lo llaman tanto `x_action_create_employee_folder` (botón manual en la ficha de `hr.employee`) como `EmployeeFolderSyncWizard.action_sync_folders` (acción masiva "Actualizar/Crear carpetas" del menú de Configuración), así que un único `create` cubre ambos flujos. Si el empleado tiene `department_id`, su carpeta se crea dentro de una subcarpeta con el nombre del departamento (bajo `root_folder`), buscada/creada bajo demanda por `x_get_department_folder` (`search` por `parent_id` + `name`, sin caché entre empleados del mismo lote: asume volumen bajo de departamentos, igual asunción que `get_folder_tree` en `document_folder.py`). Sin departamento, la carpeta del empleado cuelga directo de `root_folder`, igual que antes de este cambio. Al crear la carpeta del empleado, fija `allowed_employee_ids: [(6, 0, employee.ids)]` en el propio `create`: el empleado queda con acceso automático a su carpeta sin pasar luego por el wizard de Permisos a mano. Si el empleado aún no tiene `user_id`, esto no da acceso a nadie todavía (ver regla en `document_folder.py`), pero queda marcado para cuando se le asigne uno. La carpeta de departamento NO recibe este permiso explícito ni ningún otro: solo hereda lo que tenga `root_folder` (normalmente nada salvo `base.group_system`), así que por defecto ningún empleado ve la carpeta de un departamento ajeno, aunque sí la suya propia por su propio permiso directo. Las subcarpetas por defecto que se crean después (`document.employee.default.folder`) NO reciben este permiso explícito: lo heredan automáticamente de la carpeta del empleado por la herencia acumulativa normal (`effective_employee_ids`), así que no hace falta repetirlo ahí.

## Vistas y UI

- **Kanban de carpetas** (`view_document_folder_kanban`) usa `js_class="document_folder_kanban"` (registrado en `document_folder_bus.js`... realmente en el JS del renderer) y `on_create` apunta al wizard modal en vez de a una quick-create nativa.
- **`action_document_folder`** es la única acción de navegación de todo el módulo (dominio y contexto dinámicos, ver métodos arriba); su vista kanban es la única declarada (`action_document_folder_kanban_view`), no tiene vista lista ni form en el flujo normal (el form de `document.folder`/`document.file` existe pero solo es alcanzable editando el registro directamente, no desde la navegación kanban).
- **Menú "Historial"** (`action_document_movement_log`, reservado a `base.group_system`): tree/form/search de solo lectura sobre `document.movement.log`, con filtros por tipo (Carpetas/Documentos) y agrupación por tipo de evento/usuario/fecha.
- **Ajustes > Empleados > Documentos** (`res_config_settings_views.xml`): bloque con 3 settings — carpeta padre de empleados, checkbox de permisos de gerente, y días de retención del historial.
- **Ficha de empleado** (`hr_employee_views.xml`, dentro de la pestaña "Configuración"): grupo "Documentos" con botón "Crear carpetas" (si no tiene `x_document_folder_id`) o "Ir a la carpeta" (si ya la tiene).

### Frontend JS (OWL), en `static/src/js/`

El grid nativo de carpetas se extiende con overrides de vista registrados como `document_folder_kanban` (`registry.category("views")`):

- **`document_folder_bus.js`**: `EventTarget` singleton (`documentFolderBus`) para avisar "folder-tree-changed" entre componentes hermanos (kanban, wizard, árbol lateral) sin relación padre-hijo.
- **`document_folder_drag_state.js`**: estado reactivo singleton (`dragState.item`) compartido entre kanban, breadcrumb y árbol lateral durante un drag en curso (carpeta o documento); expone `callMoveItem` (despacha a `move_folder`/`move_file` según tipo) y `getMoveErrorMessage` (extrae el mensaje de una `ValidationError` del backend para mostrarlo tal cual en la notificación).
- **`document_folder_tree_sidebar.js`/`.xml`**: `DocumentFolderTreeSidebar`, panel lateral estilo árbol de Windows. Carga el árbol completo con `get_folder_tree`, expande automáticamente la rama de la carpeta activa (`expandAncestors`), y acepta drops de carpeta/documento en cualquier nodo. Se recarga al oír `folder-tree-changed`.
- **`document_folder_breadcrumb.js`/`.xml`**: `DocumentFolderBreadcrumb`, ruta clicable estilo explorador de archivos. **Oculta el breadcrumb nativo de Odoo manipulando el DOM directamente** (`display:none` sobre `.o_control_panel_breadcrumbs ol.breadcrumb`), porque el tema `spiffy_theme_backend` fuerza `noBreadcrumbs:false` desde JS con reglas `!important` que ganan a cualquier CSS o configuración de vista. Cada segmento de la ruta es zona de drop para mover un elemento a ese nivel ancestro de un solo arrastre.
- **`document_folder_kanban.js`** *(archivo del renderer/controller, referenciado en el manifest como parte de los assets aunque no tiene nombre propio de fichero separado — vive repartido en `document_folder_breadcrumb.js` en este árbol de lectura)*: define `DocumentFolderKanbanRenderer` (inyecta tarjetas de `document.file` junto a las carpetas nativas, gestiona upload por drag&drop desde el SO incluyendo árboles de carpetas vía `webkitGetAsEntry`, y borrado con confirmación) y `DocumentFolderKanbanController` (intercepta la búsqueda nativa del control panel para redirigirla a `search_and_go`, reimplementa `createRecord` para enganchar el cierre del wizard modal —el `actionService.doAction` no espera a que el usuario cierre el diálogo— y reimplementa `deleteRecord` para avisar al árbol lateral tras borrar).
  - **Tarjeta de documento**: en vez de descargar al click directo (comportamiento antiguo), la tarjeta completa es el `toggler` de un componente `Dropdown` (core, `@web/core/dropdown/dropdown`) que abre un menú con `DropdownItem` "Descargar" (`downloadFile`, antes `openFile`) y "Renombrar" (`renameFile`, abre `dfd_documents.action_document_file_rename_wizard` pasando `active_file_id` a mano en `additionalContext` porque el documento no es un registro Owl real del kanban). `renameFile` recarga `fileState.files` en el `onClose` del wizard para reflejar el nombre nuevo sin recargar toda la vista.
- **`document_folder_rename_menu.js`/`.xml`**: los tres items del cogMenu sobre carpetas — `RenameFolderMenuItem`, `PermissionsFolderMenuItem`, `DeleteFolderMenuItem` — más el patch de `importRecordsItem` para excluirlo de `document.folder`. **Toda la comprobación de permiso vive en `isDisplayed`, no dentro del componente**: `CogMenu` (core, `cog_menu.js`) resuelve `await item.isDisplayed(env)` de cada item registrado ANTES de decidir si lo cuenta en `hasItems`, así que un item sin permiso ni siquiera se monta y el botón de engranaje no aparece si ningún item pasa. Poner la comprobación dentro del componente (un `t-if` sobre un estado cargado en `onWillStart`) fue el primer intento y NO funciona bien: el componente se monta igual, `CogMenu` lo cuenta como "hay items" y el botón sale con el desplegable vacío.
  - `isFolderCogMenuCandidate(env)`: condición base sin permisos, solo "kanban de `document.folder` con carpeta activa".
  - `isDisplayedIfCanManage(env)` (usado por `RenameFolderMenuItem`/`DeleteFolderMenuItem`): además de `isFolderCogMenuCandidate`, hace `await env.services.orm.call("document.folder", "can_manage_folder", [folderId])` (envoltorio RPC de `_can_manage_self()`). Así ni la carpeta con acceso propio ni ninguna de sus antepasadas (visibles en modo solo lectura vía `is_ancestor_of_accessible`) muestran estas acciones a quien no tiene permiso en el padre.
  - `ToggleLockFolderMenuItem` (usado por `isDisplayedIfCanManage`, igual que Renombrar/Eliminar): alterna `is_locked` de la carpeta activa, con texto/icono "Bloquear"/"Desbloquear" según el valor leído en `onWillStart` (a diferencia de los demás items de este menú, que no cambian según el estado de la carpeta). Avisa `notifyFolderTreeChanged()` tras el cambio porque el árbol lateral pinta su propio candado por carpeta (`get_folder_tree` incluye `is_locked`).
  - `PermissionsFolderMenuItem`: su `isDisplayed` no hace RPC, usa `env.services.user.isAdmin` (sincronizado por Odoo con `base.group_system`, patrón visto en `web.ExportAll` del core). Es una restricción MÁS estricta que la de Renombrar/Eliminar (ver wizard de permisos arriba): nunca se muestra a un usuario con "solo" permiso en el padre, únicamente a administradores.

Reglas de negocio del drag&drop reforzadas también en cliente (antes de llamar al backend): no se resalta como destino válido la propia carpeta arrastrada, y un documento soltado fuera de cualquier tarjeta en el grid se queda donde está (no intenta "moverse a la carpeta activa", porque ya vive ahí).

## Dependencias externas

- **`spiffy_theme_backend`**: tema de terceros cuyo comportamiento de breadcrumb obliga al workaround de ocultación manual por DOM descrito arriba. Cualquier cambio en ese tema (o su actualización) puede romper el selector `.o_control_panel_breadcrumbs ol.breadcrumb`.
- **`mail`**: dependencia declarada en el manifest; no se usa mensajería/chatter visible en las vistas actuales (ni `mail.thread` ni `mail.activity.mixin` en los modelos).
- **`base`**: estándar.

## Notas para el agente

- Todo el módulo gira en torno a una única acción de navegación (`action_document_folder`) reconstruida con distinto `domain`/`context` en cada salto de nivel; no busques vistas de detalle por carpeta porque no existen en el flujo normal.
- El sidebar de árbol (`get_folder_tree`) trae **todas** las carpetas del sistema sin paginar: si el volumen de carpetas crece mucho, este método es el primer candidato a revisar por rendimiento.
- Cualquier cambio en el nombre de clase, `js_class` o registro `views` de este módulo debe revisarse junto con `spiffy_theme_backend`, ya que este último parchea comportamiento nativo de breadcrumbs desde JS.
- Hay `ir.rule` global (`data/access_permissions.xml`) sobre `document.folder` (3 ramas OR: `effective_group_ids`, `effective_employee_ids.user_id`, `is_ancestor_of_accessible`) y `document.file` (solo las 2 primeras ramas: un documento no tiene descendientes, así que no aplica lo de "antepasada visible"). **Ojo con la asimetría clave**: `effective_group_ids`/`effective_employee_ids` (acceso real, tanto para lectura vía `ir.rule` como referenciado por `_check_can_manage_self`) incluyen la propia carpeta, pero `is_ancestor_of_accessible` (visibilidad de solo lectura) **nunca** cuenta como acceso real — no se usa ni se debe usar en `_check_can_manage_self` ni en `_is_accessible_by_current_user`. Si alguna vez se necesita "¿puedo editar esto?", la respuesta correcta nunca pasa por `is_ancestor_of_accessible`, solo por acceso real del padre.
- Grupos y empleados permitidos son dos vías independientes con la misma mecánica de herencia acumulativa, calculadas en el mismo método `_compute_effective_group_ids` (pese al nombre) y comprobadas siempre juntas con OR, tanto en la `ir.rule` como en `_check_can_manage_self`. Un empleado sin `user_id` no rompe nada ni hace falta validarlo en el wizard: simplemente no aporta acceso hasta que se le asigne usuario.
- `is_ancestor_of_accessible` usa `sudo()` internamente a propósito (tanto en `_search_is_ancestor_of_accessible` como en `_has_accessible_descendant`): necesita poder "mirar" carpetas que la `ir.rule` del propio usuario ocultaría (las hermanas), precisamente para poder decidir con certeza que NO dan acceso y así no colarlas en el resultado. Si se quita el `sudo()` ahí, el cálculo se vuelve circular/incompleto porque la propia `ir.rule` que se está construyendo bloquearía la consulta que la sustenta.
- Los archivos JS de assets declarados en `__manifest__.py` no se corresponden 1:1 con nombres "obvios": `document_folder_kanban.scss` es solo estilos; la lógica del renderer/controller kanban vive en `document_folder_breadcrumb.js` pese a su nombre (exporta tanto `DocumentFolderBreadcrumb` como `DocumentFolderKanbanRenderer`/`Controller` y hace el `registry.category("views").add(...)`).
- **Gotcha de especificidad CSS al envolver una tarjeta de documento en un `Dropdown`**: el kanban nativo (`kanban_controller.scss`) aplica automáticamente `.o_kanban_record > div:not(.o_dropdown_kanban)` (especificidad con el elemento `div` incluido) con padding/border/background propios, pensado para que ese hijo directo sea el único nivel de "tarjeta". El wrapper `div.o-dropdown` que renderiza `Dropdown` pasa a ser ese hijo directo y hereda ese estilo nativo sumado al padding propio de `.o_dfd_folder_card` (el `<button>` toggler, más adentro), descuadrando el contenido hacia abajo/derecha. Un override con solo clases (`.o_dfd_file_dropdown { padding: 0; ... }`) pierde la cascada por tener menos especificidad que el selector nativo; hace falta calificarlo igual (`.o_kanban_record > div.o_dfd_file_dropdown`) para que gane. Ver `document_folder_kanban.scss`.
