# Planteamiento: control por frecuencia de cuotas (semanal, diaria, anual)

## Cómo está hoy

- **Cuotas:** siempre **semanal**. Número de cuotas = número de semanas (`weeks`).
- **Tasa:** `interest_rate` en `module_rapidin_cycle_config` se interpreta como **% por periodo**, donde 1 periodo = **1 semana** (ej. 5 = 5% semanal).
- **Vencimientos:** cada cuota vence 7 días después de la anterior: `due_date = firstPaymentDate + k * 7`.
- **Condiciones:** `module_rapidin_loan_conditions` tiene `min_weeks`, `max_weeks`, `payment_day_of_week` (día de la semana, ej. 1 = lunes).

---

## Objetivo

Poder configurar y usar **tres frecuencias** (o al menos semanal + otra):

| Frecuencia | Cuota cada | Tasa en BD | Ejemplo |
|------------|------------|------------|---------|
| **Semanal** | 7 días | % semanal (actual) | 5% semanal, 12 cuotas = 12 semanas |
| **Diaria** | 1 día | % diaria (o convertir desde TEA/TED) | X% diario, 30 cuotas = 30 días |
| **Anual** | 1 año (o mensual si “anual” = plazo 1 año) | TEA y convertir a tasa por periodo | TEA 60%, 12 cuotas mensuales = 1 año |

Hay que aclarar si “anual” significa:
- **A)** Cuotas **cada 12 meses** (1 cuota por año), o  
- **B)** Plazo total **1 año** con cuotas **mensuales** (12 cuotas), o  
- **C)** Solo que la **tasa** se guarde como TEA y se convierta a la tasa por periodo (semanal/diaria) para el cálculo.

---

## Cambios propuestos

### 1. Base de datos

**Opción A – Nueva columna de frecuencia en ciclo (recomendada)**  
En `module_rapidin_cycle_config` (o en `module_rapidin_loan_conditions` si aplica por país):

- `installment_frequency` VARCHAR: `'weekly' | 'daily' | 'monthly' | 'yearly'`.
- Opcional: `installment_interval_days` INTEGER (ej. 7, 1, 30) para no depender solo del enum.

En `module_rapidin_loan_conditions` (si quieres límites por frecuencia):

- En vez de solo `min_weeks` / `max_weeks`, algo como:
  - `min_installments`, `max_installments`, y que el “periodo” venga de la frecuencia (semanal → min/max en “semanas” equivalentes, o directamente en número de cuotas).

**Opción B – Sin nueva tabla**  
Solo agregar `installment_frequency` (y si aplica `interest_rate_type` ya existe como TEA/TES/TED) y que el backend interprete:

- `weekly` → como hoy (cuota cada 7 días, tasa % por semana).
- `daily` → cuota cada 1 día, tasa % por día (o TEA → TED y usar TED en la fórmula).
- `monthly` / `yearly` → cuota cada 30 días o cada 365, tasa por mes o por año (o TEA y convertir a tasa mensual).

### 2. Tasa por periodo

La fórmula de cuota fija usa **tasa por periodo** `i`:

- **Semanal:** `i = interest_rate / 100` (ya está así).
- **Diaria:**  
  - Si guardas tasa diaria: `i = tasa_diaria / 100`.  
  - Si guardas TEA: `i = (1 + TEA/100)^(1/365) - 1` (TED).
- **Mensual:** `i = (1 + TEA/100)^(1/12) - 1` (tasa mensual desde TEA).
- **Anual (1 cuota por año):** `i = TEA/100`, 1 cuota, `due_date` + 365 días.

En `calculationsService.js`:

- Leer `installment_frequency` (y si aplica `interest_rate_type`) del ciclo/condiciones.
- Calcular `i` según frecuencia y tipo de tasa (semanal/diaria/TEA).
- Calcular número de cuotas y plazos en días según la misma frecuencia.

### 3. Fechas de vencimiento (`due_date`)

Hoy:

```js
dueDate.setDate(startDate.getDate() + k * 7);
```

Con frecuencia:

- `weekly` → `+ k * 7`
- `daily` → `+ k * 1`
- `monthly` → `+ k * 30` (o mejor: sumar 1 mes con `setMonth`/lógica de mes)
- `yearly` → `+ k * 365` (o sumar 1 año)

Conviene una función `addPeriodToDate(startDate, k, frequency)` que devuelva la fecha de la cuota `k`.

### 4. Límites (min/max) de cuotas

- Hoy: `min_weeks`, `max_weeks` (ej. 4–24 semanas).
- Con frecuencias: definir si sigues en “semanas” y conviertes a número de cuotas según frecuencia (ej. 4 semanas diarias = 28 cuotas), o si pasas a `min_installments` / `max_installments` por país (o por ciclo) y el “tamaño” del periodo lo da la frecuencia.

### 5. API y frontend

- **Configuración de ciclos:** en el formulario de ciclo, selector de **frecuencia de cuota** (semanal / diaria / mensual / anual) y, si aplica, que `interest_rate` sea “% por periodo” según esa frecuencia, o TEA y el backend convierta.
- **Simulación:** enviar `frequency` (o leerla del ciclo) y opcionalmente número de cuotas; respuesta con `installment_amount`, `due_dates` y texto tipo “X cuotas semanales/diarias/mensuales”.
- **Creación de préstamo:** guardar en el préstamo la `installment_frequency` usada (o derivarla del ciclo) para que el cronograma y reportes sean consistentes.

### 6. Tabla `module_rapidin_loans`

- Opcional: columna `installment_frequency` (o `payment_frequency`) para que cada préstamo quede con la frecuencia con la que se generó (útil para reportes y para no depender solo del ciclo por si cambias la config después).

---

## Resumen de pasos

1. Definir en BD: `installment_frequency` (y si hace falta `installment_interval_days` o min/max en cuotas).
2. En `getInterestRate` (o nueva función): devolver tasa **por periodo** según `interest_rate` + `interest_rate_type` + `installment_frequency`.
3. En `simulateLoanOptions` y `generateInstallmentSchedule`: usar esa tasa por periodo y calcular `due_date` con `addPeriodToDate(..., frequency)`.
4. En condiciones: ajustar límites (semanas vs número de cuotas) según frecuencia.
5. En API de ciclos y de simulación/desembolso: exponer y recibir frecuencia; en front, selector semanal/diaria/anual (y mensual si aplica).

Si me dices si “anual” es A, B o C (arriba), se puede bajar esto a cambios concretos de columnas y funciones en tu código actual (archivo por archivo).
