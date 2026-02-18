# Importación desde Excel (Préstamos Yego)

**Coloca el archivo** `Prestamos Yego (6).xlsx` en la **raíz del proyecto** (fuera de frontend y backend).

El mismo Excel puede tener hojas para **Perú** y **Colombia**:
- **Perú:** `Rptas PE`, `Cronogramas PE` (o `Cronograma PE`)
- **Colombia:** `Rptas CO`, `Cronogramas CO` (o `Cronograma CO`)

Las columnas esperadas son las mismas que en Perú; para Colombia el documento del conductor puede venir como **Cédula** o **CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA**.

## Scripts

| Script | Descripción |
|--------|-------------|
| `importExcelRptasPE.js` | Importa datos del Excel a la BD (Perú por defecto; con `--country=CO` importa Colombia). |
| `importExcelRptasCO.js` | Importa **solo Colombia** (equivalente a `importExcelRptasPE.js --country=CO`). |
| `inspect-excel-headers.js` | Lista las columnas del Excel (Rptas PE/CO, Cronogramas PE/CO). |
| `inspect-excel-cronograma.js` | Inspecciona la hoja Cronogramas PE (fechas y formato). |
| `rollback-import-rptas-pe.js` | Elimina todos los datos importados de Perú (PE). |
| `rollback-import-rptas-co.js` | Elimina solo los datos importados de Colombia (CO). |

## Cómo ejecutar

Desde la carpeta **backend/**:

```bash
# Inspeccionar columnas del Excel (todas las hojas PE y CO)
node excel/inspect-excel-headers.js
node excel/inspect-excel-headers.js CO    # solo hojas Colombia
node excel/inspect-excel-headers.js PE    # solo hojas Perú
node excel/inspect-excel-cronograma.js

# ——— Importar Perú (PE) ———
node excel/importExcelRptasPE.js

# ——— Importar Colombia (CO) ———
node excel/importExcelRptasCO.js
# o: node excel/importExcelRptasPE.js --country=CO

# Solo simular (no escribe en BD)
node excel/importExcelRptasPE.js --dry-run
node excel/importExcelRptasCO.js --dry-run

# Solo crear préstamos para solicitudes desembolsadas que aún no tienen (usa hoja Cronograma: cuotas y fechas reales)
node excel/importExcelRptasPE.js --fix-missing-loans
# Con Excel desde Google Sheets (si no tienes el .xlsx en la raíz):
node excel/importExcelRptasPE.js --fix-missing-loans --google-sheet-id=TU_SHEET_ID
# O define EXCEL_GOOGLE_SHEET_ID en .env y no pases --google-sheet-id

# Límite de filas o debug
node excel/importExcelRptasPE.js --limit=20
node excel/importExcelRptasCO.js --limit=20
node excel/importExcelRptasCO.js --debug

# Rollback (eliminar datos importados)
node excel/rollback-import-rptas-pe.js   # solo Perú
node excel/rollback-import-rptas-co.js   # solo Colombia
```

Requiere que en **backend/** exista `.env.development` (o `.env`) con la conexión a PostgreSQL.
