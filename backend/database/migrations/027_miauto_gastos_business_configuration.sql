-- Migra reglas de negocio historicas a la configuracion de cada vehiculo.
-- El runtime deja de asumir montos, plazos o vigencias cuando faltan en JSONB.

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = (COALESCE(requisitos_gastos, '{}'::jsonb) - 'todo_riesgo')
      || jsonb_build_object(
        'gps', COALESCE(requisitos_gastos -> 'gps', '{}'::jsonb)
          || jsonb_build_object('cobro', COALESCE(requisitos_gastos #> '{gps,cobro}', '{}'::jsonb)),
        'soat', COALESCE(requisitos_gastos -> 'soat', '{}'::jsonb)
          || jsonb_build_object('cobro', COALESCE(requisitos_gastos #> '{soat,cobro}', '{}'::jsonb)),
        'impuesto_vehicular', COALESCE(requisitos_gastos -> 'impuesto_vehicular', '{}'::jsonb)
          || jsonb_build_object(
            'cobro', COALESCE(requisitos_gastos #> '{impuesto_vehicular,cobro}', '{}'::jsonb)
          ),
        'todo_riesgo_mas_gps_agrupado',
          COALESCE(requisitos_gastos -> 'todo_riesgo_mas_gps_agrupado', '{}'::jsonb)
          || jsonb_build_object(
            'cobro', COALESCE(
              requisitos_gastos #> '{todo_riesgo_mas_gps_agrupado,cobro}',
              '{}'::jsonb
            )
          ),
        'inicial_parcial', COALESCE(requisitos_gastos -> 'inicial_parcial', '{}'::jsonb)
          || jsonb_build_object(
            'cobro', COALESCE(requisitos_gastos #> '{inicial_parcial,cobro}', '{}'::jsonb)
          )
      ),
    updated_at = CURRENT_TIMESTAMP;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      COALESCE(requisitos_gastos, '{}'::jsonb) #- '{gps,cobro,dia_mes}',
      '{gps,cobro,tipo}', '"fin_de_mes"'::jsonb, true
    ),
    updated_at = CURRENT_TIMESTAMP;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{gps,monto}', '47.20'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{gps,monto}', '')::numeric, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{gps,moneda}', '"PEN"'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE requisitos_gastos #>> '{gps,moneda}' IS NULL;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{soat,monto}', '200'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{soat,monto}', '')::numeric, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{soat,moneda}', '"PEN"'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE requisitos_gastos #>> '{soat,moneda}' IS NULL;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{soat,cobro,cuotas}', '4'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{soat,cobro,cuotas}', '')::int, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{soat,cobro,meses_anticipo}',
      '4'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{soat,cobro,meses_anticipo}', '')::int, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{impuesto_vehicular,cobro,mes_inicio}',
      '2'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{impuesto_vehicular,cobro,mes_inicio}', '')::int, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{impuesto_vehicular,cobro,cuotas}',
      '4'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{impuesto_vehicular,cobro,cuotas}', '')::int, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{impuesto_vehicular,cobro,anios_vigencia_tras_modelo}',
      '3'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(
        NULLIF(requisitos_gastos #>> '{impuesto_vehicular,cobro,anios_vigencia_tras_modelo}', '')::int,
        0
      ) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{todo_riesgo_mas_gps_agrupado,cobro,semanas}',
      '26'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(
        NULLIF(requisitos_gastos #>> '{todo_riesgo_mas_gps_agrupado,cobro,semanas}', '')::int,
        0
      ) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{inicial_parcial,monto}', '19.23'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{inicial_parcial,monto}', '')::numeric, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      requisitos_gastos,
      '{inicial_parcial,cobro,semanas}',
      '26'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{inicial_parcial,cobro,semanas}', '')::int, 0) <= 0;

UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(requisitos_gastos, '{inicial_parcial,moneda}', '"USD"'::jsonb, true),
    updated_at = CURRENT_TIMESTAMP
WHERE requisitos_gastos #>> '{inicial_parcial,moneda}' IS NULL;
