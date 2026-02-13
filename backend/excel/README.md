# Importación desde Excel (Préstamos Yego)

Aquí van los scripts de importación y el archivo Excel. **Coloca en esta carpeta el archivo:**

- `Prestamos Yego (6).xlsx` (en la raíz del proyecto, fuera de frontend y backend)

## Scripts

| Script | Descripción |
|--------|-------------|
| `importExcelRptasPE.js` | Importa datos del Excel a la BD (Perú o Colombia). |
| `inspect-excel-headers.js` | Lista las columnas del Excel (Rptas PE, Cronogramas PE). |
| `inspect-excel-cronograma.js` | Inspecciona la hoja Cronogramas PE (fechas y formato). |
| `rollback-import-rptas-pe.js` | Elimina todos los datos importados (PE). |
| `rollback-import-rptas-co.js` | Elimina solo los datos de Colombia (CO). |

## Cómo ejecutar

Desde la carpeta **backend/**:

```bash
# Inspeccionar columnas del Excel
node excel/inspect-excel-headers.js
node excel/inspect-excel-cronograma.js

# Importar Perú (PE)
node excel/importExcelRptasPE.js

# Importar Colombia (CO)
node excel/importExcelRptasPE.js --country=CO

# Solo simular (no escribe en BD)
node excel/importExcelRptasPE.js --dry-run

# Límite de filas o debug
node excel/importExcelRptasPE.js --limit=20
node excel/importExcelRptasPE.js --debug

# Rollback (eliminar datos importados)
node excel/rollback-import-rptas-pe.js   # todo PE
node excel/rollback-import-rptas-co.js   # solo CO
```

Requiere que en **backend/** exista `.env.development` (o `.env`) con la conexión a PostgreSQL.
