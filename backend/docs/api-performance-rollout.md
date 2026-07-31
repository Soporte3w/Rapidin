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

1. Desplegar código sin ejecutar la migración de índices.
2. Confirmar en logs `dbQueryCount`, `dbDurationMs` y `dbPoolWaitMs`.
3. Verificar que no aparezca la advertencia de consultas concurrentes de `pg`.
4. Comprobar que no queden conexiones `idle in transaction` del backend.
5. Aplicar cada sentencia de `041_api_performance_indexes.sql` por separado.
6. Después de cada índice, verificar que sea válido:

```sql
SELECT c.relname AS index_name, i.indisvalid, i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname LIKE 'idx_%';
```

7. Ejecutar `ANALYZE` solamente sobre la tabla correspondiente.
8. Comparar p50/p95 durante un ciclo de uso antes de continuar.

El comando `npm run db:indexes:performance` ejecuta las sentencias de forma
secuencial, valida los ocho índices y actualiza las estadísticas de las tablas
afectadas. `npm run db:indexes:performance -- --check` solo verifica.

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
