import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  CreditCard,
  Layers,
  AlertCircle,
  CheckCircle,
  FileSpreadsheet,
  Send,
  Download,
  History,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react';
import { readCobranzasYegoFile, type CobranzasExcelRow } from '../../utils/cobranzasYegoExcel';

// ─── Tipos ───────────────────────────────────────────────────────────────────

type ProcessResult = {
  index: number;
  ok: boolean;
  external_driver_id?: string;
  conductor?: string | null;
  balance_fleet?: number | null;
  amount_charged?: number;
  error?: string;
  status?: string;
};

type BatchSummary = {
  batch_id: string;
  created_at: string;
  sheet_names: string[];
  total: number;
  ok: number;
  fail: number;
  total_charged: number;
};

type BatchRow = {
  id: string;
  batch_id: string;
  external_driver_id: string;
  conductor: string | null;
  sheet_name: string | null;
  row_in_sheet: number | null;
  amount: number | null;
  amount_charged: number | null;
  payment_date: string | null;
  balance_fleet: number | null;
  status: string;
  error_detail: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  cobrado:            'Cobrado',
  cobrado_parcial:    'Cobro parcial',
  saldo_insuficiente: 'Sin saldo',
  error_fleet:        'Error Fleet',
  dato_invalido:      'Dato inválido',
};

const STATUS_CLASS: Record<string, string> = {
  cobrado:            'bg-green-100 text-green-800',
  cobrado_parcial:    'bg-amber-100 text-amber-800',
  saldo_insuficiente: 'bg-red-100 text-red-700',
  error_fleet:        'bg-red-100 text-red-700',
  dato_invalido:      'bg-red-100 text-red-700',
};

// ─── Sub-componente: tarjeta de batch ─────────────────────────────────────────

function BatchCard({ batch, onDownload }: { batch: BatchSummary; onDownload: (batchId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (rows) return;
    setLoading(true);
    try {
      const res = await api.get(`/cobranzas-yego/batch/${batch.batch_id}`);
      setRows(res.data?.data ?? []);
    } catch {
      toast.error('No se pudo cargar el detalle');
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    if (!open) load();
    setOpen((v) => !v);
  };

  const sheetLabel = batch.sheet_names.length > 0
    ? batch.sheet_names.join(' · ')
    : 'Sin nombre de hoja';

  const dateStr = new Date(batch.created_at).toLocaleString('es-PE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header de la tarjeta */}
      <button
        type="button"
        onClick={toggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{sheetLabel}</p>
          <p className="text-xs text-gray-400 mt-0.5">{dateStr}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-2 text-xs">
            <span className="bg-green-100 text-green-700 font-medium px-2 py-0.5 rounded-full">
              {batch.ok} cobrados
            </span>
            {batch.fail > 0 && (
              <span className="bg-red-100 text-red-700 font-medium px-2 py-0.5 rounded-full">
                {batch.fail} error
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500 hidden sm:block">
            S/ {Number(batch.total_charged).toFixed(2)}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDownload(batch.batch_id); }}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-lg transition-colors"
            title="Descargar Excel"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      {/* Detalle desplegable */}
      {open && (
        <div className="border-t border-gray-100">
          {loading && (
            <p className="text-xs text-gray-400 px-4 py-3">Cargando…</p>
          )}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">Estado</th>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">Conductor</th>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">driver_id</th>
                    <th className="text-right px-3 py-1.5 font-medium text-gray-600">A cobrar</th>
                    <th className="text-right px-3 py-1.5 font-medium text-gray-600">Cobrado</th>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">Fecha</th>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">Hoja</th>
                    <th className="text-left px-3 py-1.5 font-medium text-gray-600">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_CLASS[r.status] ?? 'bg-gray-100 text-gray-700'}`}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 max-w-[130px] truncate">{r.conductor || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-500">{(r.external_driver_id ?? '').slice(0, 10)}…</td>
                      <td className="px-3 py-1.5 text-right">{r.amount != null ? Number(r.amount).toFixed(2) : '—'}</td>
                      <td className={`px-3 py-1.5 text-right font-medium ${r.amount_charged != null ? 'text-green-700' : 'text-gray-400'}`}>
                        {r.amount_charged != null ? Number(r.amount_charged).toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        {r.payment_date ? new Date(r.payment_date).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-400 max-w-[100px] truncate">{r.sheet_name || '—'}</td>
                      <td className="px-3 py-1.5 text-red-600 max-w-[200px] truncate">{r.error_detail || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows && rows.length === 0 && (
            <p className="text-xs text-gray-400 px-4 py-3">Sin filas en este batch.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function PaymentsBulk() {
  const [tab, setTab] = useState<'cobrar' | 'historial'>('cobrar');

  // — Archivo —
  const fileInputRef = useRef<HTMLInputElement>(null);
  const storedFileRef = useRef<File | null>(null);
  const [excelFileName, setExcelFileName] = useState('');
  const [excelSheetNames, setExcelSheetNames] = useState<string[]>([]);
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(new Set());
  const [excelRows, setExcelRows] = useState<CobranzasExcelRow[]>([]);
  const [excelWarnings, setExcelWarnings] = useState<string[]>([]);
  const [excelLoading, setExcelLoading] = useState(false);

  // — Procesamiento —
  const [processing, setProcessing] = useState(false);
  const [processResults, setProcessResults] = useState<{ summary: { ok: number; fail: number; total: number }; results: ProcessResult[] } | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  // — Historial —
  const PAGE_SIZE = 10;
  const [history, setHistory] = useState<BatchSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);

  const loadHistory = useCallback(async (page = 0) => {
    setHistoryLoading(true);
    try {
      const res = await api.get(`/cobranzas-yego/history?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
      setHistory(res.data?.data ?? []);
      setHistoryTotal(res.data?.total ?? (res.data?.data ?? []).length);
      setHistoryPage(page);
    } catch {
      toast.error('No se pudo cargar el historial');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'historial' && history === null) loadHistory(0);
  }, [tab, history, loadHistory]);

  // ── Hojas ─────────────────────────────────────────────────────────────────

  const toggleSheet = (name: string) => {
    setSelectedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const resetResults = () => { setProcessResults(null); setBatchId(null); };

  // ── Carga del archivo ─────────────────────────────────────────────────────

  const handleFilePick: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { toast.error('Solo archivos .xlsx'); return; }

    storedFileRef.current = file;
    setExcelFileName(file.name);
    resetResults();
    setExcelLoading(true);

    try {
      const { rows, warnings, sheetNames } = await readCobranzasYegoFile(file);
      setExcelSheetNames(sheetNames);
      setSelectedSheets(new Set(sheetNames));
      setExcelRows(rows);
      setExcelWarnings(warnings);
      if (warnings.length) toast(`Cargado con ${warnings.length} aviso(s).`);
      else toast.success(`${rows.length} fila(s) en ${sheetNames.length} semana(s).`);
    } catch (err) {
      console.error(err);
      toast.error('No se pudo leer el Excel');
      setExcelRows([]);
      setExcelSheetNames([]);
      setExcelWarnings([]);
      storedFileRef.current = null;
    } finally {
      setExcelLoading(false);
    }
  };

  const applySheetFilter = async () => {
    const file = storedFileRef.current;
    if (!file) { toast.error('Vuelve a elegir el archivo.'); return; }
    if (selectedSheets.size === 0) { toast.error('Marca al menos una hoja.'); return; }
    setExcelLoading(true);
    resetResults();
    try {
      const filter = selectedSheets.size === excelSheetNames.length ? undefined : selectedSheets;
      const { rows, warnings } = await readCobranzasYegoFile(file, filter);
      setExcelRows(rows);
      setExcelWarnings(warnings);
      toast.success(`${rows.length} fila(s) con el filtro aplicado.`);
    } catch (err) {
      console.error(err);
      toast.error('Error al re-leer con las hojas elegidas');
    } finally {
      setExcelLoading(false);
    }
  };

  // ── Cobrar ────────────────────────────────────────────────────────────────

  const runProcess = async () => {
    if (excelRows.length === 0) { toast.error('Carga un Excel primero.'); return; }
    if (excelRows.length > 800) { toast.error('Máximo 800 filas.'); return; }

    setProcessing(true);
    resetResults();

    try {
      const items = excelRows.map((r) => ({
        external_driver_id: r.external_driver_id,
        amount: r.amount,
        payment_date: r.payment_date,
        conductor: r.conductor,
        sheet_name: r.sheet_name,
        row_in_sheet: r.row_in_sheet,
        observations: r.observations ?? null,
      }));

      const res = await api.post('/cobranzas-yego/process', { items });
      const data = res.data?.data;
      setProcessResults({ summary: data?.summary, results: data?.results ?? [] });
      if (data?.batch_id) {
        setBatchId(data.batch_id);
        setHistory(null); // fuerza recarga del historial
      }
      if (data?.summary?.fail === 0) toast.success(`${data.summary.ok} cobro(s) realizados.`);
      else toast.error(`${data?.summary?.ok ?? 0} ok · ${data?.summary?.fail ?? 0} con error.`);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      toast.error(err.response?.data?.message || 'Error al cobrar');
    } finally {
      setProcessing(false);
    }
  };

  // ── Descarga Excel ────────────────────────────────────────────────────────

  const downloadExcel = async (id: string) => {
    try {
      const res = await api.get(`/cobranzas-yego/export/${id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `cobranzas-yego-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('No se pudo descargar el Excel');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 lg:space-y-6">

      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Cobros masivos YEGO</h1>
              <p className="text-xs lg:text-sm text-white/80 mt-0.5">
                Sube el Excel de cobranzas y ejecuta el cobro Fleet por conductor.
              </p>
            </div>
          </div>
          <Link
            to="/admin/payments"
            className="inline-flex items-center gap-2 text-sm font-medium text-white/90 hover:text-white bg-white/10 hover:bg-white/15 px-4 py-2 rounded-lg transition-colors"
          >
            <CreditCard className="w-4 h-4" />
            Ir a Pagos
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('cobrar')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'cobrar' ? 'bg-[#8B1A1A] text-white shadow' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <FileSpreadsheet className="w-4 h-4" />
          Cobrar
        </button>
        <button
          type="button"
          onClick={() => setTab('historial')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'historial' ? 'bg-[#8B1A1A] text-white shadow' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <History className="w-4 h-4" />
          Historial
        </button>
      </div>

      {/* ── TAB COBRAR ──────────────────────────────────────────────────── */}
      {tab === 'cobrar' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-gray-500" />
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Subir Excel (.xlsx)</h2>
                <p className="text-xs text-gray-500">
                  {excelFileName ? `${excelFileName} · ${excelRows.length} fila(s) listas` : 'Ningún archivo seleccionado'}
                </p>
              </div>
            </div>
            <div className="p-4 space-y-4">
              <input ref={fileInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={handleFilePick} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={excelLoading}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-[#8B1A1A] hover:bg-[#7a1616] disabled:opacity-50 transition-colors"
              >
                <FileSpreadsheet className="w-4 h-4" />
                {excelLoading ? 'Leyendo…' : excelFileName ? 'Cambiar archivo' : 'Elegir archivo .xlsx'}
              </button>

              {/* Selector de hojas */}
              {excelSheetNames.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-700 mb-2">Hojas detectadas — desmarca las que no quieras:</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {excelSheetNames.map((name) => (
                      <label key={name} className="inline-flex items-center gap-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-gray-100 transition-colors">
                        <input type="checkbox" checked={selectedSheets.has(name)} onChange={() => toggleSheet(name)} className="rounded border-gray-300 text-[#8B1A1A] focus:ring-[#8B1A1A]" />
                        <span className="max-w-[200px] truncate" title={name}>{name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setSelectedSheets(new Set(excelSheetNames))} className="text-xs text-[#8B1A1A] font-medium hover:underline">Marcar todas</button>
                    <button type="button" onClick={applySheetFilter} disabled={!storedFileRef.current || excelLoading} className="text-xs font-medium text-gray-700 underline hover:text-gray-900 disabled:opacity-50">Aplicar filtro</button>
                  </div>
                </div>
              )}

              {/* Avisos */}
              {excelWarnings.length > 0 && (
                <div className="max-h-32 overflow-y-auto text-xs bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
                  <p className="font-semibold mb-1">Avisos ({excelWarnings.length})</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {excelWarnings.slice(0, 40).map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                  {excelWarnings.length > 40 && <p className="mt-1">… y {excelWarnings.length - 40} más</p>}
                </div>
              )}

              {/* Preview */}
              {excelRows.length > 0 && (
                <div className="overflow-x-auto max-h-64 overflow-y-auto border border-gray-100 rounded-lg">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600">#</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600">driver_id</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600">Conductor</th>
                        <th className="text-right px-2 py-1.5 font-medium text-gray-600">Monto</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600">Fecha</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600">Hoja</th>
                      </tr>
                    </thead>
                    <tbody>
                      {excelRows.slice(0, 80).map((r, i) => (
                        <tr key={`${r.sheet_name}-${r.row_in_sheet}-${i}`} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                          <td className="px-2 py-1 font-mono text-gray-700">{r.external_driver_id.slice(0, 10)}…</td>
                          <td className="px-2 py-1 max-w-[140px] truncate">{r.conductor || '—'}</td>
                          <td className="px-2 py-1 text-right font-medium">{r.amount.toFixed(2)}</td>
                          <td className="px-2 py-1">{r.payment_date}</td>
                          <td className="px-2 py-1 text-gray-500 max-w-[120px] truncate" title={r.sheet_name}>{r.sheet_name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {excelRows.length > 80 && <p className="text-xs text-gray-400 px-2 py-2 border-t border-gray-100">Mostrando 80 de {excelRows.length} filas.</p>}
                </div>
              )}

              {/* Botón cobrar */}
              {excelRows.length > 0 && !processResults && (
                <button
                  type="button"
                  onClick={runProcess}
                  disabled={processing}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-gray-800 hover:bg-gray-900 disabled:opacity-50 transition-colors"
                >
                  <Send className="w-4 h-4" />
                  {processing ? 'Cobrando…' : `Cobrar ${excelRows.length} fila(s) por Fleet`}
                </button>
              )}
            </div>
          </div>

          {/* Resultado */}
          {processResults && (
            <>
              <div className={`rounded-xl border p-4 flex items-center gap-3 ${processResults.summary.fail === 0 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                {processResults.summary.fail === 0
                  ? <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                  : <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />}
                <div className="flex-1 text-sm">
                  <p className="font-semibold text-gray-900">
                    {processResults.summary.ok} cobro(s) realizados{processResults.summary.fail > 0 && ` · ${processResults.summary.fail} con error`}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">Total: {processResults.summary.total}</p>
                </div>
                {batchId && (
                  <button type="button" onClick={() => downloadExcel(batchId)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gray-800 hover:bg-gray-900 transition-colors flex-shrink-0">
                    <Download className="w-4 h-4" />
                    Descargar Excel
                  </button>
                )}
              </div>

            </>
          )}
        </>
      )}

      {/* ── TAB HISTORIAL ────────────────────────────────────────────────── */}
      {tab === 'historial' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              {history
                ? `${historyTotal} proceso(s) · página ${historyPage + 1} de ${Math.max(1, Math.ceil(historyTotal / PAGE_SIZE))}`
                : 'Cargando…'}
            </p>
            <button
              type="button"
              onClick={() => loadHistory(historyPage)}
              disabled={historyLoading}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
          </div>

          {historyLoading && !history && (
            <div className="text-center py-12 text-gray-400 text-sm">Cargando historial…</div>
          )}

          {history && history.length === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm">No hay cobros registrados aún.</div>
          )}

          {history && history.map((batch) => (
            <BatchCard key={batch.batch_id} batch={batch} onDownload={downloadExcel} />
          ))}

          {/* Paginación */}
          {historyTotal > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => loadHistory(historyPage - 1)}
                disabled={historyPage === 0 || historyLoading}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Anterior
              </button>
              <span className="text-sm text-gray-500 px-2">
                {historyPage + 1} / {Math.ceil(historyTotal / PAGE_SIZE)}
              </span>
              <button
                type="button"
                onClick={() => loadHistory(historyPage + 1)}
                disabled={(historyPage + 1) * PAGE_SIZE >= historyTotal || historyLoading}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
