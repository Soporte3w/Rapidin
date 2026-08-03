ALTER TABLE module_miauto_automation_config
  ADD COLUMN IF NOT EXISTS weekly_fleet_retry_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS weekly_fleet_retry_interval_minutes SMALLINT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS weekly_fleet_retry_max_attempts SMALLINT NOT NULL DEFAULT 6;

ALTER TABLE module_miauto_automation_config
  DROP CONSTRAINT IF EXISTS module_miauto_automation_config_fleet_retry_interval_check;

ALTER TABLE module_miauto_automation_config
  ADD CONSTRAINT module_miauto_automation_config_fleet_retry_interval_check
  CHECK (weekly_fleet_retry_interval_minutes BETWEEN 5 AND 240);

ALTER TABLE module_miauto_automation_config
  DROP CONSTRAINT IF EXISTS module_miauto_automation_config_fleet_retry_attempts_check;

ALTER TABLE module_miauto_automation_config
  ADD CONSTRAINT module_miauto_automation_config_fleet_retry_attempts_check
  CHECK (weekly_fleet_retry_max_attempts BETWEEN 1 AND 12);

CREATE TABLE IF NOT EXISTS module_miauto_fleet_charge_run (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_date DATE NOT NULL,
  execution_type TEXT NOT NULL,
  attempt_number SMALLINT,
  execution_id UUID,
  status TEXT NOT NULL DEFAULT 'running',
  queue_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  partial_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  remaining_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  CONSTRAINT module_miauto_fleet_charge_run_type_check
    CHECK (execution_type IN ('scheduled', 'retry', 'manual')),
  CONSTRAINT module_miauto_fleet_charge_run_status_check
    CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT module_miauto_fleet_charge_run_counts_check
    CHECK (
      queue_count >= 0 AND success_count >= 0 AND partial_count >= 0
      AND failed_count >= 0 AND remaining_count >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_fleet_charge_run_automatic_attempt
  ON module_miauto_fleet_charge_run (business_date, attempt_number)
  WHERE execution_type IN ('scheduled', 'retry');

CREATE INDEX IF NOT EXISTS idx_miauto_fleet_charge_run_recent
  ON module_miauto_fleet_charge_run (business_date DESC, started_at DESC);

CREATE TABLE IF NOT EXISTS module_miauto_fleet_charge_attempt (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES module_miauto_fleet_charge_run(id) ON DELETE CASCADE,
  cuota_semanal_id UUID REFERENCES module_miauto_cuota_semanal(id) ON DELETE SET NULL,
  solicitud_id UUID REFERENCES module_miauto_solicitud(id) ON DELETE SET NULL,
  external_driver_id TEXT,
  park_id TEXT,
  idempotency_token UUID NOT NULL DEFAULT uuid_generate_v4(),
  status TEXT NOT NULL DEFAULT 'running',
  reason TEXT,
  balance_fleet NUMERIC(12,2),
  amount_charged_fleet NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_credited_cuota NUMERIC(12,2) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  CONSTRAINT module_miauto_fleet_charge_attempt_status_check
    CHECK (status IN ('running', 'success', 'partial', 'failed')),
  CONSTRAINT module_miauto_fleet_charge_attempt_amounts_check
    CHECK (amount_charged_fleet >= 0 AND amount_credited_cuota >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_fleet_charge_attempt_token
  ON module_miauto_fleet_charge_attempt (idempotency_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_fleet_charge_attempt_running_cuota
  ON module_miauto_fleet_charge_attempt (cuota_semanal_id)
  WHERE status = 'running' AND cuota_semanal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_miauto_fleet_charge_attempt_run
  ON module_miauto_fleet_charge_attempt (run_id, started_at);

CREATE INDEX IF NOT EXISTS idx_miauto_fleet_charge_attempt_solicitud
  ON module_miauto_fleet_charge_attempt (solicitud_id, started_at DESC);
