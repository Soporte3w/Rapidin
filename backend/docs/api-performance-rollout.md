# Despliegue seguro de optimizaciones API

## Variables opcionales

La aplicación conserva valores seguros por defecto y permite ajustar:

- `DB_POOL_MAX` (20)
- `DB_POOL_IDLE_TIMEOUT_MS` (120000)
- `DB_POOL_CONNECTION_TIMEOUT_MS` (30000)
- `DB_KEEPALIVE_INITIAL_DELAY_MS` (10000)
- `DB_APPLICATION_NAME` (`rapidin-api`)
- `DB_CONNECTION_OPTIONS` (`-c search_path=public`)
- `DB_SLOW_QUERY_MS` (500)
- `PARTNERS_API_TIMEOUT_MS` (5000)
- `FACTILIZA_TIMEOUT_MS` (10000)
- `EVOLUTION_GO_TIMEOUT_MS` (15000)
- `YANGO_API_TIMEOUT_MS` (15000)

## Orden de despliegue

`deploy-production.sh` verifica el historial de migraciones antes de reiniciar
el backend. Cuando encuentra archivos pendientes:

1. Genera un respaldo de las tablas financieras.
2. Toma un advisory lock exclusivo de PostgreSQL.
3. Ejecuta cada migración pendiente en orden de nombre.
4. Registra archivo, checksum, modo y duración en
   `public.rapidin_schema_migrations`.
5. Vuelve a comprobar que no quede ninguna migración pendiente.
6. Verifica que los ocho índices de rendimiento estén válidos y listos.

El respaldo requiere `pg_dump` y `pg_restore`. Si no están disponibles, el
Bash instala una sola vez el paquete cliente de PostgreSQL mediante `apt`,
`dnf`, `yum` o `apk`; en ejecuciones posteriores omite esa instalación.

Si `git pull` descarga un commit nuevo, el proceso se reinicia una sola vez
desde el Bash actualizado. Esto evita continuar el despliegue con instrucciones
antiguas que ya estaban cargadas antes del pull.

Si cualquiera de esos pasos falla, el despliegue se detiene antes de reiniciar
PM2 o publicar el frontend. Después del despliegue:

1. Confirmar en logs `dbQueryCount`, `dbDurationMs` y `dbPoolWaitMs`.
2. Verificar que no aparezca la advertencia de consultas concurrentes de `pg`.
3. Comprobar que no queden conexiones `idle in transaction` del backend.
4. Comparar p50/p95 durante un ciclo de uso.

La validación de índices equivale a comprobar:

```sql
SELECT c.relname AS index_name, i.indisvalid, i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname LIKE 'idx_%';
```

El comando `npm run db:indexes:performance` ejecuta las sentencias de forma
secuencial, valida los ocho índices y actualiza las estadísticas de las tablas
afectadas. `npm run db:indexes:performance -- --check` solo verifica.

En una base existente sin historial, la primera ejecución registra como
baseline las migraciones hasta `040` y ejecuta `041` de forma idempotente. Las
siguientes migraciones se aplican una sola vez. Un archivo ya registrado nunca
debe editarse: el checksum hará fallar el despliegue.

## Pendientes de infraestructura

Estas acciones no se automatizan desde el repositorio:

- Acercar el backend y PostgreSQL para reducir el tiempo de red por consulta.
- Habilitar `pg_stat_statements` y `track_io_timing` en una ventana de
  mantenimiento para observar consultas e I/O reales.
- Revisar `shared_buffers`, `work_mem` y la actualización de PostgreSQL según
  la memoria disponible y la carga de todos los sistemas que comparten la BD.
- Definir retención o particionamiento del audit log antes de eliminar datos.
- Programar backups recurrentes y mantener al menos una copia fuera del host.

## Rollback

El código puede revertirse por commit sin revertir datos. Los índices son
aditivos y pueden permanecer durante el rollback. Si alguno queda inválido:

```sql
DROP INDEX CONCURRENTLY IF EXISTS nombre_del_indice;
```

No eliminar índices preexistentes hasta observar uso real durante varios días.
