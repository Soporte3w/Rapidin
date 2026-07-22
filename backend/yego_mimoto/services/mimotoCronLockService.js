import { randomUUID } from 'node:crypto';
import { query } from '../../config/database.js';
import { assertMimotoIsolationSql } from './mimotoFinancialEngine.js';

export async function acquireMimotoCronLock(jobName, ttlMinutes = 30) {
  const executionId = randomUUID();
  const safeTtl = Math.max(1, Math.min(180, Number(ttlMinutes) || 30));
  const result = await query(
    assertMimotoIsolationSql(
      `INSERT INTO module_mimoto_cron_lock(job_name,locked,locked_at,locked_by,execution_id,expires_at)
       VALUES ($1,TRUE,CURRENT_TIMESTAMP,$2,$3,CURRENT_TIMESTAMP + ($4 * INTERVAL '1 minute'))
       ON CONFLICT (job_name) DO UPDATE SET
         locked=TRUE, locked_at=CURRENT_TIMESTAMP, locked_by=EXCLUDED.locked_by,
         execution_id=EXCLUDED.execution_id, expires_at=EXCLUDED.expires_at
       WHERE module_mimoto_cron_lock.locked=FALSE
          OR module_mimoto_cron_lock.expires_at < CURRENT_TIMESTAMP
       RETURNING execution_id`
    ),
    [jobName, `mimoto:${process.pid}`, executionId, safeTtl]
  );
  return result.rows[0]?.execution_id === executionId ? executionId : null;
}

export function releaseMimotoCronLock(jobName, executionId) {
  return query(
    assertMimotoIsolationSql(
      `UPDATE module_mimoto_cron_lock SET locked=FALSE, expires_at=NULL
       WHERE job_name=$1 AND execution_id=$2`
    ),
    [jobName, executionId]
  );
}
