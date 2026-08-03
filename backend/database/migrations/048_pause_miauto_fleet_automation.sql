-- Pausa preventiva para el despliegue del reproceso administrativo.
-- Los endpoints manuales del reporte Fleet no dependen de estos interruptores.
UPDATE module_miauto_automation_config
SET weekly_fleet_charge_enabled = FALSE,
    weekly_fleet_retry_enabled = FALSE,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
  AND (
    weekly_fleet_charge_enabled IS DISTINCT FROM FALSE
    OR weekly_fleet_retry_enabled IS DISTINCT FROM FALSE
  );
