-- La unicidad historica ignoraba ciclo y periodo, por lo que bloqueaba
-- nuevas anualidades y la reconciliacion del historial importado.
DROP INDEX IF EXISTS module_miauto_otros_gastos_solicitud_id_week_index_tipo_key;
