-- Bono tiempo: si está activo en el cronograma, la bonificación por 4 pagos consecutivos
-- solo se otorga cuando en cada una de esas 4 semanas el conductor tuvo >= 120 viajes.
ALTER TABLE module_miauto_cronograma
  ADD COLUMN IF NOT EXISTS bono_tiempo_activo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN module_miauto_cronograma.bono_tiempo_activo IS 'Si true, el bono por 4 pagos consecutivos a tiempo solo se otorga si en cada una de esas 4 semanas el conductor tuvo al menos 120 viajes.';
