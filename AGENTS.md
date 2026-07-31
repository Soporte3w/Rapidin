# Reglas de trabajo para Rapidin

Este archivo aplica a todo el repositorio.

## Flujo obligatorio

Después de implementar cambios solicitados:

1. Revisar `git status` y el diff completo para confirmar que solo se incluyan
   archivos relacionados con la tarea.
2. Ejecutar todas las validaciones indicadas abajo.
3. Corregir cualquier error causado por el cambio y repetir las validaciones.
4. No crear el commit si alguna validación requerida falla. Informar el fallo y
   distinguir claramente si es nuevo o preexistente.
5. Si todo pasa, crear un commit enfocado con formato Conventional Commits.

## Validaciones requeridas antes de cada commit

Desde la raíz del repositorio:

```bash
git diff --check

# Backend: lint si existe, sintaxis de todos los JS modificados y suite completa.
npm --prefix backend run lint --if-present
{
  git diff --name-only --diff-filter=ACMR -- '*.js' '*.cjs' '*.mjs'
  git diff --cached --name-only --diff-filter=ACMR -- '*.js' '*.cjs' '*.mjs'
  git ls-files --others --exclude-standard -- '*.js' '*.cjs' '*.mjs'
} | sort -u | while IFS= read -r file; do
  node --check "$file"
done
(cd backend && node --test tests/*.test.js)

# Frontend: lint y build de producción, incluso cuando el cambio principal sea backend.
npm --prefix frontend run lint
npm --prefix frontend run build
```

Cuando se modifiquen migraciones, índices o acceso a PostgreSQL y exista una
conexión de desarrollo/diagnóstico configurada, ejecutar además la verificación
de base de datos aplicable. Para los índices de rendimiento:

```bash
npm --prefix backend run db:indexes:performance -- --check
```

La ausencia de credenciales de base de datos no autoriza usar credenciales de
producción ni aplicar migraciones automáticamente; se debe informar esa
limitación.

## Migraciones de base de datos

- Cada cambio de esquema o datos se agrega como un nuevo archivo SQL numerado
  en `backend/database/migrations`; nunca se edita una migración ya aplicada.
- El nombre debe usar tres dígitos y snake_case, por ejemplo
  `042_descripcion_breve.sql`.
- Las migraciones son transaccionales por defecto. Para operaciones que no
  admitan transacción, agregar el comentario
  `-- rapidin:migration-transaction off` y escribir sentencias idempotentes.
- `deploy-production.sh` debe comprobar, respaldar, aplicar y volver a validar
  automáticamente todas las migraciones pendientes antes de reiniciar PM2.
- Nunca sustituir esta comprobación por un mensaje fijo ni exigir que el
  operador aplique manualmente una migración versionada.

## Seguridad del commit

- No incluir `.env`, credenciales, tokens, dumps, backups, uploads,
  `node_modules`, `frontend/dist` ni logs.
- No alterar o descartar cambios ajenos a la tarea.
- Preparar archivos explícitos cuando haya cambios no relacionados en el árbol.
- Usar mensajes como `fix(scope): ...`, `perf(scope): ...`, `feat(scope): ...` o
  `chore(scope): ...`.
- No hacer `git push`, desplegar, reiniciar PM2 ni aplicar migraciones salvo que
  el usuario lo solicite explícitamente.

## Entrega

Al finalizar, informar el hash y mensaje del commit, las validaciones ejecutadas
y cualquier paso operativo que todavía no se haya realizado.
