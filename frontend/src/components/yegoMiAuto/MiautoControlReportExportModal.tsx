import { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, X } from 'lucide-react';
import api from '../../services/api';
import { AdminModalPortal } from '../AdminModalPortal';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import { conductorDisplay, type AlquilerVentaListItem } from '../../utils/miautoAlquilerVentaList';

type CronogramaOption = { id: string; name: string };

type Props = {
  open: boolean;
  country: string;
  cronogramas: CronogramaOption[];
  initialCronogramaId?: string;
  onClose: () => void;
};

type DriverOption = {
  value: string;
  label: string;
  contracts: number;
};

function dateToYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDaysYmd(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  date.setDate(date.getDate() + days);
  return dateToYmd(date);
}

function mondayOfYmd(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  const weekday = date.getDay() || 7;
  date.setDate(date.getDate() - weekday + 1);
  return dateToYmd(date);
}

function defaultWeekRange() {
  const currentMonday = mondayOfYmd(dateToYmd(new Date()));
  return {
    from: addDaysYmd(currentMonday, -14),
    to: currentMonday,
  };
}

async function responseErrorMessage(error: any): Promise<string> {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
      // Usa el mensaje genérico de abajo.
    }
  }
  return data?.message || error?.message || 'No se pudo generar el reporte Excel';
}

export function MiautoControlReportExportModal({
  open,
  country,
  cronogramas,
  initialCronogramaId = '',
  onClose,
}: Props) {
  const initialRange = useMemo(defaultWeekRange, []);
  const [weekFrom, setWeekFrom] = useState(initialRange.from);
  const [weekTo, setWeekTo] = useState(initialRange.to);
  const [cronogramaId, setCronogramaId] = useState(initialCronogramaId);
  const [driverValue, setDriverValue] = useState('');
  const [contracts, setContracts] = useState<AlquilerVentaListItem[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setCronogramaId(initialCronogramaId);
    setDriverValue('');
    setError('');
  }, [open, initialCronogramaId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const loadContracts = async () => {
      setLoadingContracts(true);
      setContracts([]);
      setDriverValue('');
      try {
        const accumulated: AlquilerVentaListItem[] = [];
        let page = 1;
        let total = 0;
        do {
          const params = new URLSearchParams({ page: String(page), limit: '100' });
          if (country) params.set('country', country);
          if (cronogramaId) params.set('cronograma_id', cronogramaId);
          const response = await api.get(`/miauto/alquiler-venta?${params.toString()}`, {
            signal: controller.signal,
            headers: MIAUTO_NO_CACHE_HEADERS,
          });
          const rows = response.data?.data;
          const batch = Array.isArray(rows) ? rows : [];
          accumulated.push(...batch);
          total = Number(response.data?.pagination?.total) || accumulated.length;
          if (batch.length === 0) break;
          page += 1;
        } while (accumulated.length < total && !controller.signal.aborted);
        if (!controller.signal.aborted) setContracts(accumulated);
      } catch (loadError) {
        if (isAxiosAbortError(loadError)) return;
        setContracts([]);
        setError('No se pudieron cargar los conductores disponibles');
      } finally {
        if (!controller.signal.aborted) setLoadingContracts(false);
      }
    };
    loadContracts();
    return () => controller.abort();
  }, [open, country, cronogramaId]);

  const driverOptions = useMemo<DriverOption[]>(() => {
    const grouped = new Map<string, { rows: AlquilerVentaListItem[]; label: string }>();
    for (const row of contracts) {
      const value = row.conductor_id ? `conductor:${row.conductor_id}` : `solicitud:${row.id}`;
      const label = `${conductorDisplay(row)} · ${row.dni || 'Sin DNI'}`;
      const current = grouped.get(value);
      if (current) current.rows.push(row);
      else grouped.set(value, { rows: [row], label });
    }
    return [...grouped.entries()]
      .map(([value, item]) => ({ value, label: item.label, contracts: item.rows.length }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [contracts]);

  const normalizedFrom = weekFrom ? mondayOfYmd(weekFrom) : '';
  const normalizedTo = weekTo ? mondayOfYmd(weekTo) : '';
  const invalidRange = !normalizedFrom || !normalizedTo || normalizedTo < normalizedFrom;

  const handleExport = async () => {
    if (invalidRange) {
      setError('La semana hasta no puede ser anterior a la semana desde');
      return;
    }
    setExporting(true);
    setError('');
    try {
      const params = new URLSearchParams({
        week_from: normalizedFrom,
        week_to: normalizedTo,
      });
      if (country) params.set('country', country);
      if (cronogramaId) params.set('cronograma_id', cronogramaId);
      if (driverValue.startsWith('conductor:')) params.set('conductor_id', driverValue.slice('conductor:'.length));
      if (driverValue.startsWith('solicitud:')) params.set('solicitud_id', driverValue.slice('solicitud:'.length));
      const response = await api.get(`/miauto/alquiler-venta/exportar?${params.toString()}`, {
        responseType: 'blob',
      });
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `reporte_control_yego_auto_${normalizedFrom}_${addDaysYmd(normalizedTo, 6)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      onClose();
    } catch (exportError) {
      setError(await responseErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  };

  if (!open) return null;

  return (
    <AdminModalPortal>
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4" onClick={() => !exporting && onClose()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="miauto-control-report-title"
          className="w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-700">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h2 id="miauto-control-report-title" className="text-lg font-bold text-gray-900">Exportar reporte de control</h2>
                <p className="mt-0.5 text-sm text-gray-600">Genera el Excel por semanas, conductor y cronograma.</p>
              </div>
            </div>
            <button type="button" onClick={onClose} disabled={exporting} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50" aria-label="Cerrar">
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="space-y-5 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="miauto-report-week-from" className="mb-1.5 block text-xs font-semibold text-gray-800">Semana desde</label>
                <input
                  id="miauto-report-week-from"
                  type="date"
                  value={weekFrom}
                  onChange={(event) => setWeekFrom(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
                />
              </div>
              <div>
                <label htmlFor="miauto-report-week-to" className="mb-1.5 block text-xs font-semibold text-gray-800">Semana hasta</label>
                <input
                  id="miauto-report-week-to"
                  type="date"
                  value={weekTo}
                  onChange={(event) => setWeekTo(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
                />
              </div>
            </div>
            <p className="-mt-3 text-xs text-gray-500">Cada fecha se ajusta automáticamente a su semana de lunes a domingo.</p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="miauto-report-cronograma" className="mb-1.5 block text-xs font-semibold text-gray-800">Cronograma</label>
                <select
                  id="miauto-report-cronograma"
                  value={cronogramaId}
                  onChange={(event) => setCronogramaId(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
                >
                  <option value="">Todos los cronogramas</option>
                  {cronogramas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="miauto-report-driver" className="mb-1.5 block text-xs font-semibold text-gray-800">Conductor</label>
                <select
                  id="miauto-report-driver"
                  value={driverValue}
                  onChange={(event) => setDriverValue(event.target.value)}
                  disabled={loadingContracts}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
                >
                  <option value="">{loadingContracts ? 'Cargando conductores…' : 'Todos los conductores'}</option>
                  {driverOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}{item.contracts > 1 ? ` · ${item.contracts} contratos` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              El archivo tendrá una fila por contrato y placa. Un conductor con más de un contrato aparecerá una vez por cada vehículo.
            </div>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          </div>

          <footer className="flex flex-col-reverse gap-2 border-t border-gray-200 bg-gray-50 px-5 py-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} disabled={exporting} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || loadingContracts || invalidRange}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {exporting ? 'Generando Excel…' : 'Descargar Excel'}
            </button>
          </footer>
        </div>
      </div>
    </AdminModalPortal>
  );
}
