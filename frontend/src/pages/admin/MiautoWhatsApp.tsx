/**
 * Yego Rapidín 4.0 — WhatsApp Masivo Mi Auto
 * Página para enviar mensajes a todos los conductores de Yego Mi Auto.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FaSearch, FaEye, FaHistory, FaPaperPlane, FaCheckSquare, FaSquare } from 'react-icons/fa';
import { MessageCircle, X } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { buildMiAutoMessage } from '../../utils/miautoWhatsAppMessageBuilder';

// ── Tipos ──
interface SolicitudRow {
  id: string;
  first_name: string;
  last_name: string;  // se llena desde driver_name de la API
  phone: string;
  cronograma_name?: string;
  cronograma_id?: string;
  vehiculo_name?: string;
  cuotas_pendientes?: number;
  total_pendiente?: number;
}

interface CronogramaOption {
  id: string;
  name: string;
}

interface LogItem {
  id: string;
  solicitud_id: string;
  driver_name: string;
  phone: string;
  status: string;
  error?: string;
  created_by?: string;
  sent_at?: string;
  created_at: string;
}

// ── Componente ──
const MiautoWhatsApp: React.FC = () => {
  const [solicitudes, setSolicitudes] = useState<SolicitudRow[]>([]);
  const [cronogramas, setCronogramas] = useState<CronogramaOption[]>([]);
  const [filtroCronograma, setFiltroCronograma] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ sent: any[]; failed: any[]; total: number } | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [progressData, setProgressData] = useState<{ total: number; current: number; items: { id: string; name: string; status: 'pending' | 'sending' | 'sent' | 'failed'; error?: string }[] }>({ total: 0, current: 0, items: [] });
  const loadedRef = useRef(false);

  // Paginación
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const PAGE_SIZES = [5, 10, 20, 50];
  const PAGINATION_BTN =
    'w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

  // Preview
  const [previewMessage, setPreviewMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LogItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);

  // ── Cargar datos ──
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadData();
    loadCronogramas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await api.get('/miauto/solicitudes', { params: { active: true, country: 'PE', limit: 200 } });
      const raw = res.data?.data || [];
      const rows: SolicitudRow[] = raw.map((s: any) => ({
        id: s.id,
        first_name: s.driver_name || s.working_driver_name || '',
        last_name: '',
        phone: s.phone || '',
        cronograma_name: s.cronograma?.name || '',
        cronograma_id: s.cronograma?.id || '',
      }));
      setSolicitudes(rows);
    } catch (err) {
      toast.error('Error cargando solicitudes');
    } finally {
      setLoading(false);
    }
  };

  const loadCronogramas = async () => {
    try {
      const res = await api.get('/miauto/cronogramas', { params: { active: true, lite: true } });
      setCronogramas(res.data?.data || []);
    } catch { /* silencioso */ }
  };

  // ── Filtros ──
  const filtered = solicitudes.filter((s) => {
    if (filtroCronograma && (s as any).cronograma_id !== filtroCronograma) return false;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      const nombre = (s.first_name || '').toLowerCase();
      if (!nombre.includes(q) && !s.phone.includes(q)) return false;
    }
    return true;
  });

  // ── Paginación ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = Math.max(1, Math.min(page, totalPages));
  const paginatedItems = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

  function getVisiblePages(total: number, current: number): number[] {
    const pages: number[] = [];
    let start = Math.max(1, current - 2);
    let end = Math.min(total, current + 2);
    if (end - start < 4) {
      if (start === 1) end = Math.min(total, start + 4);
      else start = Math.max(1, end - 4);
    }
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  }

  // ── Selección ──
  const allSelected = filtered.length > 0 && filtered.every((s) => selectedIds.has(s.id));
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((s) => s.id)));
    }
  };
  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  // ── Preview ──
  const handlePreview = async () => {
    if (selectedIds.size === 0) return toast.error('Seleccioná al menos un conductor');
    setPreviewMessage('');
    setShowPreview(true);
    setPreviewLoading(true);
    let msgs = '';
    for (const sid of selectedIds) {
      try {
        const cuotasRes = await api.get(`/miauto/solicitudes/${sid}/cuotas-semanales`);
        const cuotas = cuotasRes.data?.data?.data || [];
        const sol = solicitudes.find(s => s.id === sid);
        const result = buildMiAutoMessage({ driverName: sol?.first_name || 'Conductor', cuotas });
        msgs += `\n── ${sol?.first_name || 'Conductor'} (${sol?.phone || 'sin teléfono'}) ──\n${result.fullMessage}\n`;
      } catch (e) {
        msgs += `\n── Error ──\nNo se pudo cargar las cuotas\n`;
      }
    }
    setPreviewMessage(msgs.trim());
    setPreviewLoading(false);
  };

  // ── Enviar ──
  const handleSend = async () => {
    if (selectedIds.size === 0) return toast.error('Seleccioná al menos un conductor');
    if (!confirm(`¿Enviar WhatsApp a ${selectedIds.size} conductor(es)?`)) return;
    setSending(true);
    setSendResult(null);

    // Inicializar progreso
    const ids = [...selectedIds];
    const initItems = ids.map(sid => {
      const sol = solicitudes.find(s => s.id === sid);
      return { id: sid, name: sol?.first_name || 'Conductor', status: 'pending' as const };
    });
    setProgressData({ total: ids.length, current: 0, items: initItems });
    setShowProgress(true);

    const sent: any[] = [];
    const failed: any[] = [];

    for (let i = 0; i < ids.length; i++) {
      const sid = ids[i];
      setProgressData(p => ({ ...p, current: i + 1, items: p.items.map(it => it.id === sid ? { ...it, status: 'sending' } : it) }));

      try {
        const cuotasRes = await api.get(`/miauto/solicitudes/${sid}/cuotas-semanales`);
        const cuotas = cuotasRes.data?.data?.data || [];
        const sol = solicitudes.find(s => s.id === sid);
        const name = sol?.first_name || 'Conductor';
        const result = buildMiAutoMessage({ driverName: name, cuotas });
        const item = [{ solicitud_id: sid, phone: sol?.phone || '', driver_name: name, message: result.fullMessage }];

        const res = await api.post('/miauto/admin/whatsapp/enviar', { items: item });
        const r = res.data?.data;
        if (r.sent.length > 0) {
          sent.push(r.sent[0]);
          setProgressData(p => ({ ...p, items: p.items.map(it => it.id === sid ? { ...it, status: 'sent' } : it) }));
        } else {
          failed.push(r.failed[0] || { solicitudId: sid, driverName: name, error: 'Error desconocido' });
          setProgressData(p => ({ ...p, items: p.items.map(it => it.id === sid ? { ...it, status: 'failed', error: r.failed[0]?.error } : it) }));
        }
      } catch (err: any) {
        failed.push({ solicitudId: sid, driverName: 'Desconocido', error: err?.message || 'Error' });
        setProgressData(p => ({ ...p, items: p.items.map(it => it.id === sid ? { ...it, status: 'failed', error: err?.message } : it) }));
      }
    }

    setSendResult({ sent, failed, total: ids.length });
    toast.success(`Enviados: ${sent.length}. Fallidos: ${failed.length}`);
    setSending(false);
  };

  // ── Historial ──
  const loadHistory = useCallback(async (page = 1) => {
    setHistoryPage(page);
    try {
      const res = await api.get('/miauto/admin/whatsapp/log', { params: { page, limit: 50 } });
      setHistory(res.data?.data?.data || []);
      setHistoryTotal(res.data?.data?.total || 0);
    } catch { /* silencioso */ }
  }, []);

  const openHistory = () => {
    setShowHistory(true);
    loadHistory(1);
  };

  // ── Select input class ──
  const selectClass = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm';

  // ── Render ──
  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header — sistema */}
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Mensajes WhatsApp</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">Yego Mi Auto — Envío masivo a conductores</p>
          </div>
        </div>
      </header>

      {/* Filtros — card sistema */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <p className="text-xs font-semibold text-[#8B1A1A] uppercase tracking-wide mb-3">Filtros</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="filtro-cronograma" className="block text-xs font-semibold text-gray-900 mb-1.5">Cronograma</label>
            <select
              id="filtro-cronograma"
              value={filtroCronograma}
              onChange={(e) => setFiltroCronograma(e.target.value)}
              className={selectClass}
            >
              <option value="">Todos los cronogramas</option>
              {cronogramas.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="busqueda-conductor" className="block text-xs font-semibold text-gray-900 mb-1.5">Buscar conductor</label>
            <div className="relative">
              <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="busqueda-conductor"
                type="text"
                placeholder="Nombre, vehículo o teléfono..."
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Total bar */}
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{filtered.length.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">conductores</span>
        {busqueda && (
          <span className="text-xs text-gray-500 w-full sm:w-auto sm:ml-2">
            (filtrados desde {solicitudes.length.toLocaleString('es-PE')} cargados)
          </span>
        )}
      </div>

      {/* Barra de acciones */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <button onClick={toggleAll} className="inline-flex items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg">
          {allSelected ? <FaCheckSquare className="text-[#8B1A1A]" /> : <FaSquare className="text-gray-300" />}
          {allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'} ({filtered.length})
        </button>
        <div className="flex gap-2">
          <button
            onClick={handlePreview}
            disabled={selectedIds.size === 0 || previewLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-300 disabled:opacity-50"
          >
            <FaEye className="w-4 h-4" /> Preview ({selectedIds.size})
          </button>
          <button
            onClick={openHistory}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-300"
          >
            <FaHistory className="w-4 h-4" /> Historial
          </button>
          <button
            onClick={handleSend}
            disabled={selectedIds.size === 0 || sending}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-[#25D366] rounded-lg hover:bg-[#1da851] disabled:opacity-50"
          >
            <FaPaperPlane className="w-4 h-4" /> {sending ? 'Enviando...' : `Enviar (${selectedIds.size})`}
          </button>
        </div>
      </div>

      {/* Resultado último envío */}
      {sendResult && (
        <div className={`p-3 rounded-lg text-sm ${sendResult.failed.length > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200'}`}>
          ✅ {sendResult.sent.length} enviado(s){sendResult.failed.length > 0 && `, ❌ ${sendResult.failed.length} fallido(s)`} de {sendResult.total} total
        </div>
      )}

      {/* Tabla / Loading / Empty */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <MessageCircle className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">Sin resultados</h3>
          <p className="text-gray-600 text-sm">No se encontraron conductores con los filtros actuales.</p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-gray-200 shadow-sm">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Teléfono</th>
                <th className="w-24 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {paginatedItems.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <button onClick={() => toggleOne(s.id)} className="text-lg">
                      {selectedIds.has(s.id)
                        ? <FaCheckSquare className="text-[#8B1A1A]" />
                        : <FaSquare className="text-gray-300" />}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-gray-900">{s.first_name}</span>
                    <div className="text-xs text-gray-400">{s.cronograma_name}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{s.phone || '—'}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={async () => {
                        try {
                          setPreviewMessage('');
                          setShowPreview(true);
                          setPreviewLoading(true);
                          const cuotasRes = await api.get(`/miauto/solicitudes/${s.id}/cuotas-semanales`);
                          const cuotas = cuotasRes.data?.data?.data || [];
                          const result = buildMiAutoMessage({ driverName: s.first_name || 'Conductor', cuotas });
                          setPreviewMessage(`── ${s.first_name || 'Conductor'} (${s.phone || 'sin teléfono'}) ──\n${result.fullMessage}`);
                        } catch { toast.error('Error al generar preview'); }
                        finally { setPreviewLoading(false); }
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg"
                      title="Vista previa"
                    >
                      <FaEye className="w-4 h-4" /> Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginación */}
      {!loading && totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-600">Por página:</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:ring-2 focus:ring-red-500"
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <button disabled={pageClamped <= 1} onClick={() => setPage(1)} className={PAGINATION_BTN}>«</button>
            <button disabled={pageClamped <= 1} onClick={() => setPage(p => p - 1)} className={PAGINATION_BTN}>‹</button>
            {getVisiblePages(totalPages, pageClamped).map((n) => (
              <button
                key={n}
                onClick={() => setPage(n)}
                className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  pageClamped === n ? 'bg-red-600 text-white border-2 border-red-600'
                                    : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
                }`}
              >
                {n}
              </button>
            ))}
            <button disabled={pageClamped >= totalPages} onClick={() => setPage(p => p + 1)} className={PAGINATION_BTN}>›</button>
            <button disabled={pageClamped >= totalPages} onClick={() => setPage(totalPages)} className={PAGINATION_BTN}>»</button>
          </div>
        </div>
      )}

      {/* Modal Preview */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[min(90vh,640px)] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h2 className="text-lg font-bold text-gray-900">Mensaje WhatsApp</h2>
              <button onClick={() => setShowPreview(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              {previewLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-red-600 border-t-transparent" />
                </div>
              ) : (
                <pre className="text-xs text-gray-700 bg-gray-50 rounded-lg p-4 whitespace-pre-wrap font-sans border">
                  {previewMessage}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Progreso de Envío */}
      {showProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h2 className="text-lg font-bold text-gray-900">Enviando WhatsApp ({progressData.total})</h2>
            </div>
            <div className="p-5 space-y-3">
              {/* Barra de progreso */}
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div className="bg-green-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressData.total > 0 ? Math.round((progressData.current / progressData.total) * 100) : 0}%` }} />
              </div>
              <p className="text-sm text-gray-600 text-center">
                {progressData.current} de {progressData.total} enviados
                ({progressData.total > 0 ? Math.round((progressData.current / progressData.total) * 100) : 0}%)
              </p>

              {/* Lista de conductores */}
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {progressData.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between text-sm py-1 px-2 rounded">
                    <span className="text-gray-700 truncate flex-1">{item.name}</span>
                    <span className="ml-2">
                      {item.status === 'pending' && <span className="text-gray-400 text-xs">⏳</span>}
                      {item.status === 'sending' && (
                        <span className="flex items-center gap-1">
                          <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                          <span className="text-xs text-gray-500">Enviando...</span>
                        </span>
                      )}
                      {item.status === 'sent' && <span className="text-green-600">✅</span>}
                      {item.status === 'failed' && (
                        <span className="text-red-500 text-xs" title={item.error || ''}>❌ {item.error?.slice(0, 20)}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Botón cerrar al terminar */}
              {progressData.current >= progressData.total && (
                <button onClick={() => setShowProgress(false)}
                  className="w-full mt-3 px-4 py-2 text-sm font-medium text-white bg-[#8B1A1A] rounded-lg hover:bg-[#6B1515]">
                  Cerrar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Historial */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowHistory(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[min(90vh,640px)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b px-5 py-3 flex items-center justify-between z-10">
              <h2 className="text-lg font-bold text-gray-900">Historial de envíos</h2>
              <button onClick={() => setShowHistory(false)} className="p-1 text-gray-500 hover:text-gray-700 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-700 uppercase">
                  <tr>
                    <th className="px-4 py-3">Fecha</th>
                    <th className="px-4 py-3">Conductor</th>
                    <th className="px-4 py-3">Teléfono</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {history.map((h) => (
                    <tr key={h.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-600">
                        {h.sent_at ? new Date(h.sent_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{h.driver_name}</td>
                      <td className="px-4 py-3 text-gray-500">{h.phone}</td>
                      <td className="px-4 py-3">
                        {h.status === 'sent' ? <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">✅ Enviado</span>
                          : h.status === 'failed' ? <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">❌ Fallido</span>
                          : <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">⏳ Pendiente</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-red-500 max-w-[200px] truncate">{h.error || '—'}</td>
                    </tr>
                  ))}
                  {history.length === 0 && (
                    <tr><td colSpan={5} className="text-center py-8 text-gray-400">Sin envíos registrados</td></tr>
                  )}
                </tbody>
              </table>
              {historyTotal > 50 && (
                <div className="flex justify-center gap-2 mt-4">
                  <button
                    disabled={historyPage <= 1}
                    onClick={() => loadHistory(historyPage - 1)}
                    className="px-3 py-1 text-sm border border-gray-300 rounded-lg disabled:opacity-50"
                  >Anterior</button>
                  <span className="px-3 py-1 text-sm text-gray-500">Página {historyPage}</span>
                  <button
                    disabled={historyPage * 50 >= historyTotal}
                    onClick={() => loadHistory(historyPage + 1)}
                    className="px-3 py-1 text-sm border border-gray-300 rounded-lg disabled:opacity-50"
                  >Siguiente</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MiautoWhatsApp;
