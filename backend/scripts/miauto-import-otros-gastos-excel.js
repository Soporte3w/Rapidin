/**
 * Importa "Otros Gastos" desde el Excel PAGOS POST ENTREGA.
 * Match por nombre del conductor contra tabla drivers (Yango),
 * luego busca la solicitud activa por driver_id_fleet.
 *
 * Uso: node scripts/miauto-import-otros-gastos-excel.js [--dry-run]
 */
import { query } from '../config/database.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalizeName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function excelSerialToYmd(serial) {
  if (!serial || Number.isNaN(Number(serial))) return null;
  const n = Math.floor(Number(serial));
  const d = new Date(Date.UTC(1900, 0, 1));
  d.setUTCDate(d.getUTCDate() + n - 2);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseMonthYearHeader(header) {
  // "July 2025", "August 2025", "January - 2026"...
  const m = /^([a-z]+)\s*-?\s*(\d{4})$/i.exec(String(header || '').trim());
  if (!m) return null;
  const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  const mm = months[m[1].toLowerCase()];
  if (!mm) return null;
  const yyyy = parseInt(m[2], 10);
  return `${yyyy}-${String(mm).padStart(2, '0')}-01`;
}

function parseDayMonthHeader(header) {
  // "02 - February", "16 - February", "09/03", etc.
  let s = String(header || '').trim();
  // Format "DD - Month"
  let m2 = /^(\d{1,2})\s*-\s*([a-z]+)$/i.exec(s);
  if (m2) {
    const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    const mm = months[m2[2].toLowerCase()];
    if (!mm) return null;
    return `2026-${String(mm).padStart(2, '0')}-${String(parseInt(m2[1],10)).padStart(2, '0')}`;
  }
  // Format "DD/MM"
  let m3 = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m3) {
    return `2026-${String(parseInt(m3[2],10)).padStart(2, '0')}-${String(parseInt(m3[1],10)).padStart(2, '0')}`;
  }
  // Format "Month Year" like "January - 2026"
  let m4 = /^([a-z]+)\s*-\s*(\d{4})$/i.exec(s);
  if (m4) {
    const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    const mm = months[m4[1].toLowerCase()];
    if (!mm) return null;
    return `${m4[2]}-${String(mm).padStart(2, '0')}-01`;
  }
  // Format "DD - Month" with year like "09 - February"
  let m5 = /^(\d{1,2})\s*-\s*([a-z]+)$/i.exec(s);
  if (m5) {
    const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    const mm = months[m5[1].toLowerCase()]; // Wait, m5[1] is day, m5[2] is month
    const dd = parseInt(m5[1], 10);
    const mn = months[m5[2].toLowerCase()];
    if (!mn) return null;
    return `2026-${String(mn).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return null;
}

function mapStatusGPS(val) {
  const s = String(val || '').toLowerCase().trim();
  if (s === 'pagado') return 'paid';
  if (s === 'pendiente') return 'overdue';
  return 'pending'; // "Programado"
}

function mapStatusCheck(val) {
  if (val === true || val === '✔' || val === '✓' || String(val).toLowerCase() === 'true') return 'paid';
  return 'pending';
}

// ─── Driver Lookup ─────────────────────────────────────────────────────────

async function findDriverByName(name) {
  const norm = normalizeName(name);
  if (norm.length < 5) return null;
  // Fuzzy: buscar por palabras del nombre
  const words = norm.split(' ').filter(w => w.length > 2);
  if (words.length === 0) return null;
  const likeClauses = words.map((w, i) => `LOWER(d.first_name || ' ' || d.last_name) LIKE $${i + 1}`).join(' AND ');
  const params = words.map(w => `%${w}%`);
  const res = await query(
    `SELECT d.driver_id, d.first_name, d.last_name
     FROM drivers d
     WHERE d.work_status = 'working' AND ${likeClauses}
     ORDER BY LENGTH(d.first_name || ' ' || d.last_name) ASC
     LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

async function findSolicitudByDriver(driverId) {
  const res = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE driver_id_fleet = $1 AND status = 'aprobado' AND deleted_at IS NULL
     LIMIT 1`,
    [driverId]
  );
  return res.rows[0]?.id || null;
}

async function findSolicitudByPlaca(placa) {
  if (!placa || String(placa).trim().length < 4) return null;
  const res = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE UPPER(REGEXP_REPLACE(TRIM(placa_asignada), '\\s', '', 'g')) = 
           UPPER(REGEXP_REPLACE(TRIM($1), '\\s', '', 'g'))
       AND status = 'aprobado' AND deleted_at IS NULL
     LIMIT 1`,
    [String(placa).trim()]
  );
  return res.rows[0]?.id || null;
}

// ─── Import Functions ──────────────────────────────────────────────────────

async function importSheet(sheetName, rows, headerDates, tipo, moneda, getAmount, getStatusFn, dryRun, getPlaca = null) {
  let created = 0;
  let skipped = 0;
  let notFound = 0;

  for (const row of rows) {
    const name = String(row.__names__ || row._name || '');
    if (!name.trim()) { skipped++; continue; }

    const driver = await findDriverByName(name);
    let solId = null;

    if (driver) {
      solId = await findSolicitudByDriver(driver.driver_id);
    }

    // Fallback por PLACA si no encontró por nombre
    if (!solId && getPlaca) {
      const placa = getPlaca(row);
      if (placa) {
        solId = await findSolicitudByPlaca(placa);
        if (solId) {
          console.log(`  ✓ PLACA ${placa} → solicitud ${solId.slice(0,8)}...`);
        }
      }
    }

    if (!solId) {
      if (getPlaca) {
        const p = getPlaca(row);
        console.log(`  ⚠ No encontrado: "${name}"${p ? ' (' + p + ')' : ''}`);
      } else {
        console.log(`  ⚠ No encontrado en Yango: "${name}"`);
      }
      notFound++;
      continue;
    }

    console.log(`  ✓ ${driver ? driver.first_name + ' ' + driver.last_name : 'PLACA'} → solicitud ${solId.slice(0,8)}...`);

    let weekIdx = 0;
    for (const hdr of headerDates) {
      const dueDate = hdr.date;
      if (!dueDate) continue;
      const rawVal = row[hdr.key];
      const amount = getAmount(row, rawVal, weekIdx);
      const status = getStatusFn(rawVal);

      weekIdx++;

      if (dryRun) {
        console.log(`    [DRY] tipo=${tipo} wk=${weekIdx} due=${dueDate} amt=${amount} st=${status}`);
        created++;
        continue;
      }

      await query(
        `INSERT INTO module_miauto_otros_gastos (solicitud_id, tipo, week_index, due_date, amount_due, status, moneda)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7)
         ON CONFLICT (solicitud_id, week_index, tipo) DO UPDATE SET
           amount_due = EXCLUDED.amount_due,
           status = CASE WHEN module_miauto_otros_gastos.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
           due_date = EXCLUDED.due_date,
           updated_at = NOW()`,
        [solId, tipo, weekIdx, dueDate, amount, status, moneda]
      );
      created++;
    }
  }

  return { created, skipped, notFound };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const excelPath = args.find(a => a.endsWith('.xlsx')) || '../PAGOS POST ENTREGA (2) - GIOMAR 12-06-26.xlsx';

  let XLSX;
  try {
    XLSX = (await import('xlsx')).default || (await import('xlsx'));
  } catch {
    console.error('Error: xlsx no disponible. npm install xlsx');
    process.exit(1);
  }

  const wb = XLSX.readFile(excelPath);
  const totals = {};

  console.log(`\n📥 Importando Otros Gastos desde: ${excelPath}`);
  console.log(dryRun ? '🔍 MODO DRY-RUN (sin escritura)\n' : '💾 MODO ESCRITURA\n');

  // ── GPS ───────────────────────────────────────────────────────────────────
  if (wb.SheetNames.includes('GPS')) {
    console.log('📍 GPS...');
    const ws = wb.Sheets['GPS'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    // First row is header with month names
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.startsWith('__EMPTY') || h.includes('GPS')) continue;
      const d = parseMonthYearHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    // Map rows: col A = name, col C = fecha_serial, then monthly columns
    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '', // first column = name
      ...r,
    }));
    // Get amount from header: "GPS - s/47.20"
    const gpsHeader = Object.keys(allData[0] || {})[0] || '';
    const amtMatch = gpsHeader.match(/s\/\s*([\d.]+)/i);
    const gpsAmount = amtMatch ? parseFloat(amtMatch[1]) : 47.20;
    const gpsMoneda = gpsHeader.includes('$') ? 'USD' : 'PEN';

    totals.gps = await importSheet('GPS', rows, dateHeaders, 'gps', gpsMoneda,
      () => gpsAmount, mapStatusGPS, dryRun);
  }

  // ── Seguro RC ─────────────────────────────────────────────────────────────
  if (wb.SheetNames.includes('Seguro RC')) {
    console.log('\n🛡️ Seguro RC (SRC)...');
    const ws = wb.Sheets['Seguro RC'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.includes('SEGURO') || h === 'PLACA' || h === '#CEL.' || h === 'F. VENCIMIENTO' || h === 'MONTO A COBRAR' || h.startsWith('__EMPTY')) continue;
      const d = parseMonthYearHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '',
      __check_cols__: dateHeaders.map(dh => dh.key),
      ...r,
    }));

    totals.src = await importSheet('Seguro RC', rows, dateHeaders, 'src', 'PEN',
      (row, rawVal, idx) => {
        if (typeof rawVal === 'number' && rawVal > 0) return rawVal;
        // Check adjacent __EMPTY columns for checkmark
        const checkCols = row.__check_cols__ || [];
        if (idx < checkCols.length) {
          const chkCol = checkCols[idx];
          const emptyCols = Object.keys(row).filter(k => k.startsWith('__EMPTY') && row[k] === true);
          // Try to find matching __EMPTY with checkmark
          for (const ec of emptyCols) {
            const ecIdx = parseInt(ec.replace('__EMPTY', '').replace('_', '')) || 0;
            if (ecIdx > 0) {
              const hdrIdx = headers.indexOf(chkCol);
              if (ecIdx === hdrIdx + 1 || ecIdx === hdrIdx + 2) return 13;
            }
          }
        }
        return 13;
      },
      (rawVal) => {
        if (typeof rawVal === 'number' && rawVal > 0) return 'paid';
        return 'pending';
      }, dryRun);
  }

  // ── SOAT ──────────────────────────────────────────────────────────────────
  if (wb.SheetNames.includes('SOAT')) {
    console.log('\n🛡️ SOAT...');
    const ws = wb.Sheets['SOAT'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.includes('SOAT') || h === 'PLACA' || h === '#CEL.' || h === 'F. VENCIMIENTO' || h === 'MONTO A COBRAR' || h.startsWith('__EMPTY')) continue;
      const d = parseDayMonthHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '',
      ...r,
    }));

    totals.soat = await importSheet('SOAT', rows, dateHeaders, 'soat', 'PEN',
      () => 50,
      (rawVal) => {
        if (rawVal === true || rawVal === '✔' || rawVal === '✓') return 'paid';
        if (typeof rawVal === 'number' && rawVal > 0) return 'paid';
        return 'pending';
      }, dryRun);
  }

  // ── IMPUESTO VEHICULAR ────────────────────────────────────────────────────
  if (wb.SheetNames.includes('IMPUESTO VEHICULAR')) {
    console.log('\n🚗 Impuesto Vehicular...');
    const ws = wb.Sheets['IMPUESTO VEHICULAR'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.includes('IMPUESTO') || h === 'MODELO AUTO' || h === 'PLACA' || h === '#CEL.' || h === 'MONTO A COBRAR' || h.startsWith('__EMPTY')) continue;
      const d = parseDayMonthHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '',
      ...r,
    }));

    totals.impuesto = await importSheet('IMPUESTO VEHICULAR', rows, dateHeaders, 'impuesto_vehicular', 'PEN',
      (row, rawVal) => {
        if (typeof rawVal === 'number' && rawVal > 0) return rawVal;
        return 150; // fallback
      },
      (rawVal) => {
        if (rawVal === true || rawVal === '✔' || rawVal === '✓') return 'paid';
        if (typeof rawVal === 'number' && rawVal > 0) return 'paid';
        return 'pending';
      }, dryRun);
  }

  // ── STR + GPS ─────────────────────────────────────────────────────────────
  if (wb.SheetNames.includes('STR + GPS')) {
    console.log('\n🚗 STR + GPS...');
    const ws = wb.Sheets['STR + GPS'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.includes('SEGURO') || h === 'LICENCIA' || h === '# CELULAR' || h === 'AUTO' || h === 'F. Entrega' || h === 'Cuotas pagadas') continue;
      const d = parseDayMonthHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    
    const strMoneda = 'USD';
    const strAmount = 23.38;

    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '',
      ...r,
    }));

    totals.strgps = await importSheet('STR + GPS', rows, dateHeaders, 'todo_riesgo_mas_gps_agrupado', strMoneda,
      () => strAmount,
      mapStatusGPS, dryRun);
  }

  // ── Inicial Parcial ───────────────────────────────────────────────────────
  if (wb.SheetNames.includes('Inicial Parcial')) {
    console.log('\n💰 Inicial Parcial...');
    const ws = wb.Sheets['Inicial Parcial'];
    const allData = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = Object.keys(allData[0] || {});
    const dateHeaders = [];
    for (const h of headers) {
      if (h.includes('Inicial') || h === 'LICENCIA' || h === '# CELULAR' || h === 'MONTO' || h === 'F. Entrega' || h === 'Cuotas pagadas') continue;
      const d = parseDayMonthHeader(h);
      if (d) dateHeaders.push({ key: h, date: d });
    }
    
    const rows = allData.map(r => ({
      __names__: r[Object.keys(r)[0]] || '',
      ...r,
    }));

    totals.inicial = await importSheet('Inicial Parcial', rows, dateHeaders, 'inicial_parcial', 'USD',
      (row) => {
        const montoField = Object.keys(row).find(k => k === 'MONTO');
        const val = montoField ? parseFloat(row[montoField]) : 0;
        return val > 0 ? val : 19.23;
      },
      mapStatusGPS, dryRun);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('📊 RESUMEN');
  console.log('═══════════════════════════════════════════');
  let totalCreated = 0, totalSkipped = 0, totalNotFound = 0;
  for (const [name, t] of Object.entries(totals)) {
    console.log(`${name}: ${t.created} creadas, ${t.skipped} saltadas, ${t.notFound} no encontradas`);
    totalCreated += t.created;
    totalSkipped += t.skipped;
    totalNotFound += t.notFound;
  }
  console.log('───────────────────────────────────────────');
  console.log(`Total: ${totalCreated} creadas, ${totalSkipped} saltadas, ${totalNotFound} no encontradas`);
  if (dryRun) console.log('\n⚠ DRY RUN — no se escribió nada en la BD');
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
