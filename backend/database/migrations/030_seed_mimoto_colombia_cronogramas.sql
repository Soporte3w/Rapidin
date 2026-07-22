BEGIN;

-- Los planes son globales: podrán asignarse a cualquier flota colombiana activa.
INSERT INTO module_mimoto_cronograma
  (id, fleet_id, name, country, active, tasa_interes_mora, bono_tiempo_activo,
   cuotas_otros_gastos, requisitos_vehiculo)
VALUES
  ('c0780000-0000-4000-8000-000000000001', NULL, 'Plan 78 semanas - Portafolio general', 'CO', TRUE, 0.04, FALSE, 26,
   '{"source":"tarifario_2026-07-21","trips":{"40":17,"75":30}}'::jsonb),
  ('c0780000-0000-4000-8000-000000000002', NULL, 'Plan 78 semanas - Oferta especial', 'CO', TRUE, 0.04, FALSE, 26,
   '{"source":"tarifario_2026-07-21"}'::jsonb),
  ('c0610000-0000-4000-8000-000000000001', NULL, 'Plan 61 semanas - Victory Combat 100', 'CO', TRUE, 0.04, FALSE, 26,
   '{"source":"tarifario_2026-07-21","revision":"imagen_15.07.40"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  fleet_id = NULL,
  name = EXCLUDED.name,
  active = EXCLUDED.active,
  tasa_interes_mora = EXCLUDED.tasa_interes_mora,
  requisitos_vehiculo = EXCLUDED.requisitos_vehiculo,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO module_mimoto_cronograma_vehiculo
  (id, cronograma_id, name, inicial, inicial_moneda, cuotas_semanales,
   precio_total, moneda, metadata, orden, active)
VALUES
  ('78010000-0000-4000-8000-000000000001', 'c0780000-0000-4000-8000-000000000001', 'Sport KLS Spoke', 1250000, 'COP', 78, NULL, 'COP', '{"cuota_base":145000,"bono_40":20000,"bono_75":51000}', 1, TRUE),
  ('78010000-0000-4000-8000-000000000002', 'c0780000-0000-4000-8000-000000000001', 'Sport ELS Spoke sin maletero', 1250000, 'COP', 78, NULL, 'COP', '{"cuota_base":150000,"bono_40":22000,"bono_75":53000}', 2, TRUE),
  ('78010000-0000-4000-8000-000000000003', 'c0780000-0000-4000-8000-000000000001', 'Sport KLS Spoke TK', 1250000, 'COP', 78, NULL, 'COP', '{"cuota_base":150000,"bono_40":22000,"bono_75":53000}', 3, TRUE),
  ('78010000-0000-4000-8000-000000000004', 'c0780000-0000-4000-8000-000000000001', 'Sport ELS Spoke edición especial', 1250000, 'COP', 78, NULL, 'COP', '{"cuota_base":153000,"bono_40":21000,"bono_75":53000}', 4, TRUE),
  ('78010000-0000-4000-8000-000000000005', 'c0780000-0000-4000-8000-000000000001', 'Sport 100 ELS', 1300000, 'COP', 78, NULL, 'COP', '{"cuota_base":160000,"bono_40":22000,"bono_75":55000}', 5, TRUE),
  ('78010000-0000-4000-8000-000000000006', 'c0780000-0000-4000-8000-000000000001', 'Sport ELS Spoke TK', 1300000, 'COP', 78, NULL, 'COP', '{"cuota_base":160000,"bono_40":22000,"bono_75":55000}', 6, TRUE),
  ('78010000-0000-4000-8000-000000000007', 'c0780000-0000-4000-8000-000000000001', 'Neo NX 110', 1300000, 'COP', 78, NULL, 'COP', '{"cuota_base":160000,"bono_40":22000,"bono_75":55000}', 7, TRUE),
  ('78010000-0000-4000-8000-000000000008', 'c0780000-0000-4000-8000-000000000001', 'Sport 100 ELS Cargo', 1300000, 'COP', 78, NULL, 'COP', '{"cuota_base":162000,"bono_40":22000,"bono_75":55000}', 8, TRUE),
  ('78010000-0000-4000-8000-000000000009', 'c0780000-0000-4000-8000-000000000001', 'Stryker 125 Indo', 1350000, 'COP', 78, NULL, 'COP', '{"cuota_base":170000,"bono_40":24000,"bono_75":59000}', 9, TRUE),
  ('78010000-0000-4000-8000-000000000010', 'c0780000-0000-4000-8000-000000000001', 'Dazz 110', 1350000, 'COP', 78, NULL, 'COP', '{"cuota_base":171000,"bono_40":24000,"bono_75":58000}', 10, TRUE),
  ('78010000-0000-4000-8000-000000000011', 'c0780000-0000-4000-8000-000000000001', 'Raider 125 ACC', 1500000, 'COP', 78, NULL, 'COP', '{"cuota_base":187000,"bono_40":26000,"bono_75":64000}', 11, TRUE),
  ('78010000-0000-4000-8000-000000000012', 'c0780000-0000-4000-8000-000000000001', 'Raider 125 Racing', 1550000, 'COP', 78, NULL, 'COP', '{"cuota_base":192000,"bono_40":26000,"bono_75":65000}', 12, TRUE),
  ('78020000-0000-4000-8000-000000000001', 'c0780000-0000-4000-8000-000000000002', 'Sport 100 ELS', 1437500, 'COP', 78, NULL, 'COP', '{"cuota_base":153000,"bono_40":21000,"bono_75":43000}', 1, TRUE),
  ('78020000-0000-4000-8000-000000000002', 'c0780000-0000-4000-8000-000000000002', 'TVS Raider 125 ACC', 1532500, 'COP', 78, NULL, 'COP', '{"cuota_base":192000,"bono_40":26000,"bono_75":52500}', 2, TRUE),
  ('78020000-0000-4000-8000-000000000003', 'c0780000-0000-4000-8000-000000000002', 'Raider 125 Racing', 1782500, 'COP', 78, NULL, 'COP', '{"cuota_base":192000,"bono_40":26000,"bono_75":52500}', 3, TRUE),
  ('61010000-0000-4000-8000-000000000001', 'c0610000-0000-4000-8000-000000000001', 'Victory Combat 100 - Inicial 1.192.800', 1192800, 'COP', 61, NULL, 'COP', '{"cuota_base":156600,"bono_40":15000,"bono_75":30000}', 1, TRUE),
  ('61010000-0000-4000-8000-000000000002', 'c0610000-0000-4000-8000-000000000001', 'Victory Combat 100 - Inicial 500.000', 500000, 'COP', 61, NULL, 'COP', '{"cuota_base":181600,"bono_40":15000,"bono_75":30000}', 2, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  inicial = EXCLUDED.inicial,
  cuotas_semanales = EXCLUDED.cuotas_semanales,
  metadata = EXCLUDED.metadata,
  orden = EXCLUDED.orden,
  active = TRUE,
  deleted_at = NULL,
  updated_at = CURRENT_TIMESTAMP;

-- Las imágenes de referencia provienen del tarifario entregado por negocio.
UPDATE module_mimoto_cronograma_vehiculo
SET metadata = metadata || jsonb_build_object('image', '/mimoto/planes/plan-78-general.jpeg')
WHERE cronograma_id = 'c0780000-0000-4000-8000-000000000001';

UPDATE module_mimoto_cronograma_vehiculo
SET metadata = metadata || jsonb_build_object('image', '/mimoto/planes/plan-78-especial.jpeg')
WHERE cronograma_id = 'c0780000-0000-4000-8000-000000000002';

UPDATE module_mimoto_cronograma_vehiculo
SET metadata = metadata || jsonb_build_object('image', '/mimoto/planes/plan-61-victory.jpeg')
WHERE cronograma_id = 'c0610000-0000-4000-8000-000000000001';

INSERT INTO module_mimoto_cronograma_rule
  (id, cronograma_id, viajes, bono_moto, bono_moto_moneda,
   cuotas_por_vehiculo, cuota_moneda_por_vehiculo, pct_recaudo, cobro_saldo, orden)
VALUES
  ('78011000-0000-4000-8000-000000000001', 'c0780000-0000-4000-8000-000000000001', '0-39', 0, 'COP',
   '[{"vehiculo_id":"78010000-0000-4000-8000-000000000001","cuota":145000},{"vehiculo_id":"78010000-0000-4000-8000-000000000002","cuota":150000},{"vehiculo_id":"78010000-0000-4000-8000-000000000003","cuota":150000},{"vehiculo_id":"78010000-0000-4000-8000-000000000004","cuota":153000},{"vehiculo_id":"78010000-0000-4000-8000-000000000005","cuota":160000},{"vehiculo_id":"78010000-0000-4000-8000-000000000006","cuota":160000},{"vehiculo_id":"78010000-0000-4000-8000-000000000007","cuota":160000},{"vehiculo_id":"78010000-0000-4000-8000-000000000008","cuota":162000},{"vehiculo_id":"78010000-0000-4000-8000-000000000009","cuota":170000},{"vehiculo_id":"78010000-0000-4000-8000-000000000010","cuota":171000},{"vehiculo_id":"78010000-0000-4000-8000-000000000011","cuota":187000},{"vehiculo_id":"78010000-0000-4000-8000-000000000012","cuota":192000}]', '[]', 0, 0, 1),
  ('78011000-0000-4000-8000-000000000002', 'c0780000-0000-4000-8000-000000000001', '40-74', 0, 'COP',
   '[{"vehiculo_id":"78010000-0000-4000-8000-000000000001","cuota":125000},{"vehiculo_id":"78010000-0000-4000-8000-000000000002","cuota":128000},{"vehiculo_id":"78010000-0000-4000-8000-000000000003","cuota":128000},{"vehiculo_id":"78010000-0000-4000-8000-000000000004","cuota":132000},{"vehiculo_id":"78010000-0000-4000-8000-000000000005","cuota":138000},{"vehiculo_id":"78010000-0000-4000-8000-000000000006","cuota":138000},{"vehiculo_id":"78010000-0000-4000-8000-000000000007","cuota":138000},{"vehiculo_id":"78010000-0000-4000-8000-000000000008","cuota":140000},{"vehiculo_id":"78010000-0000-4000-8000-000000000009","cuota":146000},{"vehiculo_id":"78010000-0000-4000-8000-000000000010","cuota":147000},{"vehiculo_id":"78010000-0000-4000-8000-000000000011","cuota":161000},{"vehiculo_id":"78010000-0000-4000-8000-000000000012","cuota":166000}]', '[]', 0, 0, 2),
  ('78011000-0000-4000-8000-000000000003', 'c0780000-0000-4000-8000-000000000001', '75+', 0, 'COP',
   '[{"vehiculo_id":"78010000-0000-4000-8000-000000000001","cuota":94000},{"vehiculo_id":"78010000-0000-4000-8000-000000000002","cuota":97000},{"vehiculo_id":"78010000-0000-4000-8000-000000000003","cuota":97000},{"vehiculo_id":"78010000-0000-4000-8000-000000000004","cuota":100000},{"vehiculo_id":"78010000-0000-4000-8000-000000000005","cuota":105000},{"vehiculo_id":"78010000-0000-4000-8000-000000000006","cuota":105000},{"vehiculo_id":"78010000-0000-4000-8000-000000000007","cuota":105000},{"vehiculo_id":"78010000-0000-4000-8000-000000000008","cuota":107000},{"vehiculo_id":"78010000-0000-4000-8000-000000000009","cuota":111000},{"vehiculo_id":"78010000-0000-4000-8000-000000000010","cuota":113000},{"vehiculo_id":"78010000-0000-4000-8000-000000000011","cuota":123000},{"vehiculo_id":"78010000-0000-4000-8000-000000000012","cuota":127000}]', '[]', 0, 0, 3),
  ('78021000-0000-4000-8000-000000000001', 'c0780000-0000-4000-8000-000000000002', '0-39', 0, 'COP',
   '[{"vehiculo_id":"78020000-0000-4000-8000-000000000001","cuota":153000},{"vehiculo_id":"78020000-0000-4000-8000-000000000002","cuota":192000},{"vehiculo_id":"78020000-0000-4000-8000-000000000003","cuota":192000}]', '[]', 0, 0, 1),
  ('78021000-0000-4000-8000-000000000002', 'c0780000-0000-4000-8000-000000000002', '40-74', 0, 'COP',
   '[{"vehiculo_id":"78020000-0000-4000-8000-000000000001","cuota":132000},{"vehiculo_id":"78020000-0000-4000-8000-000000000002","cuota":166000},{"vehiculo_id":"78020000-0000-4000-8000-000000000003","cuota":166000}]', '[]', 0, 0, 2),
  ('78021000-0000-4000-8000-000000000003', 'c0780000-0000-4000-8000-000000000002', '75+', 0, 'COP',
   '[{"vehiculo_id":"78020000-0000-4000-8000-000000000001","cuota":110000},{"vehiculo_id":"78020000-0000-4000-8000-000000000002","cuota":139500},{"vehiculo_id":"78020000-0000-4000-8000-000000000003","cuota":139500}]', '[]', 0, 0, 3),
  ('61011000-0000-4000-8000-000000000001', 'c0610000-0000-4000-8000-000000000001', '0-39', 0, 'COP',
   '[{"vehiculo_id":"61010000-0000-4000-8000-000000000001","cuota":156600},{"vehiculo_id":"61010000-0000-4000-8000-000000000002","cuota":181600}]', '[]', 0, 0, 1),
  ('61011000-0000-4000-8000-000000000002', 'c0610000-0000-4000-8000-000000000001', '40-74', 0, 'COP',
   '[{"vehiculo_id":"61010000-0000-4000-8000-000000000001","cuota":141600},{"vehiculo_id":"61010000-0000-4000-8000-000000000002","cuota":166600}]', '[]', 0, 0, 2),
  ('61011000-0000-4000-8000-000000000003', 'c0610000-0000-4000-8000-000000000001', '75+', 0, 'COP',
   '[{"vehiculo_id":"61010000-0000-4000-8000-000000000001","cuota":126600},{"vehiculo_id":"61010000-0000-4000-8000-000000000002","cuota":151600}]', '[]', 0, 0, 3)
ON CONFLICT (id) DO UPDATE SET
  viajes = EXCLUDED.viajes,
  cuotas_por_vehiculo = EXCLUDED.cuotas_por_vehiculo,
  cuota_moneda_por_vehiculo = EXCLUDED.cuota_moneda_por_vehiculo,
  orden = EXCLUDED.orden,
  updated_at = CURRENT_TIMESTAMP;

COMMIT;
