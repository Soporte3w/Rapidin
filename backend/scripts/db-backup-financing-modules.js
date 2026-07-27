/**
 * Respalda los modulos financieros sin incluir la tabla operativa public.drivers.
 *
 * Uso:
 *   node scripts/db-backup-financing-modules.js --env .env
 *   node scripts/db-backup-financing-modules.js --env .env.dev
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

const MODULE_PREFIXES = ['module_mimoto_', 'module_miauto_', 'module_rapidin_'];
const SHARED_TABLES = new Set(['systems_users_financiator', 'systems_roles_financiator']);
const EXCLUDED_RELATIONS = new Set(['public.drivers']);
const DUMP_RELKINDS = new Set(['r', 'p', 'v', 'm', 'f', 'S']);

function parseArgs(argv) {
  const options = { envFile: '.env', outputDir: path.join(backendDir, 'backups') };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--env') options.envFile = argv[++index];
    else if (arg === '--output-dir') options.outputDir = path.resolve(argv[++index]);
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }

  if (!options.envFile) throw new Error('Falta el valor de --env');
  return options;
}

function printHelp() {
  console.log(`Uso:
  node scripts/db-backup-financing-modules.js [opciones]

Opciones:
  --env <archivo>         Archivo de entorno relativo a backend (default: .env)
  --output-dir <carpeta>  Carpeta donde se guardara el respaldo
  -h, --help              Mostrar esta ayuda

Incluye:
  module_mimoto_*, module_miauto_*, module_rapidin_*, usuarios, roles y
  dependencias referenciadas por claves foraneas.

Excluye siempre:
  public.drivers`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function qualifiedName(relation) {
  return `${relation.schema}.${relation.name}`;
}

function pgDumpPattern(relation) {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return `${quote(relation.schema)}.${quote(relation.name)}`;
}

function connectionConfig(env) {
  if (env.DATABASE_URL?.trim()) return { connectionString: env.DATABASE_URL.trim() };

  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Configuracion DB incompleta: ${missing.join(', ')}`);

  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  };
}

function pgDumpConnectionArgs(env) {
  if (env.DATABASE_URL?.trim()) return [env.DATABASE_URL.trim()];
  return [
    '--host', env.DB_HOST,
    '--port', env.DB_PORT || '5432',
    '--username', env.DB_USER,
    env.DB_NAME,
  ];
}

function isInitialRelation(relation) {
  return MODULE_PREFIXES.some((prefix) => relation.name.startsWith(prefix))
    || SHARED_TABLES.has(relation.name);
}

function resolveRelations(relations, foreignKeys) {
  const byOid = new Map(relations.map((relation) => [relation.oid, relation]));
  const selected = new Set(
    relations
      .filter((relation) => DUMP_RELKINDS.has(relation.relkind) && isInitialRelation(relation))
      .map((relation) => relation.oid),
  );
  const dependencies = [];
  const skippedDependencies = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const foreignKey of foreignKeys) {
      if (!selected.has(foreignKey.source_oid) || selected.has(foreignKey.target_oid)) continue;
      const source = byOid.get(foreignKey.source_oid);
      const target = byOid.get(foreignKey.target_oid);
      if (!source || !target) continue;

      const dependency = {
        constraint: foreignKey.constraint_name,
        source: qualifiedName(source),
        target: qualifiedName(target),
      };
      if (EXCLUDED_RELATIONS.has(dependency.target)) {
        skippedDependencies.push(dependency);
        continue;
      }

      selected.add(target.oid);
      dependencies.push(dependency);
      changed = true;
    }
  }

  return {
    selected: relations
      .filter((relation) => selected.has(relation.oid))
      .sort((a, b) => qualifiedName(a).localeCompare(qualifiedName(b))),
    dependencies,
    skippedDependencies,
  };
}

async function getInventory(client) {
  const databaseResult = await client.query(`
    SELECT current_database() AS database,
           current_user AS database_user,
           inet_server_addr()::text AS server_address,
           version() AS postgres_version
  `);
  const relationResult = await client.query(`
    SELECT c.oid::int AS oid,
           n.nspname AS schema,
           c.relname AS name,
           c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_toast'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY n.nspname, c.relname
  `);
  const foreignKeyResult = await client.query(`
    SELECT conrelid::int AS source_oid,
           confrelid::int AS target_oid,
           conname AS constraint_name
    FROM pg_constraint
    WHERE contype = 'f'
  `);

  const resolved = resolveRelations(relationResult.rows, foreignKeyResult.rows);
  if (!resolved.selected.length) {
    throw new Error('No se encontraron relaciones de Mi Moto, Mi Auto o Rapidin');
  }

  const tables = resolved.selected.filter((relation) => ['r', 'p', 'm', 'f'].includes(relation.relkind));
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS total FROM ${pgDumpPattern(table)}`);
    table.rows = result.rows[0].total;
  }

  return { database: databaseResult.rows[0], ...resolved };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || 'sin detalle';
    throw new Error(`${command} fallo: ${detail}`);
  }
  return result.stdout;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const envPath = path.isAbsolute(options.envFile)
    ? options.envFile
    : path.resolve(backendDir, options.envFile);
  const parsedEnv = dotenv.parse(fs.readFileSync(envPath));
  const runtimeEnv = { ...process.env, ...parsedEnv };
  const client = new Client(connectionConfig(runtimeEnv));

  await client.connect();
  let inventory;
  try {
    inventory = await getInventory(client);
  } finally {
    await client.end();
  }

  const backupDir = path.join(
    options.outputDir,
    `financing-modules-${safeFileName(inventory.database.database)}-${timestamp()}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const dumpPath = path.join(backupDir, 'financing-modules.dump');
  const schemaPath = path.join(backupDir, 'schema.sql');
  const relationArgs = inventory.selected.flatMap((relation) => ['--table', pgDumpPattern(relation)]);
  const commonArgs = [
    '--no-owner',
    '--no-acl',
    '--exclude-table', 'public.drivers',
    ...relationArgs,
    ...pgDumpConnectionArgs(runtimeEnv),
  ];
  const dumpEnv = { ...runtimeEnv, PGPASSWORD: runtimeEnv.DB_PASSWORD || '' };

  run('pg_dump', ['--format=custom', '--compress=9', '--file', dumpPath, ...commonArgs], dumpEnv);
  run('pg_dump', ['--format=plain', '--schema-only', '--file', schemaPath, ...commonArgs], dumpEnv);
  fs.chmodSync(dumpPath, 0o600);
  fs.chmodSync(schemaPath, 0o600);

  const toc = run('pg_restore', ['--list', dumpPath], dumpEnv);
  if (/\bTABLE DATA public drivers\b/i.test(toc)) {
    throw new Error('Validacion fallida: public.drivers aparecio en el respaldo');
  }

  const [dumpChecksum, schemaChecksum] = await Promise.all([sha256(dumpPath), sha256(schemaPath)]);
  const manifest = {
    created_at: new Date().toISOString(),
    database: inventory.database,
    scope: {
      prefixes: MODULE_PREFIXES,
      shared_tables: [...SHARED_TABLES],
      excluded_relations: [...EXCLUDED_RELATIONS],
    },
    objects: inventory.selected.map(({ schema, name, relkind, rows }) => ({
      schema,
      name,
      type: relkind,
      ...(rows == null ? {} : { rows }),
    })),
    included_foreign_key_dependencies: inventory.dependencies,
    excluded_foreign_key_dependencies: inventory.skippedDependencies,
    files: {
      'financing-modules.dump': { sha256: dumpChecksum, bytes: fs.statSync(dumpPath).size },
      'schema.sql': { sha256: schemaChecksum, bytes: fs.statSync(schemaPath).size },
    },
    validation: {
      toc_entries: toc.split('\n').filter((line) => /^\d+;/.test(line)).length,
      public_drivers_included: false,
    },
  };

  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(backupDir, 'SHA256SUMS'),
    `${dumpChecksum}  financing-modules.dump\n${schemaChecksum}  schema.sql\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(backupDir, 'RESTORE.md'),
    `# Restauracion\n\nEste respaldo excluye deliberadamente \`public.drivers\`.\n\n\`\`\`bash\npg_restore --no-owner --no-acl --dbname=BASE_DESTINO financing-modules.dump\n\`\`\`\n\nLa base destino debe tener disponibles las dependencias externas indicadas en \`manifest.json\`.\n`,
    { mode: 0o600 },
  );

  console.log(JSON.stringify({
    ok: true,
    backup_dir: backupDir,
    objects: manifest.objects.length,
    rows: manifest.objects.reduce((sum, object) => sum + Number(object.rows || 0), 0),
    excluded: manifest.scope.excluded_relations,
    sha256: dumpChecksum,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
