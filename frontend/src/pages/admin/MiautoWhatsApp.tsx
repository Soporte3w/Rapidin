/**
 * Yego Rapidín 4.0 — WhatsApp Masivo Mi Auto
 * Página para enviar mensajes a todos los conductores de Yego Mi Auto.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { FaWhatsapp, FaSearch, FaEye, FaHistory, FaPaperPlane, FaCheckSquare, FaSquare } from 'react-icons/fa';
import api from '../../services/api';
import toast from 'react-hot-toast';

// ── Tipos ──
interface SolicitudRow {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  cronograma_name?: string;
  vehiculo_name?: string;
  cuotas_pendientes?: number;
  total_pendiente?: number;
}

interface CronogramaOption {
  id: string;
  name: string;
}

interface PreviewItem {
  solicitud_id: string;
  message: string;
  phone: string;
  driverName: string;
  error?: string;
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
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number; total: number } | null>(null);

  // Preview
  const [previewData, setPreviewData] = useState<PreviewItem[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LogItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);

  // ── Cargar datos ──
  useEffect(() => {
    loadData();
    loadCronogramas();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await api.get('/miauto/solicitudes', { params: { active: true, country: 'PE' } });
      const rows: SolicitudRow[] = (res.data?.data || []).map((s: any) => ({
        id: s.id,
        first_name: s.first_name || '',
        last_name: s.last_name || '',
        phone: s.phone || '',
        cronograma_name: s.cronograma?.name || '',
        cronograma_id: s.cronograma?.id || '',
        vehiculo_name: s.cronograma_vehiculo?.name || '',
        cuotas_pendientes: s.cuotas_pendientes ?? 0,
        total_pendiente: s.total_pendiente ?? 0,
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
      const nombre = `${s.first_name} ${s.last_name}`.toLowerCase();
      const vehiculo = (s.vehiculo_name || '').toLowerCase();
      if (!nombre.includes(q) && !vehiculo.includes(q) && !s.phone.includes(q)) return false;
    }
    return true;
  });

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
    setPreviewLoading(true);
    setShowPreview(true);
    try {
      const res = await api.post('/miauto/admin/whatsapp/preview', {
        solicitud_ids: [...selectedIds],
      });
      setPreviewData(res.data?.data || []);
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Error al generar preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Enviar ──
  const handleSend = async () => {
    if (selectedIds.size === 0) return toast.error('Seleccioná al menos un conductor');
    if (!confirm(`¿Enviar WhatsApp a ${selectedIds.size} conductor(es)?`)) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await api.post('/miauto/admin/whatsapp/enviar', {
        solicitud_ids: [...selectedIds],
      });
      const result = res.data?.data;
      setSendResult(result);
      toast.success(`Enviados: ${result.sent.length}. Fallidos: ${result.failed.length}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Error al enviar');
    } finally {
      setSending(false);
    }
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

  // ── Render ──
  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <FaWhatsapp className="text-[#25D366] text-3xl" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Envío de WhatsApp</h1>
          <p className="text-sm text-gray-500">Yego Mi Auto — Mensajería masiva a conductores</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filtroCronograma}
          onChange={(e) => setFiltroCronograma(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">Todos los cronogramas</option>
          {cronogramas.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div className="relative flex-1 max-w-xs">
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs" />
          <input
            type="text"
            placeholder="Buscar conductor..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className="border rounded-lg pl-9 pr-3 py-2 text-sm w-full"
          />
        </div>
      </div>

      {/* Barra de acciones */}
      <div className="flex items-center justify-between mb-3 bg-gray-50 rounded-lg px-4 py-2">
        <button onClick={toggleAll} className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900">
          {allSelected ? <FaCheckSquare className="text-green-600" /> : <FaSquare className="text-gray-400" />}
          {allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'} ({filtered.length})
        </button>
        <div className="flex gap-2">
          <button
            onClick={handlePreview}
            disabled={selectedIds.size === 0 || previewLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            <FaEye /> Preview ({selectedIds.size})
          </button>
          <button
            onClick={openHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border rounded-lg hover:bg-gray-100"
          >
            <FaHistory /> Historial
          </button>
          <button
            onClick={handleSend}
            disabled={selectedIds.size === 0 || sending}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-[#25D366] text-white rounded-lg hover:bg-[#1da851] disabled:opacity-50 font-medium"
          >
            <FaPaperPlane /> {sending ? 'Enviando...' : `Enviar (${selectedIds.size})`}
          </button>
        </div>
      </div>

      {/* Resultado último envío */}
      {sendResult && (
        <div className={`mb-3 p-3 rounded-lg text-sm ${sendResult.failed > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200'}`}>
          ✅ {sendResult.sent} enviado(s){sendResult.failed > 0 && `, ❌ ${sendResult.failed} fallido(s)`} de {sendResult.total} total
        </div>
      )}

      {/* Tabla */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Cargando...</div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase">
              <tr>
                <th className="w-10 px-3 py-3"></th>
                <th className="px-3 py-3">Conductor</th>
                <th className="px-3 py-3">Vehículo</th>
                <th className="px-3 py-3">Teléfono</th>
                <th className="w-14 px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50/60">
                  <td className="px-3 py-2.5">
                    <button onClick={() => toggleOne(s.id)} className="text-lg">
                      {selectedIds.has(s.id) ? <FaCheckSquare className="text-green-600" /> : <FaSquare className="text-gray-300" />}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 font-medium text-gray-900">
                    {s.first_name} {s.last_name}
                    <div className="text-xs text-gray-400 font-normal">{s.cronograma_name}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{s.vehiculo_name || '—'}</td>
                  <td className="px-3 py-2.5 text-gray-600">{s.phone || '—'}</td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={async () => {
                        try {
                          const res = await api.post('/miauto/admin/whatsapp/preview', {
                            solicitud_ids: [s.id],
                          });
                          setPreviewData(res.data?.data || []);
                          setShowPreview(true);
                        } catch { toast.error('Error al generar preview'); }
                      }}
                      className="text-gray-400 hover:text-[#25D366]"
                      title="Vista previa"
                    >
                      <FaEye />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">Sin resultados</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Preview */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b px-5 py-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Vista previa ({previewData.length})</h3>
              <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="p-5 space-y-6">
              {previewLoading ? (
                <p className="text-gray-500 text-center py-8">Generando mensajes...</p>
              ) : previewData.length === 0 ? (
                <p className="text-gray-500 text-center py-8">Sin datos</p>
              ) : (
                previewData.map((p, i) => (
                  <div key={p.solicitud_id || i} className="border rounded-lg p-4">
                    {p.error ? (
                      <p className="text-red-600 text-sm">❌ Error: {p.error}</p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-medium text-sm">{p.driverName}</span>
                          <span className="text-xs text-gray-400">{p.phone}</span>
                        </div>
                        <pre className="text-xs text-gray-700 bg-gray-50 rounded p-3 whitespace-pre-wrap max-h-64 overflow-y-auto font-sans">
                          {p.message}
                        </pre>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Historial */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowHistory(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b px-5 py-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Historial de envíos</h3>
              <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="p-5">
              <table className="w-full text-sm">
                <thead className="text-left text-xs font-semibold text-gray-500 uppercase border-b">
                  <tr>
                    <th className="py-2 px-2">Fecha</th>
                    <th className="py-2 px-2">Conductor</th>
                    <th className="py-2 px-2">Teléfono</th>
                    <th className="py-2 px-2">Estado</th>
                    <th className="py-2 px-2">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.map((h) => (
                    <tr key={h.id} className="hover:bg-gray-50">
                      <td className="py-2 px-2 text-gray-600">
                        {h.sent_at ? new Date(h.sent_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                      </td>
                      <td className="py-2 px-2 font-medium">{h.driver_name}</td>
                      <td className="py-2 px-2 text-gray-500">{h.phone}</td>
                      <td className="py-2 px-2">
                        {h.status === 'sent' ? '✅' : h.status === 'failed' ? '❌' : '⏳'}
                      </td>
                      <td className="py-2 px-2 text-xs text-red-500 max-w-[200px] truncate">{h.error || '—'}</td>
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
                    className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                  >Anterior</button>
                  <span className="px-3 py-1 text-sm text-gray-500">Página {historyPage}</span>
                  <button
                    disabled={historyPage * 50 >= historyTotal}
                    onClick={() => loadHistory(historyPage + 1)}
                    className="px-3 py-1 text-sm border rounded disabled:opacity-50"
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
