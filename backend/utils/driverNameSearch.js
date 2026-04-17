/**
 * Búsqueda por nombre de conductor: cada palabra debe aparecer en nombre completo,
 * nombre, apellido o DNI (útil cuando nombre y apellido van en columnas distintas).
 *
 * @param {string} tableAlias - Alias SQL de module_rapidin_drivers (ej. 'd', 'rd')
 * @param {string} rawQuery - Texto del usuario
 * @param {number} startParam - Primer índice $ de parámetro (1-based)
 * @returns {{ sql: string, params: string[], nextParam: number }} sql vacío si no hay texto
 */
export function buildDriverNameSearchSql(tableAlias, rawQuery, startParam) {
  const tokens = String(rawQuery ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return { sql: '', params: [], nextParam: startParam };
  }

  const d = tableAlias;
  const fullName = `concat_ws(' ', COALESCE(${d}.first_name,''), COALESCE(${d}.last_name,''))`;

  let sql = '';
  const params = [];
  let p = startParam;

  for (const token of tokens) {
    const safe = String(token).replace(/[%_]/g, '').trim();
    if (!safe) continue;
    const pattern = `%${safe}%`;
    sql += ` AND (
      ${fullName} ILIKE $${p}
      OR ${d}.first_name ILIKE $${p}
      OR ${d}.last_name ILIKE $${p}
      OR ${d}.dni ILIKE $${p}
    )`;
    params.push(pattern);
    p += 1;
  }

  if (!sql) return { sql: '', params: [], nextParam: startParam };
  return { sql, params, nextParam: p };
}

/**
 * Igual que buildDriverNameSearchSql pero sobre columnas planas (sin tabla), p. ej. log de cobros.
 */
export function buildDriverNameSearchSqlFlat(firstCol, lastCol, rawQuery, startParam) {
  const tokens = String(rawQuery ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return { sql: '', params: [], nextParam: startParam };
  }

  const fullName = `concat_ws(' ', COALESCE(${firstCol},''), COALESCE(${lastCol},''))`;
  let sql = '';
  const params = [];
  let p = startParam;

  for (const token of tokens) {
    const safe = String(token).replace(/[%_]/g, '').trim();
    if (!safe) continue;
    const pattern = `%${safe}%`;
    sql += ` AND (
      ${fullName} ILIKE $${p}
      OR ${firstCol} ILIKE $${p}
      OR ${lastCol} ILIKE $${p}
    )`;
    params.push(pattern);
    p += 1;
  }

  if (!sql) return { sql: '', params: [], nextParam: startParam };
  return { sql, params, nextParam: p };
}
