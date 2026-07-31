import crypto from 'node:crypto';

export const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
export const EXISTING_DATABASE_BASELINE = '040_mimoto_fleet_identity_by_plate.sql';
export const PENDING_EXIT_CODE = 10;

export function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

export function sortMigrationNames(names) {
  const sorted = [...names].sort((left, right) => left.localeCompare(right, 'en'));
  const invalid = sorted.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new Error(`Nombres de migración inválidos: ${invalid.join(', ')}`);
  }
  return sorted;
}

export function baselineMigrationNames(migrations, existingDatabase) {
  if (!existingDatabase) return [];
  const baselineIndex = migrations.findIndex(
    (migration) => migration.filename === EXISTING_DATABASE_BASELINE,
  );
  if (baselineIndex < 0) {
    throw new Error(
      `No se encontró la migración base ${EXISTING_DATABASE_BASELINE}`,
    );
  }
  return migrations.slice(0, baselineIndex + 1).map((migration) => migration.filename);
}

export function requiresNoTransaction(sql) {
  return /rapidin:migration-transaction\s+off/i.test(sql)
    || /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql);
}

function dollarQuoteAt(sql, index) {
  const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] || null;
}

export function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let state = 'normal';
  let dollarTag = '';
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    current += char;

    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        current += next;
        index += 1;
        blockDepth += 1;
      } else if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockDepth -= 1;
        if (blockDepth === 0) state = 'normal';
      }
      continue;
    }

    if (state === 'single-quote') {
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }

    if (state === 'double-quote') {
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag.slice(1);
        index += dollarTag.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += next;
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      current += next;
      index += 1;
      blockDepth = 1;
      state = 'block-comment';
    } else if (char === "'") {
      state = 'single-quote';
    } else if (char === '"') {
      state = 'double-quote';
    } else if (char === '$') {
      const tag = dollarQuoteAt(sql, index);
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarTag = tag;
        state = 'dollar-quote';
      }
    } else if (char === ';') {
      if (statementHasSql(current)) statements.push(current.trim());
      current = '';
    }
  }

  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error(`SQL incompleto: terminó dentro de ${state}`);
  }
  if (statementHasSql(current)) statements.push(current.trim());
  return statements;
}

function stripLeadingComments(statement) {
  let value = statement.trimStart();
  while (value.startsWith('--') || value.startsWith('/*')) {
    if (value.startsWith('--')) {
      const newline = value.indexOf('\n');
      return newline < 0 ? '' : stripLeadingComments(value.slice(newline + 1));
    }
    const end = value.indexOf('*/', 2);
    if (end < 0) return '';
    value = value.slice(end + 2).trimStart();
  }
  return value;
}

function statementHasSql(statement) {
  return stripLeadingComments(statement).replace(/;+\s*$/, '').trim().length > 0;
}

export function transactionPlan(sql) {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error('La migración no contiene sentencias SQL');

  const commands = statements.map((statement) => stripLeadingComments(statement).toUpperCase());
  const hasOuterTransaction = /^BEGIN(?:\s+TRANSACTION)?\s*;?$/.test(commands[0])
    && /^COMMIT\s*;?$/.test(commands.at(-1));
  const executable = hasOuterTransaction ? statements.slice(1, -1) : statements;

  const unexpectedControl = executable.find((statement) => {
    const command = stripLeadingComments(statement).toUpperCase();
    return /^(BEGIN|COMMIT|ROLLBACK)\b/.test(command);
  });
  if (unexpectedControl) {
    throw new Error('La migración contiene control de transacción interno no soportado');
  }

  return {
    noTransaction: requiresNoTransaction(sql),
    statements: executable,
  };
}
