import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  RotateCcw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate, formatDateTime } from '../../utils/date';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError, unwrapApiData } from '../../utils/miautoApiUtils';
import { getMiautoAdjuntoUrl, miautoFmtMonto, miautoNum } from '../../utils/miautoRentSaleHelpers';
import { symMoneda } from '../../utils/miautoAlquilerVentaList';
import { roundToTwoDecimals } from '../../utils/currency';

type EstadoFiltro = 'pendiente' | 'validado' | 'rechazado' | 'todos';
type MiautoMoneda = 'PEN' | 'COP' | 'USD';
type AccionModal =
  | { tipo: 'aprobar'; comprobante: ComprobanteValidacion }
  | { tipo: 'rechazar'; comprobante: ComprobanteValidacion }
  | { tipo: 'anular'; comprobante: ComprobanteValidacion }
  | null;

interface ComprobanteValidacion {
  id: string;
  solicitud_id: string;
  cuota_semanal_id: string;
  monto?: number | string | null;
  moneda?: MiautoMoneda | string | null;
  file_name?: string | null;
  file_path?: string | null;
  estado?: string | null;
  origen?: 'conductor' | 'admin_confirmacion' | 'pago_manual' | string | null;
  created_at?: string | null;
  validated_at?: string | null;
  rechazado_at?: string | null;
  rechazo_razon?: string | null;
  dni?: string | null;
  phone?: string | null;
  country?: string | null;
  license_number?: string | null;
  placa_asignada?: string | null;
  driver_name?: string | null;
  driver_first_name?: string | null;
  driver_last_name?: string | null;
  cronograma_name?: string | null;
  vehiculo_name?: string | null;
  week_start_date?: string | null;
  due_date?: string | null;
  amount_due?: number | string | null;
  paid_amount?: number | string | null;
  late_fee?: number | string | null;
  cuota_status?: string | null;
  cuota_moneda?: MiautoMoneda | string | null;
}

const ESTADOS: { value: EstadoFiltro; label: string }[] = [
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'validado', label: 'Aprobados' },
  { value: 'rechazado', label: 'Rechazados' },
  { value: 'todos', label: 'Todos' },
];

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

function foldLower(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function driverName(row: ComprobanteValidacion): string {
  if (row.driver_name && row.driver_name.trim()) return row.driver_name.trim();
  const name = [row.driver_first_name, row.driver_last_name].filter(Boolean).join(' ').trim();
  return name || row.dni || 'Conductor sin nombre';
}

function origenLabel(origen?: string | null): string {
  const o = String(origen || 'conductor').toLowerCase();
  if (o === 'pago_manual') return 'Pago manual';
  if (o === 'admin_confirmacion') return 'Pago con archivo';
  return 'Conductor';
}

function estadoClasses(estado?: string | null): string {
  const e = String(estado || 'pendiente').toLowerCase();
  if (e === 'validado') return 'bg-green-50 text-green-700 border-green-200';
  if (e === 'rechazado') return 'bg-red-50 text-red-700 border-red-200';
  return 'bg-amber-50 text-amber-700 border-amber-200';
}

function estadoLabel(estado?: string | null): string {
  const e = String(estado || 'pendiente').toLowerCase();
  if (e === 'validado') return 'Aprobado';
  if (e === 'rechazado') return 'Rechazado';
  return 'Pendiente';
}

function normalizeMoneda(value?: string | null): MiautoMoneda {
  const m = String(value || '').toUpperCase();
  if (m === 'USD' || m === 'COP' || m === 'PEN') return m;
  return 'PEN';
}

export default function YegoMiAutoValidarComprobantes() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [estado, setEstado] = useState<EstadoFiltro>('pendiente');
  const [country, setCountry] = useState((user?.country as string) || '');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ComprobanteValidacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accion, setAccion] = useState<AccionModal>(null);
  const [accionMonto, setAccionMonto] = useState('');
  const [accionMoneda, setAccionMoneda] = useState<MiautoMoneda>('PEN');
  const [rechazoMotivo, setRechazoMotivo] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchComprobantes = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError('');
      const res = await api.get('/miauto/comprobantes-cuota-semanal', {
        signal,
        headers: MIAUTO_NO_CACHE_HEADERS,
        params: { estado, country, limit: 500 },
      });
      const data = unwrapApiData<ComprobanteValidacion[]>(res) ?? [];
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      if (isAxiosAbortError(e)) return;
      setError(e.response?.data?.message || 'Error al cargar comprobantes');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [estado, country]);

  useEffect(() => {
    const ac = new AbortController();
    fetchComprobantes(ac.signal);
    return () => ac.abort();
  }, [fetchComprobantes]);

  const filteredRows = useMemo(() => {
    const q = foldLower(query.trim());
    if (!q) return rows;
    return rows.filter((row) => {
      const parts = [
        driverName(row),
        row.dni,
        row.phone,
        row.placa_asignada,
        row.license_number,
        row.file_name,
        row.cronograma_name,
        row.vehiculo_name,
      ];
      return parts.some((part) => part != null && foldLower(String(part)).includes(q));
    });
  }, [rows, query]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const e = String(row.estado || 'pendiente').toLowerCase();
        if (e === 'validado') acc.validado += 1;
        else if (e === 'rechazado') acc.rechazado += 1;
        else acc.pendiente += 1;
        return acc;
      },
      { pendiente: 0, validado: 0, rechazado: 0 }
    );
  }, [rows]);

  const openAprobar = (row: ComprobanteValidacion) => {
    setAccion({ tipo: 'aprobar', comprobante: row });
    setAccionMonto(row.monto != null ? String(row.monto) : '');
    setAccionMoneda(normalizeMoneda(row.moneda || row.cuota_moneda));
    setRechazoMotivo('');
  };

  const openRechazar = (row: ComprobanteValidacion) => {
    setAccion({ tipo: 'rechazar', comprobante: row });
    setAccionMonto('');
    setAccionMoneda(normalizeMoneda(row.moneda || row.cuota_moneda));
    setRechazoMotivo('');
  };

  const openAnular = (row: ComprobanteValidacion) => {
    setAccion({ tipo: 'anular', comprobante: row });
    setAccionMonto('');
    setAccionMoneda(normalizeMoneda(row.moneda || row.cuota_moneda));
    setRechazoMotivo('');
  };

  const closeModal = () => {
    if (savingId) return;
    setAccion(null);
    setAccionMonto('');
    setRechazoMotivo('');
  };

  const submitAccion = async () => {
    if (!accion) return;
    const row = accion.comprobante;
    try {
      setSavingId(row.id);
      if (accion.tipo === 'aprobar') {
        const monto = roundToTwoDecimals(parseFloat(accionMonto));
        if (Number.isNaN(monto) || monto <= 0) {
          toast.error('Indica un monto válido');
          return;
        }
        await api.patch(`/miauto/solicitudes/${row.solicitud_id}/comprobantes-cuota-semanal/${row.id}/validar`, {
          monto,
          moneda: accionMoneda,
        });
        toast.success('Comprobante aprobado');
      } else if (accion.tipo === 'rechazar') {
        const motivo = rechazoMotivo.trim();
        if (motivo.length < 3) {
          toast.error('Indica un motivo breve');
          return;
        }
        await api.patch(`/miauto/solicitudes/${row.solicitud_id}/comprobantes-cuota-semanal/${row.id}/rechazar`, {
          motivo,
        });
        toast.success('Comprobante rechazado');
      } else {
        await api.patch(`/miauto/solicitudes/${row.solicitud_id}/comprobantes-cuota-semanal/${row.id}/anular-validacion`);
        toast.success('Validación anulada');
      }
      setAccion(null);
      await fetchComprobantes();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'No se pudo actualizar el comprobante');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Validar comprobantes</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Yego Mi Auto</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs text-white">
            <div className="rounded-lg bg-white/15 px-3 py-2">
              <p className="font-bold text-base">{totals.pendiente}</p>
              <p>Pendientes</p>
            </div>
            <div className="rounded-lg bg-white/15 px-3 py-2">
              <p className="font-bold text-base">{totals.validado}</p>
              <p>Aprobados</p>
            </div>
            <div className="rounded-lg bg-white/15 px-3 py-2">
              <p className="font-bold text-base">{totals.rechazado}</p>
              <p>Rechazados</p>
            </div>
          </div>
        </div>
      </header>

      <section className="bg-white rounded-lg border border-gray-200 p-3 lg:p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex rounded-lg bg-gray-100 p-1">
            {ESTADOS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setEstado(item.value)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  estado === item.value ? 'bg-white text-[#8B1A1A] shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
            >
              {COUNTRY_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar"
                className="h-10 w-full rounded-lg border border-gray-300 pl-9 pr-3 text-sm sm:w-72"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando comprobantes...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FileText className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-2 text-sm font-medium text-gray-900">No hay comprobantes</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3">Conductor</th>
                  <th className="px-4 py-3">Cuota</th>
                  <th className="px-4 py-3">Comprobante</th>
                  <th className="px-4 py-3">Monto</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {filteredRows.map((row) => {
                  const estadoRow = String(row.estado || 'pendiente').toLowerCase();
                  const isPending = estadoRow === 'pendiente';
                  const isValidated = estadoRow === 'validado';
                  const moneda = normalizeMoneda(row.moneda || row.cuota_moneda);
                  return (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 align-top">
                        <p className="font-semibold text-gray-900">{driverName(row)}</p>
                        <p className="text-xs text-gray-500">
                          DNI {row.dni || '—'} · Placa {row.placa_asignada || '—'}
                        </p>
                        <p className="text-xs text-gray-500 truncate max-w-xs">
                          {row.vehiculo_name || row.cronograma_name || row.phone || '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <p className="font-medium text-gray-900">
                          {row.due_date ? formatDate(row.due_date, 'es-ES') : 'Sin vencimiento'}
                        </p>
                        <p className="text-xs text-gray-500">
                          Saldo base {miautoFmtMonto(symMoneda(row.cuota_moneda), miautoNum(row.amount_due))}
                        </p>
                        <p className="text-xs text-gray-500">
                          Mora {miautoFmtMonto(symMoneda(row.cuota_moneda), miautoNum(row.late_fee))}
                        </p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className="inline-flex rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {origenLabel(row.origen)}
                        </span>
                        <p className="mt-1 max-w-xs truncate text-gray-900">{row.file_name || 'Pago manual'}</p>
                        <p className="text-xs text-gray-500">
                          {row.created_at ? formatDateTime(row.created_at, 'es-ES') : '—'}
                        </p>
                        {row.file_path && row.file_path !== 'manual' && (
                          <a
                            href={getMiautoAdjuntoUrl(row.file_path)}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline"
                          >
                            Ver archivo <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <p className="font-semibold text-gray-900">
                          {miautoFmtMonto(symMoneda(moneda), miautoNum(row.monto))}
                        </p>
                        <p className="text-xs text-gray-500">{moneda}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${estadoClasses(row.estado)}`}>
                          {estadoLabel(row.estado)}
                        </span>
                        {estadoRow === 'rechazado' && row.rechazo_razon && (
                          <p className="mt-1 max-w-xs text-xs text-red-600">{row.rechazo_razon}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${row.solicitud_id}`)}
                            className="inline-flex h-9 items-center gap-1 rounded-lg border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            Detalle
                          </button>
                          {isPending && (
                            <>
                              <button
                                type="button"
                                onClick={() => openAprobar(row)}
                                className="inline-flex h-9 items-center gap-1 rounded-lg bg-green-600 px-3 text-xs font-medium text-white hover:bg-green-700"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Aprobar
                              </button>
                              <button
                                type="button"
                                onClick={() => openRechazar(row)}
                                className="inline-flex h-9 items-center gap-1 rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700"
                              >
                                <XCircle className="h-4 w-4" />
                                Rechazar
                              </button>
                            </>
                          )}
                          {isValidated && (
                            <button
                              type="button"
                              onClick={() => openAnular(row)}
                              className="inline-flex h-9 items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-medium text-amber-800 hover:bg-amber-100"
                            >
                              <RotateCcw className="h-4 w-4" />
                              Anular
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {accion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  {accion.tipo === 'aprobar'
                    ? 'Aprobar comprobante'
                    : accion.tipo === 'rechazar'
                      ? 'Rechazar comprobante'
                      : 'Anular aprobación'}
                </h2>
                <p className="text-xs text-gray-500">{driverName(accion.comprobante)}</p>
              </div>
              <button type="button" onClick={closeModal} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              {accion.tipo === 'aprobar' ? (
                <>
                  <label className="block text-sm font-medium text-gray-700">Monto aprobado</label>
                  <div className="grid grid-cols-[1fr_110px] gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={accionMonto}
                      onChange={(e) => setAccionMonto(e.target.value)}
                      className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
                    />
                    <select
                      value={accionMoneda}
                      onChange={(e) => setAccionMoneda(e.target.value as MiautoMoneda)}
                      className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
                    >
                      <option value="PEN">PEN</option>
                      <option value="COP">COP</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </>
              ) : accion.tipo === 'rechazar' ? (
                <>
                  <label className="block text-sm font-medium text-gray-700">Motivo del rechazo</label>
                  <textarea
                    value={rechazoMotivo}
                    onChange={(e) => setRechazoMotivo(e.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    placeholder="Ej. imagen borrosa, monto no coincide"
                  />
                </>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                  Se revertirá el pago aplicado a la cuota/cascada y el comprobante volverá a quedar pendiente.
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
              <button
                type="button"
                onClick={closeModal}
                disabled={!!savingId}
                className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitAccion}
                disabled={savingId === accion.comprobante.id}
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium text-white disabled:opacity-50 ${
                  accion.tipo === 'aprobar'
                    ? 'bg-green-600 hover:bg-green-700'
                    : accion.tipo === 'rechazar'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                }`}
              >
                {savingId === accion.comprobante.id && <Loader2 className="h-4 w-4 animate-spin" />}
                {accion.tipo === 'aprobar' ? 'Aprobar' : accion.tipo === 'rechazar' ? 'Rechazar' : 'Anular aprobación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
