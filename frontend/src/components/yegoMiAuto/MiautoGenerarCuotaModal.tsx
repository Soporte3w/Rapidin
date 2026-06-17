import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Calendar, AlertTriangle, Loader2, CheckCircle2, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { formatDateUTC } from '../../utils/date';

interface SemanaDisponible {
  week_start: string;
  semana: number;
  es_deposito: boolean;
  disponible: boolean;
  tiene_cuota: boolean;
  cuota_id?: string;
  amount_due?: number;
  paid_amount?: number;
  status?: string;
  late_fee?: number;
}

interface SemanasPayload {
  fecha_inicio: string;
  first_monday: string;
  total_semanas: number;
  semanas: SemanaDisponible[];
}

interface Props {
  solicitudId: string;
  open: boolean;
  onClose: () => void;
  onGenerated: () => void;
}

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function ymdParts(ymd: string) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

function sameMonth(a: string, b: string) {
  const pa = ymdParts(a);
  const pb = ymdParts(b);
  if (!pa || !pb) return false;
  return pa.year === pb.year && pa.month === pb.month;
}

function monthLabel(ymd: string) {
  const p = ymdParts(ymd);
  if (!p) return '';
  return `${MESES_ES[p.month]} ${p.year}`;
}

export function MiautoGenerarCuotaModal({ solicitudId, open, onClose, onGenerated }: Props) {
  const [semanasData, setSemanasData] = useState<SemanasPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState('');

  const loadSemanas = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedWeek(null);
    try {
      const res = await api.get(`/miauto/solicitudes/${solicitudId}/semanas-disponibles`);
      const data = res.data?.data ?? res.data;
      setSemanasData(data);
      if (data?.first_monday) {
        setCalendarMonth(data.first_monday);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al cargar las semanas');
    } finally {
      setLoading(false);
    }
  }, [solicitudId]);

  useEffect(() => {
    if (open) loadSemanas();
  }, [open, loadSemanas]);

  const handleGenerate = async () => {
    if (!selectedWeek) return;
    setGenerating(true);
    try {
      await api.post(`/miauto/solicitudes/${solicitudId}/cuotas-semanales/generar`, {
        week_start_date: selectedWeek,
      });
      toast.success(`Cuota semana ${selectedWeek} generada`);
      onGenerated();
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al generar la cuota');
    } finally {
      setGenerating(false);
    }
  };

  if (!open) return null;

  const semanas = semanasData?.semanas ?? [];
  const semanaMap = new Map(semanas.map((s) => [s.week_start, s]));
  const selectedInfo = selectedWeek ? semanaMap.get(selectedWeek) : null;

  const currentMonthMondays = semanas.filter((s) => sameMonth(s.week_start, calendarMonth));
  const firstOfMonth = currentMonthMondays.length > 0 ? currentMonthMondays[0].week_start : calendarMonth;
  const lastOfMonth = currentMonthMondays.length > 0 ? currentMonthMondays[currentMonthMondays.length - 1].week_start : calendarMonth;

  const pFirst = ymdParts(firstOfMonth);
  const pLast = ymdParts(lastOfMonth || firstOfMonth);
  const totalDays = pFirst && pLast ? Math.round(
    (new Date(pLast.year, pLast.month, pLast.day).getTime() - new Date(pFirst.year, pFirst.month, pFirst.day).getTime())
    / (24 * 60 * 60 * 1000)
  ) + 7 : 35;

  const startDate = pFirst ? new Date(pFirst.year, pFirst.month, pFirst.day) : new Date();
  const dowStart = (startDate.getUTCDay() + 6) % 7;

  const hasEmptyBefore = semanas.some((s) => !s.tiene_cuota && s.week_start < (selectedWeek ?? ''));

  const prevMonth = () => {
    if (!calendarMonth) return;
    const p = ymdParts(calendarMonth);
    if (!p) return;
    const d = new Date(p.year, p.month - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setCalendarMonth(`${y}-${m}-01`);
  };

  const nextMonth = () => {
    if (!calendarMonth) return;
    const p = ymdParts(calendarMonth);
    if (!p) return;
    const d = new Date(p.year, p.month + 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setCalendarMonth(`${y}-${m}-01`);
  };

  const renderDayCell = (offset: number) => {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + offset - dowStart);
    const ymd = d.toISOString().slice(0, 10);
    const s = semanaMap.get(ymd);
    const day = d.getUTCDate();

    if (!s) {
      return (
        <td key={ymd} className="p-0.5">
          <div className="h-8 w-8 rounded text-xs text-gray-300 flex items-center justify-center">{day}</div>
        </td>
      );
    }

    if (s.tiene_cuota) {
      return (
        <td key={ymd} className="p-0.5">
          <div
            className="h-8 w-8 rounded bg-gray-100 flex items-center justify-center cursor-not-allowed relative group"
            title={`Semana ${s.semana} — ya generada${s.paid_amount != null ? ` (pagado: $${Number(s.paid_amount).toFixed(2)})` : ''}`}
          >
            <span className="text-xs text-gray-400">{day}</span>
            <Lock className="w-2.5 h-2.5 text-gray-400 absolute -top-0.5 -right-0.5" />
          </div>
        </td>
      );
    }

    if (!s.disponible) {
      return (
        <td key={ymd} className="p-0.5">
          <div className="h-8 w-8 rounded text-xs text-gray-300 flex items-center justify-center">{day}</div>
        </td>
      );
    }

    const isSel = selectedWeek === ymd;
    return (
      <td key={ymd} className="p-0.5">
        <button
          type="button"
          onClick={() => setSelectedWeek(ymd)}
          className={`h-8 w-8 rounded text-xs font-medium flex items-center justify-center transition-colors ${
            isSel
              ? 'bg-[#8B1A1A] text-white'
              : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
          }`}
          title={`Semana ${s.semana} — disponible`}
        >
          {day}
        </button>
      </td>
    );
  };

  const dayRows: JSX.Element[][] = [];
  for (let i = 0; i < Math.ceil((totalDays + dowStart) / 7); i++) {
    const row: JSX.Element[] = [];
    for (let j = 0; j < 7; j++) {
      const offset = i * 7 + j;
      row.push(renderDayCell(offset));
    }
    dayRows.push(row);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-[#8B1A1A] rounded-lg flex items-center justify-center">
              <Calendar className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Generar cuota semanal</h3>
              {semanasData && (
                <p className="text-xs text-gray-500">
                  {semanasData.total_semanas} semanas · {semanas.filter((s) => s.tiene_cuota).length} generadas
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-8 h-8 text-gray-400 animate-spin" />
              <p className="text-sm text-gray-500">Cargando semanas...</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <AlertTriangle className="w-8 h-8 text-red-400" />
              <p className="text-sm text-red-600">{error}</p>
              <button
                type="button"
                onClick={loadSemanas}
                className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100"
              >
                Reintentar
              </button>
            </div>
          )}

          {!loading && !error && semanas.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <CheckCircle2 className="w-8 h-8 text-green-400" />
              <p className="text-sm text-gray-500">Todas las semanas del cronograma ya tienen cuota generada</p>
            </div>
          )}

          {!loading && !error && semanas.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3">
                <button type="button" onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm font-semibold text-gray-700 capitalize">{monthLabel(calendarMonth)}</span>
                <button type="button" onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <table className="w-full text-center">
                <thead>
                  <tr>
                    {['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map((d) => (
                      <th key={d} className="text-xs font-medium text-gray-400 pb-2">{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dayRows.map((row, i) => (
                    <tr key={i}>{row}</tr>
                  ))}
                </tbody>
              </table>

              <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-blue-50 border border-blue-200" /> Disponible
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-gray-100 border border-gray-200" /> Generada
                </span>
              </div>

              {hasEmptyBefore && selectedWeek && (
                <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-700">
                    Hay semanas anteriores sin generar. Se recomienda generarlas en orden cronológico.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {selectedInfo && selectedInfo.disponible && (
          <div className="border-t border-gray-200 bg-gray-50 px-5 py-4 shrink-0 space-y-3">
            <div className="text-sm">
              <span className="text-gray-500">Semana </span>
              <span className="font-semibold text-gray-900">{selectedInfo.semana}</span>
              <span className="text-gray-500"> de {semanasData?.total_semanas}</span>
              {selectedInfo.es_deposito && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                  Depósito
                </span>
              )}
            </div>
            <div className="text-sm">
              <span className="text-gray-500">Lunes: </span>
              <span className="font-medium text-gray-900">{formatDateUTC(selectedWeek, 'es-ES')}</span>
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-[#8B1A1A] hover:bg-[#6B1515] disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2 transition-colors"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Generando...
                </>
              ) : (
                `Generar cuota semana ${selectedInfo.semana}`
              )}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
