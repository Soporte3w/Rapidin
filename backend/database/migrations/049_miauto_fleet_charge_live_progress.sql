ALTER TABLE module_miauto_fleet_charge_attempt
  DROP CONSTRAINT IF EXISTS module_miauto_fleet_charge_attempt_status_check;

ALTER TABLE module_miauto_fleet_charge_attempt
  ADD CONSTRAINT module_miauto_fleet_charge_attempt_status_check
  CHECK (status IN ('queued', 'running', 'success', 'partial', 'failed'));

DROP INDEX IF EXISTS uq_miauto_fleet_charge_attempt_running_cuota;

CREATE UNIQUE INDEX uq_miauto_fleet_charge_attempt_running_cuota
  ON module_miauto_fleet_charge_attempt (cuota_semanal_id)
  WHERE status IN ('queued', 'running') AND cuota_semanal_id IS NOT NULL;
