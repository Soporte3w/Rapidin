# Auditoría y Refactorización Integral — Yego Mi Auto

> **Documento**: Propuesta Técnica de Refactorización
> **Versión**: 2.0
> **Fecha**: Mayo 2026
> **Autor**: Arquitectura de Software Senior
> **Alcance**: Sistema Mi Auto (alquiler-venta vehicular)

---

## 1. DIAGNÓSTICO: PROBLEMAS ENCONTRADOS

### 1.1 Cobros Semanales — Errores de Cálculo

| ID | Problema | Ubicación | Severidad | Impacto Financiero |
|---|---|---|---|---|
| B-01 | Cascada PF se re-aplica en re-generaciones (no idempotente) | `CobroEngine.js` no tiene flag `cascade_applied` | **Crítico** | Doble cobro a cuotas antiguas. Conductor paga 2 veces. |
| B-02 | Yango falla → cuota con viajes=0, PF=0 | `miautoWeeklyCharge.js:119` | **Crítico** | Conductor paga cuota bruta completa sin descuento PF83. Diferencia puede ser cientos de soles. |
| B-03 | `paid_amount` recortado sin trazabilidad | `miautoCuotaSemanalService.js:persistPaidAmountCapsForSolicitud()` | **Alto** | Conductor ve desaparecer su abono. Imposible explicar en reclamo. |
| B-04 | `amount_due` difiere entre creación y consulta API | Distintas funciones usan `partnerFeesApplyToCuotaReduction` con valores opuestos | **Alto** | UI muestra un monto, BD tiene otro. |
| B-05 | `due_date` canónico vs almacenado: divergencia | `computeDueDateForMiAutoCuota` recalcula y pisa | **Alto** | Fecha de vencimiento cambia sin registro. |
| B-06 | Semana depósito sin validación de `fecha_inicio_cobro_semanal` | `isSemanaDepositoMiAuto` depende de un campo que puede ser null | **Alto** | Primera cuota mal identificada → monto incorrecto. |
| B-07 | Sin protección anti re-ejecución del cron | No hay lock, no hay flag `cron_execution_id` | **Alto** | Si el proceso se reinicia, el cron corre 2 veces. |
| B-08 | `montos_fuente = 'excel'` bloquea recálculos para siempre | Solución binaria: o es Excel o es sistema | **Medio** | Errores de tipeo en Excel nunca se corrigen. |

### 1.2 Cascada — Errores de Imputación

| ID | Problema | Severidad |
|---|---|---|
| C-01 | Sin idempotencia: misma ejecución 2 veces = doble imputación | **Crítico** |
| C-02 | FIFO por `due_date` pero no considera cuotas 'paid' mal etiquetadas con saldo real > 0 | **Alto** |
| C-03 | La cascada excluye la fila origen solo en el primer pase. El remanente nunca debería ir a la misma fila pero hay edge cases. | **Alto** |
| C-04 | `mergeCascadaAllocations` suma montos por `cuotaId` sin validar que el total no exceda el `pending` de esa cuota | **Medio** |

### 1.3 Mora — Errores de Cálculo

| ID | Problema | Severidad |
|---|---|---|
| M-01 | Mora sobre cuota BRUTA cuando amount_due ya es 0 (PF83 > cuota) | **Alto** |
| M-02 | `MORA_MAX_DIAS_ACUMULACION = null` → sin tope, mora crece indefinidamente | **Medio** |
| M-03 | Mora sobre saldo de capital pendiente: días desde `fecha_ultimo_abono` +1, pero si no hay usa días desde vencimiento — inconsistente | **Medio** |
| M-04 | `dueDateYmdForMoraDesdeSemana` tiene 4 fuentes distintas de fecha de vencimiento, prioridad ambigua | **Medio** |

### 1.4 Moneda — Errores de Conversión

| ID | Problema | Severidad |
|---|---|---|
| MN-01 | Moneda inferida del cronograma, no validada contra el Excel | **Alto** |
| MN-02 | `partner_fees_raw` en PEN se resta de `cuota_semanal` en USD sin convertir | **Crítico** |
| MN-03 | Tipo de cambio sin timestamp → si cambia, cálculos históricos no son reproducibles | **Alto** |
| MN-04 | `$`, `S/.`, `DÓLARES`, `USD`, `PEN` todos parseados con heurísticas | **Medio** |

### 1.5 Importación Excel — Errores de Proceso

| ID | Problema | Severidad |
|---|---|---|
| E-01 | `--delete-first` sin filtro = DELETE masivo | **Crítico** |
| E-02 | Sin transacción: importación parcial sin rollback | **Crítico** |
| E-03 | Matching fuzzy de cronograma/vehículo sin confirmación | **Alto** |
| E-04 | Duplicados: INSERT sin ON CONFLICT, fallback corrupto | **Alto** |
| E-05 | Sin conciliación post-import: no se verifica que Excel == BD | **Alto** |
| E-06 | `paidFlag === null` → SKIP silencioso de cuotas | **Medio** |
| E-07 | `montos_fuente = 'excel'` es binario. No hay granularidad por columna. | **Medio** |

---

## 2. RIESGOS

### 2.1 Riesgos de Negocio

| Riesgo | Probabilidad | Impacto |
|---|---|---|
| Conductor recibe cobro duplicado → reclamo → pérdida de confianza | Alta | Reputacional |
| Conductor paga de más por fallo Yango → exige devolución | Media | Financiero + Operativo |
| Importación Excel corrupta → 500 conductores con datos erróneos | Baja | Catastrófico |
| Auditoría externa no puede reconstruir un cobro → multa o sanción | Baja | Legal |

### 2.2 Riesgos Financieros

| Riesgo | Monto Estimado |
|---|---|
| Sobre-cobro por cascada duplicada (1 semana, 300 conductores, ~S/50 c/u) | S/15,000 |
| Cuota sin descuento PF83 (fallo Yango, 50 conductores, ~S/300 c/u) | S/15,000 |
| Mora mal calculada sobre cuota bruta (diferencia acumulada) | Variable |

### 2.3 Riesgos de Auditoría

- Imposibilidad de reconstruir un cálculo de hace 3 meses
- Sin registro de quién modificó un `paid_amount`
- Sin hash del archivo Excel importado para verificar integridad
- Triggers PostgreSQL capturan cambios pero sin contexto de negocio

---

## 3. NUEVA ARQUITECTURA

### 3.1 Principios de Diseño

1. **Single Source of Truth**: Cada dato tiene un solo lugar donde se calcula y persiste.
2. **Idempotencia**: Cada operación puede ejecutarse N veces con el mismo resultado.
3. **Inmutabilidad de datos financieros**: Una cuota generada no se modifica; se versiona.
4. **Trazabilidad completa**: Cada cálculo deja un registro JSONB reconstruible.
5. **Validación pre-importación**: Nadie importa sin validar estructura, tipos y reglas de negocio.
6. **Transaccionalidad**: Toda mutación financiera ocurre en una transacción ACID.

### 3.2 Diagrama de Capas

```
┌──────────────────────────────────────────────────────────┐
│                    API REST (routes)                      │
│   autenticación, autorización, correlation ID, logging    │
├──────────────────────────────────────────────────────────┤
│                    Business Services                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Cobro    │ │Cascada   │ │ Mora     │ │ Excel      │  │
│  │ Engine   │ │ Manager  │ │ Engine   │ │ Importer   │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘  │
│       │             │            │              │         │
│  ┌────┴─────────────┴────────────┴──────────────┴──────┐  │
│  │              Audit & Traceability Layer             │  │
│  │   CobroAuditTrail  │  DataAuditLog  │  BusinessEvent │  │
│  └─────────────────────┬───────────────────────────────┘  │
├────────────────────────┼──────────────────────────────────┤
│              Data Access Layer (raw SQL)                   │
├────────────────────────┼──────────────────────────────────┤
│                    PostgreSQL                              │
│  Tables │ Audit Tables │ Triggers │ Functions │ Indexes   │
└──────────────────────────────────────────────────────────┘
```

### 3.3 Módulo de Cobro — Versión 2.0

```
CobroEngineV2.generateWeeklyCharge(solicitudId, weekStart, income)
│
├── 1. IDEMPOTENCIA: verificar si ya se ejecutó esta semana
│   └── SELECT 1 FROM billing_audit_trail WHERE solicitud_id=X AND week_start_date=Y AND event_type='generated'
│       └── Si existe → retornar cuota existente (NO recalcular)
│
├── 2. CONTEXTO: cargar solicitud, cronograma, vehículo, fechaInicio
│
├── 3. YANGO: validar incomeResult
│   ├── ¿viajes > 0? → usar
│   ├── ¿falló Yango? → status='pending_yango_data', cuota con viajes=0 pero FLAG visible
│   └── ¿driver fired? → FLAG, no generar
│
├── 4. PLAN: resolver regla del cronograma
│   ├── ¿hay overdue en otra cuota? → forzarMaxCuota
│   └── ¿tramo por viajes? → regla normal
│
├── 5. CÁLCULO: computeAmountDueSemanal (puro)
│   ├── PF83 = partnerFeesRaw × 0.8333
│   ├── cuotaNeta = max(0, cuotaSemanal − PF83)
│   ├── comisionSobrePF = PF83 × (pctComision / 100)
│   └── amountDue = max(0, cuotaNeta + cobroSaldo + comisionSobrePF)
│
├── 6. CASCADA IDEMPOTENTE:
│   ├── execution_hash = SHA256(solicitudId + weekStart + PF + timestamp)
│   ├── ¿ya existe esta cascada? (hash en billing_audit_trail)
│   │   └── Sí → SKIP cascada
│   └── No → aplicar waterfall a cuotas antiguas
│
├── 7. MONEDA: validar y persistir
│   ├── moneda_origen (del cronograma)
│   ├── monto_origen
│   ├── moneda_sistema (PEN)
│   ├── tipo_cambio_id
│   └── monto_convertido (si aplica)
│
├── 8. MORA: calcular con LateFeeCalculator (puro)
│   ├── capitalMoroso = amountDue (cuota neta, no bruta)
│   ├── tasaDiaria = tasaInteresMora / 7
│   └── moraTotal = moraDiaria × días_atraso
│
├── 9. PERSISTIR: BEGIN TRANSACTION
│   ├── INSERT/UPDATE cuota_semanal
│   ├── INSERT billing_audit_trail (JSONB completo)
│   ├── INSERT business_event_log
│   └── COMMIT
│
└── 10. RETORNAR: { cuotaId, amountDue, pendingTotal, status, audit }
```

---

## 4. DISEÑO DE IDEMPOTENCIA

### 4.1 Principio

> "Si el cron corre 2 veces, la segunda debe ser un no-op."

### 4.2 Mecanismo

```sql
ALTER TABLE module_miauto_billing_audit_trail
  ADD COLUMN execution_hash TEXT UNIQUE;
```

```javascript
// En CobroEngineV2.generateWeeklyCharge()
const executionHash = crypto
  .createHash('sha256')
  .update(`${solicitudId}|${weekStartDate}|${partnerFees83}|${generatedBy}`)
  .digest('hex');

// Verificar si ya se ejecutó
const existing = await query(
  `SELECT 1 FROM module_miauto_billing_audit_trail
   WHERE solicitud_id = $1 AND week_start_date = $2
     AND event_type = 'generated' AND execution_hash = $3`,
  [solicitudId, weekStartDate, executionHash]
);

if (existing.rows.length > 0) {
  return { cuotaId: existingCuota.id, idempotent: true, skipped: true };
}
```

### 4.3 Para la Cascada

```javascript
const cascadeHash = crypto
  .createHash('sha256')
  .update(`${solicitudId}|${weekStartDate}|${poolAmount}|cascada`)
  .digest('hex');

// Verificar antes de aplicar
const cascadeExists = await query(
  `SELECT 1 FROM module_miauto_billing_audit_trail
   WHERE solicitud_id = $1 AND event_type = 'cascaded' AND execution_hash = $2`,
  [solicitudId, cascadeHash]
);

if (cascadeExists.rows.length > 0) {
  return { skipped: true, reason: 'cascada_ya_aplicada' };
}
```

---

## 5. DISEÑO DE MONEDA

### 5.1 Tabla de Tipo de Cambio (ampliada)

```sql
ALTER TABLE module_miauto_tipo_cambio
  ADD COLUMN IF NOT EXISTS effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';  -- manual | sunat | api
```

### 5.2 Columnas en Cuota Semanal

```sql
ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN moneda_origen TEXT,           -- PEN | USD
  ADD COLUMN monto_origen NUMERIC(12,2),   -- monto en moneda original
  ADD COLUMN tipo_cambio_id UUID,          -- FK a tipo_cambio usado
  ADD COLUMN moneda_sistema TEXT DEFAULT 'PEN',
  ADD COLUMN monto_convertido NUMERIC(12,2);
```

### 5.3 Reglas de Moneda

```
REGLA 1: Moneda explícita, nunca inferida
  - El cronograma define la moneda del plan (campo `moneda` en regla)
  - El Excel DEBE declarar la moneda en cada celda de monto ($ o S/.)
  - Si no se puede determinar → ERROR, no importar

REGLA 2: Conversión con tipo de cambio registrado
  - Toda conversión guarda: tipo_cambio_id, valor_usd_a_local, fecha
  - El tipo de cambio se toma de module_miauto_tipo_cambio al momento de la operación
  - Nunca se usa un tipo de cambio "actual" para operaciones pasadas

REGLA 3: Doble contabilidad
  - Monto en moneda origen (lo que ve el conductor)
  - Monto en moneda sistema (PEN, para consolidación y reportes)

REGLA 4: PF siempre en moneda de la cuota
  - partner_fees_raw viene de Yango en moneda local (PEN/COP)
  - Antes de restarlo de cuota_semanal, se convierte a la moneda de la cuota
  - Si cuota es USD → PF se convierte PEN→USD con tipo de cambio del día
```

---

## 6. DISEÑO DE IMPORTACIÓN EXCEL ROBUSTA

### 6.1 Pipeline de Importación

```
Fase 1: VALIDACIÓN PREVIA (sin tocar BD)
├── 1.1 Estructura: ¿existe la hoja? ¿columnas esperadas?
├── 1.2 Tipos: ¿fechas son fechas? ¿montos son números?
├── 1.3 Moneda: cada monto declara $, S/., USD, PEN. Sin ambigüedad.
├── 1.4 Duplicados: mismo placa+week_start en el Excel → ERROR
├── 1.5 Relaciones: placa → solicitud existe, cronograma → vehículo existe
└── 1.6 Reporte: todos los errores juntos, no uno por uno

Fase 2: DRY RUN (simulación completa)
├── 2.1 Simular todos los INSERT/UPDATE
├── 2.2 Detectar conflictos: PK violations, FK violations
├── 2.3 Mostrar: { inserts: 1500, updates: 30, conflicts: 5, skipped: 12 }
└── 2.4 Si conflicts > 0 → NO continuar sin --force

Fase 3: IMPORTACIÓN (transaccional)
├── 3.1 BEGIN TRANSACTION
├── 3.2 Para cada fila: INSERT/UPDATE con ON CONFLICT DO NOTHING
├── 3.3 Si error crítico → ROLLBACK completo
├── 3.4 Si éxito → COMMIT
└── 3.5 Registrar en module_miauto_import_log

Fase 4: CONCILIACIÓN
├── 4.1 Contar cuotas en Excel vs cuotas en BD
├── 4.2 Sumar montos en Excel vs suma amount_due en BD
├── 4.3 Si difieren → marcar import_log.status = 'completed_with_warnings'
└── 4.4 Reporte de diferencias
```

### 6.2 Estructura del Import Log (extendida)

```json
{
  "import_log_id": "uuid",
  "file_hash": "sha256...",
  "file_size_bytes": 123456,
  "import_type": "cuotas_semanales",
  "status": "completed",
  "validation": {
    "structure": "ok",
    "types": { "errors": 0, "warnings": 3 },
    "duplicates": { "in_excel": 0, "vs_db": 2 },
    "relations": { "missing_solicitudes": 1 }
  },
  "dry_run": {
    "inserts": 1500,
    "updates": 30,
    "conflicts": 0,
    "skipped": 12
  },
  "import": {
    "inserted": 1500,
    "updated": 30,
    "errors": 0,
    "duration_ms": 45000
  },
  "conciliation": {
    "cuotas_excel": 1530,
    "cuotas_bd": 1530,
    "match": true,
    "monto_total_excel": 796500.00,
    "monto_total_bd": 796500.00,
    "diferencia": 0
  }
}
```

### 6.3 Script Unificado

```
npm run miauto:importar-excel -- <archivo.xlsx>
  --validate-only     Solo validar, no importar
  --dry-run           Simular todo, no escribir
  --force             Importar aunque haya warnings
  --solicitud-id X    Solo procesar una solicitud
  --replace-existing  Reemplazar cuotas existentes (con confirmación)
```

---

## 7. CONCILIACIÓN POST-IMPORTACIÓN

### 7.1 Algoritmo

```javascript
async function reconcileImport(solicitudId, excelRows, dbRows) {
  const result = {
    match: true,
    differences: [],
    excel: { count: excelRows.length, totalMonto: sum(excelRows, 'amount_due') },
    db: { count: dbRows.length, totalMonto: sum(dbRows, 'amount_due') },
  };

  // 1. Comparar cantidad
  if (result.excel.count !== result.db.count) {
    result.match = false;
    result.differences.push({
      type: 'count_mismatch',
      excel: result.excel.count,
      db: result.db.count,
    });
  }

  // 2. Comparar montos por semana
  for (const excelRow of excelRows) {
    const dbRow = dbRows.find(r => r.week_start_date === excelRow.week_start_date);
    if (!dbRow) {
      result.differences.push({
        type: 'missing_in_db',
        week_start_date: excelRow.week_start_date,
        excel_monto: excelRow.amount_due,
      });
      result.match = false;
    } else if (Math.abs(excelRow.amount_due - dbRow.amount_due) > 0.01) {
      result.differences.push({
        type: 'amount_mismatch',
        week_start_date: excelRow.week_start_date,
        excel_monto: excelRow.amount_due,
        db_monto: dbRow.amount_due,
      });
      result.match = false;
    }
  }

  // 3. Comparar montos totales
  if (Math.abs(result.excel.totalMonto - result.db.totalMonto) > 0.01) {
    result.match = false;
    result.differences.push({
      type: 'total_mismatch',
      excel_total: result.excel.totalMonto,
      db_total: result.db.totalMonto,
    });
  }

  return result;
}
```

---

## 8. VALIDADOR DE INTEGRIDAD (ConsistencyChecker v2)

### 8.1 Checks Diarios (3:00 AM Lima)

```
Check 1: paid_amount <= amount_due + late_fee + 0.02
  → Si paid_amount > obligación → CRÍTICO (sobrepago)
  → Acción: ALERTA, no corregir automáticamente

Check 2: status consistente con paid_amount
  → paid >= amount_due + late_fee AND status != 'paid' → WARNING
  → paid = 0 AND status = 'paid' → CRÍTICO

Check 3: moneda de la cuota coincide con el cronograma
  → moneda cuota != moneda regla cronograma → WARNING

Check 4: week_start_date sin duplicados
  → misma solicitud + mismo week_start + más de 1 fila → CRÍTICO

Check 5: cascada consistente
  → suma de partner_fees_cascada_destino en fila origen no excede pool total

Check 6: montos_fuente = 'excel' y no ha sido pisado por 'sistema'
  → Si amount_due cambió pero montos_fuente sigue 'excel' → WARNING

Check 7: cuotas huérfanas (solicitud deleted o inexistente)
  → CRÍTICO

Check 8: pending_balance del préstamo coincide con suma de cuotas
  → CRÍTICO
```

---

## 9. PRUEBAS DE CÁLCULO — Fórmulas Matemáticas

### 9.1 Fórmula de `amount_due`

```
Dado:
  CS = cuotaSemanal (del cronograma, según tramo de viajes)
  PF = partner_fees_raw (de Yango, ingresos brutos semanales)
  PF83 = PF × 0.8333
  PCT = pctComision / 100
  CB = cobroSaldo

Sin cascada (semana depósito o sin PF):
  amount_due = max(0, CS − PF83 + CB + (PF83 × PCT))

Con cascada (PF va a cuotas antiguas):
  amount_due = max(0, CS + CB)   [PF83 y comisión van al pool]

Prueba:
  CS=520, PF=2500, PCT=0.10, CB=0
  PF83 = 2500×0.8333 = 2083.25
  Comisión = 2083.25×0.10 = 208.33
  amount_due = max(0, 520−2083.25+0+208.33) = max(0, −1354.92) = 0 ✓
  → Cuota cubierta por ingresos. Conductor no paga nada esta semana.
```

### 9.2 Fórmula de Mora

```
Dado:
  C = capital moroso (amount_due de la cuota)
  T = tasa_interes_mora (anual, ej. 0.15 = 15%)
  TD = T / 7  (tasa diaria)
  D = días de atraso (días civiles desde vencimiento hasta hoy)

  moraTotal = C × TD × D

Prueba:
  C=520, T=0.15, D=5
  TD = 0.15/7 = 0.02142857
  moraTotal = 520 × 0.02142857 × 5 = 55.71 ✓
```

### 9.3 Fórmula de Cascada

```
Pool = PF83 + (PF83 × PCT)
     = PF83 × (1 + PCT)

Distribución: FIFO por due_date ASC
  Para cada cuota antigua con pending > 0:
    aplicar = min(pool, pending)
    pool = pool − aplicar
    paid_amount += aplicar

Prueba:
  Cuota semana 20: pending=496.30
  Cuota semana 21: pending=520.00
  Pool = 2083.25 × 1.10 = 2291.58

  Semana 20: aplicar=min(2291.58, 496.30)=496.30 → pool=1795.28
  Semana 21: aplicar=min(1795.28, 520.00)=520.00 → pool=1275.28
  Semana 22: aplicar=min(1275.28, 520.00)=520.00 → pool=755.28
  ...
```

---

## 10. ESTRATEGIA DE ROLLBACK

### 10.1 Principio

> "Ante cualquier fallo, el sistema debe poder volver al estado anterior."

### 10.2 Mecanismos

| Escenario | Rollback |
|---|---|
| Cron falla a mitad | Transacción por solicitud. Si falla una, las demás siguen. |
| Importación Excel falla | BEGIN/ROLLBACK. Toda la importación es atómica. |
| Error en cascada | La cascada es parte de la misma transacción que la generación de cuota. |
| Modificación manual | `audit_log` guarda `old_data`. Revertir manualmente con respaldo. |
| Desastre | Backup diario `full-db-*.dump` + point-in-time recovery. |

### 10.3 Soft Delete

```sql
-- Nunca DELETE físico. Solo soft delete.
UPDATE module_miauto_cuota_semanal
SET deleted_at = NOW(), deleted_by = $userId
WHERE id = $cuotaId;
```

---

## 11. ESTRATEGIA DE PRUEBAS AUTOMATIZADAS

### 11.1 Tipos de Pruebas

| Tipo | Qué cubre | Framework |
|---|---|---|
| Unitarias | `computeAmountDueSemanal`, `computeLateFee`, `applyWaterfallPool` | Vitest / Jest |
| Integración | `generateWeeklyCharge` con DB de prueba | Supertest + pg-test |
| Contrato | API endpoints: POST /solicitudes, GET /cuotas | Supertest |
| Regresión | Datos históricos: mismo input → mismo output | Snapshot testing |

### 11.2 Suite Mínima

```javascript
describe('CuotaCalculator', () => {
  it('cuota con PF mayor a cuota bruta → amountDue = 0', () => {
    const r = computeAmountDueSemanal({ cuotaSemanal: 520, partnerFeesRaw: 2500, pctComision: 10, cobroSaldo: 0 });
    expect(r.amountDue).toBe(0);
  });

  it('semana depósito → PF no se aplica a reducción de cuota', () => {
    const r = computeAmountDueSemanal({ cuotaSemanal: 705, partnerFeesRaw: 0, pctComision: 0, cobroSaldo: 0 });
    expect(r.amountDue).toBe(705);
  });
});

describe('CascadaPoolManager', () => {
  it('distribuye FIFO por due_date', () => { /* ... */ });
  it('no excede pending de cada cuota', () => { /* ... */ });
  it('excluye la fila origen', () => { /* ... */ });
});

describe('LateFeeCalculator', () => {
  it('mora = 0 si no está vencida', () => { /* ... */ });
  it('mora proporcional a días de atraso', () => { /* ... */ });
  it('imputación: primero mora, luego capital', () => { /* ... */ });
});
```

---

## 12. PLAN DE IMPLEMENTACIÓN POR FASES

### Fase 0: Infraestructura (1 semana) — **COMPLETADO**

- [x] Tablas de auditoría: `module_rapidin_data_audit_log`, `module_rapidin_business_event_log`, `module_miauto_billing_audit_trail`, `module_miauto_import_log`
- [x] Triggers PostgreSQL en 17 tablas
- [x] Columnas `updated_by`, `deleted_at` en 13 tablas
- [x] Logger multi-canal (business, technical, audit)
- [x] Correlation ID middleware
- [x] AuditService (programático)
- [x] Organización de servicios en subcarpetas (solicitud, cobros, comprobantes, cuotas, etc.)

### Fase 1: Idempotencia y Protección (1 semana)

- [ ] Agregar `execution_hash` a `module_miauto_billing_audit_trail`
- [ ] CobroEngineV2: verificar hash antes de generar
- [ ] Cascada: hash de cascada para evitar doble imputación
- [ ] Cron lock: flag `cron_running` en BD para evitar doble ejecución
- [ ] `paid_amount` nunca se recorta sin registrar `paid_adjustment_log`

### Fase 2: Moneda y Tipo de Cambio (1 semana)

- [ ] Agregar columnas `moneda_origen`, `monto_origen`, `tipo_cambio_id`, `monto_convertido` a `cuota_semanal`
- [ ] Validación explícita de moneda en importación Excel
- [ ] Conversión PF Yango a moneda de cuota con tipo de cambio registrado
- [ ] Tipo de cambio con `effective_date` y `source`

### Fase 3: Importación Excel Robusta (2 semanas)

- [ ] Pipeline 4 fases: validación → dry-run → importación → conciliación
- [ ] `ON CONFLICT` en INSERTs
- [ ] Transacción atómica por importación
- [ ] Conciliación post-import con reporte
- [ ] Eliminar `--delete-first` peligroso
- [ ] Unificar scripts en `npm run miauto:importar-excel`

### Fase 4: Auditoría de Cobro Completa (1 semana)

- [ ] Extender `billing_audit_trail` con moneda, tipo de cambio, execution_hash
- [ ] Endpoint: `GET /audit/cobros/:solicitudId?reconstruct=true`
- [ ] Vista UI: "¿Por qué pagó este monto?" → despliega el billing_context
- [ ] Export PDF del cálculo para el conductor

### Fase 5: Pruebas y Validación (2 semanas)

- [ ] Suite de pruebas unitarias para CuotaCalculator, LateFeeCalculator, CascadaPoolManager
- [ ] Pruebas de integración para CobroEngineV2 con DB de prueba
- [ ] Pruebas de regresión con datos históricos reales (anonimizados)
- [ ] Pruebas de idempotencia: ejecutar 2 veces y verificar mismo resultado

### Fase 6: Migración y Limpieza (1 semana)

- [ ] Migrar `ensureCuotaSemanalForWeek` legacy → `CobroEngineV2.generateWeeklyCharge`
- [ ] Eliminar wrappers deprecated
- [ ] Limpiar código muerto en `miautoCuotaSemanalService.js`
- [ ] Documentar arquitectura final en `docs/arquitectura-mi-auto.md`

---

## 13. RESUMEN EJECUTIVO

| Dimensión | Estado Actual | Estado Objetivo |
|---|---|---|
| Cálculo de cuota | Disperso en 3 archivos, 3000+ líneas | Centralizado en `cobros/CobroEngine.js` (500 líneas) |
| Idempotencia | No existe | Hash-based, cada operación verificable |
| Cascada | Re-aplicable, sin protección | Hash único, skippeable |
| Moneda | Inferida, ambigua, sin trazabilidad | Explícita, con tipo de cambio registrado |
| Importación Excel | Sin validación, sin transacción, sin conciliación | 4 fases, atómica, conciliada |
| Auditoría | Triggers básicos sin contexto | JSONB completo, reconstruible, exportable |
| Pruebas | Cero | Suite unitaria + integración + regresión |
| Rollback | Manual, frágil | Soft-delete, backup, transacciones |

---

**Tiempo estimado total**: 7-8 semanas
**Prioridad**: Fase 1 (idempotencia) > Fase 2 (moneda) > Fase 3 (Excel)
**Riesgo si no se hace**: Pérdida financiera, reclamos de conductores, imposibilidad de auditoría externa.
