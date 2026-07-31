import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheckSquare, FaEye, FaHistory, FaPaperPlane, FaSearch, FaSquare } from 'react-icons/fa';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Copy,
  Filter,
  MessageCircle,
  PencilLine,
  Phone,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { buildMiAutoMessage } from '../../utils/miautoWhatsAppMessageBuilder';

interface SolicitudRow {
  id: string;
  first_name: string;
  phone: string;
  cronograma_name?: string;
  cronograma_id?: string;
  vehiculo_name?: string;
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
  queued_at?: string;
  created_at: string;
}

interface HistoryDay {
  date: string;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  processing: number;
}

interface ProgressItem {
  id: string;
  queueId?: string;
  name: string;
  phone: string;
  status: 'pending' | 'preparing' | 'sending' | 'queued' | 'sent' | 'failed';
  error?: string;
}

interface WhatsAppItem {
  solicitud_id: string;
  phone: string;
  driver_name: string;
  message: string;
}

interface PreviewItem {
  id: string;
  name: string;
  phone: string;
  message: string;
  generatedMessage: string;
  error?: string;
}

const PAGE_SIZES = [10, 20, 50, 100];
const HISTORY_PAGE_SIZE = 50;

function cleanPhone(phone?: string) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function hasValidPhone(phone?: string) {
  const digits = cleanPhone(phone).replace(/\D/g, '');
  return digits.length >= 8;
}

function safeName(row?: Pick<SolicitudRow, 'first_name'>) {
  return String(row?.first_name || '').trim() || 'Conductor';
}

function statusLabel(status: ProgressItem['status']) {
  if (status === 'preparing') return 'Preparando';
  if (status === 'sending') return 'Enviando';
  if (status === 'queued') return 'Programado';
  if (status === 'sent') return 'Enviado';
  if (status === 'failed') return 'Fallido';
  return 'Pendiente';
}

function formatPreviewMessage(item: PreviewItem) {
  if (item.error) return `-- ${item.name} (${item.phone || 'sin teléfono'}) --\nNo se pudo generar el mensaje: ${item.error}`;
  return `-- ${item.name} (${item.phone || 'sin teléfono'}) --\n${item.message}`;
}

function extractCuotas(response: any) {
  const payload = response?.data?.data;
  if (Array.isArray(payload?.data)) return payload.data;
  return Array.isArray(payload) ? payload : [];
}

function uniqueRows(rows: SolicitudRow[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function formatHistoryDay(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('es-PE', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const MiautoWhatsApp: React.FC = () => {
  const [solicitudes, setSolicitudes] = useState<SolicitudRow[]>([]);
  const [cronogramas, setCronogramas] = useState<CronogramaOption[]>([]);
  const [filtroCronograma, setFiltroCronograma] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([]);
  const [messageOverrides, setMessageOverrides] = useState<Record<string, string>>({});
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LogItem[]>([]);
  const [historyDays, setHistoryDays] = useState<HistoryDay[]>([]);
  const [selectedHistoryDate, setSelectedHistoryDate] = useState('');
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyStatus, setHistoryStatus] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const loadedRef = useRef(false);
  const cuotasRequestsRef = useRef<Map<string, Promise<any[]>>>(new Map());

  const loadData = useCallback(async (refreshCuotas = false) => {
    try {
      setLoading(true);
      if (refreshCuotas) cuotasRequestsRef.current.clear();
      const response = await api.get('/miauto/admin/whatsapp/recipients', {
        params: { country: 'PE' },
      });
      const raw = Array.isArray(response.data?.data) ? response.data.data : [];
      const rows = uniqueRows(raw.map((s: any): SolicitudRow => ({
        id: s.id,
        first_name: s.driver_name || '',
        phone: s.phone || '',
        cronograma_name: s.cronograma_name || '',
        cronograma_id: s.cronograma_id || '',
        vehiculo_name: s.vehiculo_name || '',
      })));
      const availableIds = new Set(rows.map((row) => row.id));
      setSolicitudes(rows);
      setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
      setMessageOverrides((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => availableIds.has(id))
      ));
    } catch {
      toast.error('Error cargando conductores');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCronogramas = useCallback(async () => {
    try {
      const res = await api.get('/miauto/cronogramas', { params: { active: true, lite: true } });
      setCronogramas(res.data?.data || []);
    } catch {
      setCronogramas([]);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadData();
    loadCronogramas();
  }, [loadCronogramas, loadData]);

  useEffect(() => {
    setPage(1);
  }, [busqueda, filtroCronograma, pageSize]);

  const filtered = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return solicitudes.filter((s) => {
      if (filtroCronograma && s.cronograma_id !== filtroCronograma) return false;
      if (!q) return true;
      const haystack = [
        s.first_name,
        s.phone,
        s.cronograma_name,
        s.vehiculo_name,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [busqueda, filtroCronograma, solicitudes]);

  const eligibleFiltered = useMemo(() => filtered.filter((s) => hasValidPhone(s.phone)), [filtered]);
  const selectedRows = useMemo(
    () => solicitudes.filter((s) => selectedIds.has(s.id)),
    [selectedIds, solicitudes]
  );
  const selectedEligibleRows = useMemo(
    () => selectedRows.filter((s) => hasValidPhone(s.phone)),
    [selectedRows]
  );
  const invalidSelectedCount = selectedRows.length - selectedEligibleRows.length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = Math.max(1, Math.min(page, totalPages));
  const paginatedItems = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);
  const allEligibleSelected = eligibleFiltered.length > 0 && eligibleFiltered.every((s) => selectedIds.has(s.id));

  const selectedCronogramaName = useMemo(() => {
    if (!filtroCronograma) return '';
    return cronogramas.find((c) => c.id === filtroCronograma)?.name || '';
  }, [cronogramas, filtroCronograma]);

  const progressStats = useMemo(() => {
    const queued = progressItems.filter((i) => i.status === 'queued').length;
    const sent = progressItems.filter((i) => i.status === 'sent').length;
    const failed = progressItems.filter((i) => i.status === 'failed').length;
    const done = sent + failed;
    const total = progressItems.length;
    return { queued, sent, failed, done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  }, [progressItems]);

  const trackedQueueIds = useMemo(
    () => progressItems
      .filter((item) => item.queueId && (item.status === 'queued' || item.status === 'sending'))
      .map((item) => item.queueId)
      .sort()
      .join(','),
    [progressItems]
  );

  useEffect(() => {
    if (!showProgress || !trackedQueueIds) return undefined;

    let cancelled = false;
    let requestRunning = false;
    const ids = trackedQueueIds.split(',');

    const refreshStatuses = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const response = await api.post('/miauto/admin/whatsapp/status', { ids });
        if (cancelled) return;

        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        const statusById = new Map(rows.map((row: any) => [String(row.id), row]));
        setProgressItems((items) => items.map((item) => {
          if (!item.queueId) return item;
          const current = statusById.get(item.queueId) as any;
          if (!current) return item;
          if (current.status === 'sent') return { ...item, status: 'sent', error: undefined };
          if (current.status === 'failed') {
            return { ...item, status: 'failed', error: current.error || 'Error al enviar' };
          }
          if (current.status === 'processing') return { ...item, status: 'sending', error: undefined };
          return { ...item, status: 'queued', error: undefined };
        }));
      } catch {
        // El historial conserva el estado; el siguiente ciclo vuelve a consultarlo.
      } finally {
        requestRunning = false;
      }
    };

    refreshStatuses();
    const interval = window.setInterval(refreshStatuses, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [showProgress, trackedQueueIds]);

  const activePreview = previewItems[activePreviewIndex] || null;
  const isSinglePreview = previewItems.length <= 1;
  const previewReadyCount = previewItems.filter((item) => !item.error).length;
  const previewErrorCount = previewItems.length - previewReadyCount;
  const hasMultiplePreview = previewItems.length > 1;
  const previewText = useMemo(() => previewItems.map(formatPreviewMessage).join('\n\n'), [previewItems]);
  const previewMatchesSelection = useMemo(() => {
    if (previewItems.length === 0 || previewItems.length !== selectedEligibleRows.length) return false;
    return previewItems.every((item) => selectedIds.has(item.id));
  }, [previewItems, selectedEligibleRows.length, selectedIds]);
  const editedPreviewCount = useMemo(
    () => previewItems.filter((item) => !item.error && item.message !== item.generatedMessage).length,
    [previewItems]
  );
  const previewActionLabel = previewLoading
    ? 'Generando...'
    : selectedEligibleRows.length > 1
      ? `Revisar seleccionados (${selectedEligibleRows.length})`
      : 'Revisar mensaje';

  const historyFiltered = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => [
      h.driver_name,
      h.phone,
      h.status,
      h.error,
      h.created_by,
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [history, historySearch]);

  const selectedHistoryDay = useMemo(
    () => historyDays.find((day) => day.date === selectedHistoryDate) || null,
    [historyDays, selectedHistoryDate]
  );

  function toggleAll() {
    if (allEligibleSelected) {
      setSelectedIds((current) => {
        const next = new Set(current);
        eligibleFiltered.forEach((s) => next.delete(s.id));
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      eligibleFiltered.forEach((s) => next.add(s.id));
      return next;
    });
  }

  function toggleOne(row: SolicitudRow) {
    if (!hasValidPhone(row.phone)) {
      toast.error('Este conductor no tiene teléfono válido');
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function updateProgress(id: string, patch: Partial<ProgressItem>) {
    setProgressItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  const getCuotas = useCallback((solicitudId: string) => {
    const cachedRequest = cuotasRequestsRef.current.get(solicitudId);
    if (cachedRequest) return cachedRequest;

    const request = api
      .get(`/miauto/solicitudes/${solicitudId}/cuotas-semanales`)
      .then(extractCuotas)
      .catch((error) => {
        if (cuotasRequestsRef.current.get(solicitudId) === request) {
          cuotasRequestsRef.current.delete(solicitudId);
        }
        throw error;
      });

    cuotasRequestsRef.current.set(solicitudId, request);
    return request;
  }, []);

  async function buildItem(row: SolicitudRow): Promise<WhatsAppItem> {
    const cuotas = await getCuotas(row.id);
    const result = buildMiAutoMessage({ driverName: safeName(row), cuotas });
    return {
      solicitud_id: row.id,
      phone: row.phone,
      driver_name: safeName(row),
      message: result.fullMessage,
    };
  }

  async function handlePreview(row?: SolicitudRow) {
    const rows = uniqueRows(row ? [row] : selectedEligibleRows);
    if (rows.length === 0) return toast.error('Selecciona al menos un conductor con teléfono válido');

    setPreviewItems([]);
    setActivePreviewIndex(0);
    setShowPreview(true);
    setPreviewLoading(true);
    try {
      const items: PreviewItem[] = [];
      for (const itemRow of rows) {
        try {
          const item = await buildItem(itemRow);
          const preview = {
            id: item.solicitud_id,
            name: item.driver_name,
            phone: item.phone,
            message: messageOverrides[item.solicitud_id] ?? item.message,
            generatedMessage: item.message,
          };
          items.push(preview);
        } catch (error: any) {
          const preview = {
            id: itemRow.id,
            name: safeName(itemRow),
            phone: itemRow.phone,
            message: '',
            generatedMessage: '',
            error: error?.message || 'Error',
          };
          items.push(preview);
        }
      }
      setPreviewItems(items);
    } finally {
      setPreviewLoading(false);
    }
  }

  function updatePreviewMessage(id: string, message: string) {
    setPreviewItems((items) => items.map((item) => (item.id === id ? { ...item, message } : item)));
    setMessageOverrides((current) => ({ ...current, [id]: message }));
  }

  function resetPreviewMessage(item: PreviewItem) {
    setPreviewItems((items) => items.map((current) => (
      current.id === item.id ? { ...current, message: current.generatedMessage } : current
    )));
    setMessageOverrides((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
  }

  async function copyPreview() {
    if (!previewText.trim()) return;
    await navigator.clipboard.writeText(previewText);
    toast.success('Preview completo copiado');
  }

  async function copyActivePreview() {
    if (!activePreview || activePreview.error) return;
    await navigator.clipboard.writeText(activePreview.message);
    toast.success(`Mensaje de ${activePreview.name} copiado`);
  }

  async function handleSend() {
    if (selectedEligibleRows.length === 0) return toast.error('Selecciona al menos un conductor con teléfono válido');
    setShowSendConfirm(true);
  }

  async function executeSend() {
    if (selectedEligibleRows.length === 0) {
      setShowSendConfirm(false);
      return toast.error('Selecciona al menos un conductor con teléfono válido');
    }
    setShowSendConfirm(false);
    setSending(true);
    setShowProgress(true);
    setProgressItems(selectedEligibleRows.map((s) => ({
      id: s.id,
      name: safeName(s),
      phone: s.phone,
      status: 'pending',
    })));

    const items: WhatsAppItem[] = [];
    const failed: any[] = [];

    for (const row of selectedEligibleRows) {
      updateProgress(row.id, { status: 'preparing' });
      try {
        const editedMessage = messageOverrides[row.id];
        if (editedMessage !== undefined) {
          if (!editedMessage.trim()) throw new Error('El mensaje editado está vacío');
          items.push({
            solicitud_id: row.id,
            phone: row.phone,
            driver_name: safeName(row),
            message: editedMessage.trim(),
          });
        } else {
          items.push(await buildItem(row));
        }
        updateProgress(row.id, { status: 'sending' });
      } catch (error: any) {
        const message = error?.response?.data?.message || error?.message || 'No se pudo generar el mensaje';
        failed.push({ solicitudId: row.id, driverName: safeName(row), error: message });
        updateProgress(row.id, { status: 'failed', error: message });
      }
    }

    if (items.length === 0) {
      setSending(false);
      toast.error('No se pudo preparar ningún mensaje');
      return;
    }

    try {
      const res = await api.post('/miauto/admin/whatsapp/enviar', { items });
      const result = res.data?.data || { queued: [], failed: [] };
      const queued = Array.isArray(result.queued) ? result.queued : [];
      const apiFailed = Array.isArray(result.failed) ? result.failed : [];

      queued.forEach((item: any) => updateProgress(item.solicitudId, {
        status: 'queued',
        queueId: item.id,
      }));
      apiFailed.forEach((item: any) => updateProgress(item.solicitudId, {
        status: 'failed',
        error: item.error || 'Error al enviar',
      }));

      const allFailed = [...failed, ...apiFailed];
      if (queued.length > 0) {
        setSelectedIds((current) => {
          const next = new Set(current);
          queued.forEach((item: any) => next.delete(item.solicitudId));
          return next;
        });
        setMessageOverrides((current) => {
          const next = { ...current };
          queued.forEach((item: any) => delete next[item.solicitudId]);
          return next;
        });
      }
      if (queued.length > 0) {
        toast.success(`Programados: ${queued.length}. Se enviarán máximo 3 cada 2 minutos.`);
      }
      if (allFailed.length > 0) toast.error(`No programados: ${allFailed.length}`);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Error al enviar';
      items.forEach((item) => updateProgress(item.solicitud_id, { status: 'failed', error: message }));
      toast.error(message);
    } finally {
      setSending(false);
    }
  }

  const loadHistory = useCallback(async (pageToLoad: number, statusToLoad: string, dateToLoad: string) => {
    if (!dateToLoad) {
      setHistory([]);
      setHistoryTotal(0);
      return;
    }

    setHistoryPage(pageToLoad);
    setHistoryLoading(true);
    try {
      const params: any = {
        date: dateToLoad,
        page: pageToLoad,
        limit: HISTORY_PAGE_SIZE,
      };
      if (statusToLoad) params.status = statusToLoad;
      const res = await api.get('/miauto/admin/whatsapp/log', { params });
      setHistory(res.data?.data?.data || []);
      setHistoryTotal(res.data?.data?.total || 0);
    } catch {
      toast.error('Error cargando historial');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadHistoryDays = useCallback(async (preferredDate = '', statusToLoad = '') => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/miauto/admin/whatsapp/log-days');
      const days: HistoryDay[] = Array.isArray(res.data?.data) ? res.data.data : [];
      const nextDate = days.some((day) => day.date === preferredDate)
        ? preferredDate
        : days[0]?.date || '';

      setHistoryDays(days);
      setSelectedHistoryDate(nextDate);
      setHistorySearch('');
      await loadHistory(1, statusToLoad, nextDate);
    } catch {
      setHistoryDays([]);
      setHistory([]);
      setHistoryTotal(0);
      toast.error('Error cargando fechas del historial');
    } finally {
      setHistoryLoading(false);
    }
  }, [loadHistory]);

  function openHistory() {
    setShowHistory(true);
    loadHistoryDays(selectedHistoryDate, historyStatus);
  }

  const selectClass = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm bg-white';
  const iconButtonClass = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="space-y-4 lg:space-y-5">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Mensajes WhatsApp</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Yego Mi Auto</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => loadData(true)}
            disabled={loading || sending}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold bg-white/10 text-white border border-white/25 rounded-lg hover:bg-white/15 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold uppercase">
            <Users className="w-4 h-4" />
            Cargados
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">{solicitudes.length.toLocaleString('es-PE')}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold uppercase">
            <Filter className="w-4 h-4" />
            Filtrados
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">{filtered.length.toLocaleString('es-PE')}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold uppercase">
            <Phone className="w-4 h-4" />
            Con teléfono
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">{eligibleFiltered.length.toLocaleString('es-PE')}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold uppercase">
            <CheckCircle2 className="w-4 h-4" />
            Seleccionados
          </div>
          <div className="mt-2 text-2xl font-bold text-[#8B1A1A]">{selectedEligibleRows.length.toLocaleString('es-PE')}</div>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
          <div>
            <label htmlFor="filtro-cronograma" className="block text-xs font-semibold text-gray-900 mb-1.5">Cronograma</label>
            <select id="filtro-cronograma" value={filtroCronograma} onChange={(e) => setFiltroCronograma(e.target.value)} className={selectClass}>
              <option value="">Todos los cronogramas</option>
              {cronogramas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="busqueda-conductor" className="block text-xs font-semibold text-gray-900 mb-1.5">Buscar</label>
            <div className="relative">
              <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="busqueda-conductor"
                type="text"
                placeholder="Nombre, teléfono, cronograma o vehículo"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
              />
            </div>
          </div>
        </div>
        {(busqueda || filtroCronograma) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            {filtroCronograma && <span className="px-2 py-1 bg-red-50 text-[#8B1A1A] rounded">Cronograma: {selectedCronogramaName || 'seleccionado'}</span>}
            {busqueda && <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded">Búsqueda: {busqueda}</span>}
            <button
              type="button"
              onClick={() => { setBusqueda(''); setFiltroCronograma(''); }}
              className="px-2 py-1 text-gray-600 hover:text-gray-900"
            >
              Limpiar filtros
            </button>
          </div>
        )}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={eligibleFiltered.length === 0 || sending}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 rounded-lg disabled:opacity-50"
          >
            {allEligibleSelected ? <FaCheckSquare /> : <FaSquare className="text-gray-300" />}
            {allEligibleSelected ? 'Deseleccionar filtrados' : 'Seleccionar filtrados'} ({eligibleFiltered.length})
          </button>
          {invalidSelectedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
              <AlertTriangle className="w-3.5 h-3.5" />
              {invalidSelectedCount} sin teléfono serán omitidos
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handlePreview()}
            disabled={selectedEligibleRows.length === 0 || previewLoading || sending}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 rounded-lg border border-red-200 disabled:opacity-50"
          >
            <FaEye className="w-4 h-4" />
            {previewActionLabel}
          </button>
          <button
            type="button"
            onClick={openHistory}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-300"
          >
            <FaHistory className="w-4 h-4" />
            Historial
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={selectedEligibleRows.length === 0 || sending}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#128C7E] rounded-lg hover:bg-[#0f766b] disabled:opacity-50"
          >
            <FaPaperPlane className="w-4 h-4" />
            {sending ? 'Enviando...' : `Enviar (${selectedEligibleRows.length})`}
          </button>
        </div>
      </section>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <MessageCircle className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-gray-900 mb-1">Sin resultados</h3>
          <p className="text-gray-600 text-sm">No hay registros activos de Alquiler/Venta para los filtros actuales.</p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-gray-200 shadow-sm">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-12 px-4 py-3" />
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cronograma</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Teléfono</th>
                <th className="w-28 px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {paginatedItems.map((s) => {
                const validPhone = hasValidPhone(s.phone);
                const selected = selectedIds.has(s.id);
                return (
                  <tr key={s.id} className={`hover:bg-gray-50 ${!validPhone ? 'bg-amber-50/35' : ''}`}>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleOne(s)}
                        className="text-lg inline-flex items-center"
                        title={validPhone ? 'Seleccionar' : 'Teléfono inválido'}
                      >
                        {selected ? <FaCheckSquare className="text-[#8B1A1A]" /> : <FaSquare className={validPhone ? 'text-gray-300' : 'text-amber-300'} />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-gray-900">{safeName(s)}</div>
                      {s.vehiculo_name && <div className="text-xs text-gray-500">{s.vehiculo_name}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{s.cronograma_name || '-'}</td>
                    <td className="px-4 py-3">
                      <div className={`text-sm ${validPhone ? 'text-gray-700' : 'text-amber-700 font-medium'}`}>
                        {s.phone || 'Sin teléfono'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handlePreview(s)}
                        disabled={!validPhone || previewLoading}
                        className="inline-flex items-center gap-1.5 px-2 py-1.5 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 rounded-lg disabled:opacity-50"
                      >
                        <FaEye className="w-4 h-4" />
                        Ver mensaje
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && totalPages > 1 && (
        <section className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-600">Por página:</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:ring-2 focus:ring-red-500">
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <button disabled={pageClamped <= 1} onClick={() => setPage(1)} className={iconButtonClass}>«</button>
            <button disabled={pageClamped <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className={iconButtonClass}>‹</button>
            <span className="px-3 py-2 text-sm text-gray-600">Página {pageClamped} de {totalPages}</span>
            <button disabled={pageClamped >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className={iconButtonClass}>›</button>
            <button disabled={pageClamped >= totalPages} onClick={() => setPage(totalPages)} className={iconButtonClass}>»</button>
          </div>
        </section>
      )}

      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowPreview(false)}>
          <div className={`${isSinglePreview ? 'max-w-2xl' : 'max-w-5xl'} flex h-[min(92vh,760px)] w-full flex-col rounded-lg bg-white shadow-xl`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-gray-900">{isSinglePreview ? 'Mensaje del conductor' : 'Vista previa'}</h2>
                  {!previewLoading && previewReadyCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      <PencilLine className="h-3 w-3" />
                      Editable
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {previewLoading
                    ? 'Generando mensaje...'
                    : isSinglePreview
                      ? `${activePreview?.name || 'Conductor'}${activePreview?.phone ? ` · ${activePreview.phone}` : ''}`
                      : `${previewReadyCount} listo(s)${previewErrorCount > 0 ? `, ${previewErrorCount} con error` : ''}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {hasMultiplePreview && (
                  <button
                    type="button"
                    onClick={copyActivePreview}
                    disabled={!activePreview || !!activePreview.error}
                    className="inline-flex items-center justify-center gap-2 px-3 h-9 text-sm font-semibold text-gray-700 hover:bg-gray-50 rounded-lg border border-gray-300 disabled:opacity-50"
                    title="Copiar mensaje seleccionado"
                  >
                    <Copy className="w-4 h-4" />
                    Este
                  </button>
                )}
                <button
                  type="button"
                  onClick={isSinglePreview ? copyActivePreview : copyPreview}
                  disabled={isSinglePreview ? (!activePreview || !!activePreview.error) : !previewText.trim()}
                  className={hasMultiplePreview ? 'inline-flex items-center justify-center gap-2 px-3 h-9 text-sm font-semibold text-gray-700 hover:bg-gray-50 rounded-lg border border-gray-300 disabled:opacity-50' : iconButtonClass}
                  title={isSinglePreview ? 'Copiar mensaje' : 'Copiar todos los mensajes'}
                >
                  <Copy className="w-4 h-4" />
                  {hasMultiplePreview && 'Todos'}
                </button>
                <button type="button" onClick={() => setShowPreview(false)} className={iconButtonClass} title="Cerrar">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 lg:overflow-hidden">
              {previewLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-red-600 border-t-transparent" />
                </div>
              ) : (
                <div className={`${isSinglePreview ? 'block' : 'grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]'} min-h-0 lg:h-full`}>
                  {!isSinglePreview && (
                  <aside className="flex max-h-56 min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 lg:h-full lg:max-h-none">
                    <div className="px-3 py-2 bg-gray-50 border-b">
                      <div className="text-xs font-semibold text-gray-600 uppercase">Conductores</div>
                      <div className="text-xs text-gray-500 mt-0.5">{previewReadyCount} listos · {previewErrorCount} errores</div>
                    </div>
                    <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto overscroll-contain">
                      {previewItems.map((item, index) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActivePreviewIndex(index)}
                          className={`w-full text-left px-3 py-3 hover:bg-gray-50 ${activePreviewIndex === index ? 'bg-red-50' : 'bg-white'}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-gray-900 truncate">{item.name}</div>
                              <div className="text-xs text-gray-500 truncate">{item.phone || 'Sin teléfono'}</div>
                            </div>
                            {item.error ? (
                              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </aside>
                  )}

                  <section className="flex min-h-[360px] flex-col overflow-hidden rounded-lg border border-gray-200 lg:h-full lg:min-h-0">
                    <div className="px-4 py-3 bg-gray-50 border-b flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        {hasMultiplePreview && (
                          <div className="text-xs font-semibold text-[#8B1A1A] mb-0.5">
                            Mensaje {activePreviewIndex + 1} de {previewItems.length}
                          </div>
                        )}
                        <div className="text-sm font-bold text-gray-900 truncate">{activePreview?.name || 'Sin mensaje'}</div>
                        <div className="text-xs text-gray-500 truncate">{activePreview?.phone || '-'}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {hasMultiplePreview && (
                          <>
                            <button
                              type="button"
                              onClick={() => setActivePreviewIndex((i) => Math.max(0, i - 1))}
                              disabled={activePreviewIndex <= 0}
                              className="px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-white rounded-lg border border-gray-300 disabled:opacity-50"
                            >
                              Anterior
                            </button>
                            <button
                              type="button"
                              onClick={() => setActivePreviewIndex((i) => Math.min(previewItems.length - 1, i + 1))}
                              disabled={activePreviewIndex >= previewItems.length - 1}
                              className="px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-white rounded-lg border border-gray-300 disabled:opacity-50"
                            >
                              Siguiente
                            </button>
                          </>
                        )}
                        {hasMultiplePreview && (
                          <button
                            type="button"
                            onClick={copyActivePreview}
                            disabled={!activePreview || !!activePreview.error}
                            className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-white rounded-lg border border-gray-300 disabled:opacity-50"
                          >
                            <Copy className="w-4 h-4" />
                            Copiar mensaje
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto bg-white p-4">
                      {activePreview?.error ? (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                          No se pudo generar este mensaje: {activePreview.error}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <textarea
                            value={activePreview?.message || ''}
                            onChange={(event) => activePreview && updatePreviewMessage(activePreview.id, event.target.value)}
                            className="min-h-[320px] w-full resize-y rounded-lg border border-gray-300 bg-white p-4 text-sm leading-relaxed text-gray-800 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
                            aria-label={`Editar mensaje de ${activePreview?.name || 'conductor'}`}
                          />
                          <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
                            <span>{activePreview?.message.length || 0} caracteres</span>
                            {activePreview && activePreview.message !== activePreview.generatedMessage && (
                              <button
                                type="button"
                                onClick={() => resetPreviewMessage(activePreview)}
                                className="font-semibold text-[#8B1A1A] hover:underline"
                              >
                                Restaurar mensaje generado
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>
            {!previewLoading && previewMatchesSelection && (
              <div className="flex flex-col gap-2 border-t bg-gray-50 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-gray-600">
                  {editedPreviewCount > 0
                    ? `${editedPreviewCount} mensaje(s) editado(s); se enviarán con estos cambios.`
                    : 'Los mensajes están listos para enviar.'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (previewItems.some((item) => item.error || !item.message.trim())) {
                      toast.error('Corrige los mensajes vacíos o con error antes de continuar');
                      return;
                    }
                    setShowPreview(false);
                    setShowSendConfirm(true);
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0f766b]"
                >
                  <FaPaperPlane className="h-4 w-4" />
                  Continuar al envío
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showSendConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !sending && setShowSendConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#128C7E]/10 flex items-center justify-center shrink-0">
                  <MessageCircle className="w-5 h-5 text-[#128C7E]" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Confirmar envío</h2>
                  <p className="text-sm text-gray-600 mt-0.5">
                    Se programará WhatsApp para {selectedEligibleRows.length} conductor(es), con un máximo de 3 mensajes cada 2 minutos.
                    {Object.keys(messageOverrides).some((id) => selectedIds.has(id)) && ' Se respetarán los mensajes editados.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSendConfirm(false)}
                disabled={sending}
                className={iconButtonClass}
                title="Cerrar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
                  <div className="text-xs font-semibold text-green-700 uppercase">Listos</div>
                  <div className="text-2xl font-bold text-green-800">{selectedEligibleRows.length}</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="text-xs font-semibold text-amber-700 uppercase">Omitidos</div>
                  <div className="text-2xl font-bold text-amber-800">{invalidSelectedCount}</div>
                </div>
              </div>

              {invalidSelectedCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>Los conductores sin teléfono válido no se enviarán.</span>
                </div>
              )}

              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b text-xs font-semibold text-gray-600 uppercase">
                  Conductores a enviar
                </div>
                <div className="max-h-56 overflow-y-auto divide-y divide-gray-100">
                  {selectedEligibleRows.slice(0, 12).map((row) => (
                    <div key={row.id} className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-gray-900 truncate">{safeName(row)}</div>
                        <div className="text-xs text-gray-500 truncate">{row.cronograma_name || row.vehiculo_name || 'Sin cronograma'}</div>
                      </div>
                      <div className="text-xs text-gray-500 shrink-0">{row.phone}</div>
                    </div>
                  ))}
                  {selectedEligibleRows.length > 12 && (
                    <div className="px-3 py-2 text-xs text-gray-500 bg-gray-50">
                      Y {selectedEligibleRows.length - 12} conductor(es) más...
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="px-5 py-4 bg-gray-50 border-t flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSendConfirm(false)}
                disabled={sending}
                className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={executeSend}
                disabled={sending || selectedEligibleRows.length === 0}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#128C7E] rounded-lg hover:bg-[#0f766b] disabled:opacity-50"
              >
                <FaPaperPlane className="w-4 h-4" />
                {sending ? 'Programando...' : `Programar ${selectedEligibleRows.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Envío de WhatsApp</h2>
                <p className="text-xs text-gray-500">Límite automático: 3 mensajes cada 2 minutos</p>
              </div>
              {!sending && (
                <button type="button" onClick={() => setShowProgress(false)} className={iconButtonClass}>
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-lg border border-gray-200 p-3">
                  <div className="text-xl font-bold text-gray-900">{progressStats.total}</div>
                  <div className="text-xs text-gray-500">Total</div>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <div className="text-xl font-bold text-blue-700">{progressStats.queued}</div>
                  <div className="text-xs text-blue-700">Programados</div>
                </div>
                <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                  <div className="text-xl font-bold text-green-700">{progressStats.sent}</div>
                  <div className="text-xs text-green-700">Enviados</div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <div className="text-xl font-bold text-red-700">{progressStats.failed}</div>
                  <div className="text-xs text-red-700">Fallidos</div>
                </div>
              </div>
              <div>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div className="bg-[#128C7E] h-2.5 rounded-full transition-all duration-300" style={{ width: `${progressStats.percent}%` }} />
                </div>
                <p className="mt-2 text-center text-sm text-gray-600">{progressStats.done} de {progressStats.total} enviados o revisados</p>
              </div>
              <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                {progressItems.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 text-sm py-2 px-2 rounded border border-gray-100">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 truncate">{item.name}</div>
                      <div className="text-xs text-gray-500 truncate">{item.phone}</div>
                    </div>
                    <div className="flex items-center gap-2 text-xs shrink-0">
                      {item.status === 'pending' && <Clock className="w-4 h-4 text-gray-400" />}
                      {(item.status === 'preparing' || item.status === 'sending') && <div className="w-4 h-4 border-2 border-[#128C7E] border-t-transparent rounded-full animate-spin" />}
                      {item.status === 'queued' && <Clock className="w-4 h-4 text-blue-600" />}
                      {item.status === 'sent' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      {item.status === 'failed' && <AlertTriangle className="w-4 h-4 text-red-600" />}
                      <span className={item.status === 'failed' ? 'max-w-[160px] truncate text-red-700' : item.status === 'sent' ? 'text-green-700' : 'text-gray-600'}>
                        {item.status === 'failed' ? item.error || 'Fallido' : statusLabel(item.status)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowHistory(false)}>
          <div className="flex h-[min(90vh,760px)] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <header className="flex flex-col gap-3 border-b bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Historial de envíos</h2>
                <p className="text-xs text-gray-500">
                  {selectedHistoryDay
                    ? `${formatHistoryDay(selectedHistoryDay.date)} · ${selectedHistoryDay.total} mensaje(s)`
                    : 'Selecciona una fecha para consultar sus mensajes'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadHistoryDays(selectedHistoryDate, historyStatus)}
                  disabled={historyLoading}
                  className={iconButtonClass}
                  title="Actualizar historial"
                >
                  <RefreshCw className={`h-4 w-4 ${historyLoading ? 'animate-spin' : ''}`} />
                </button>
                <button type="button" onClick={() => setShowHistory(false)} className={iconButtonClass} title="Cerrar">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[250px_1fr]">
              <aside className="flex min-h-0 flex-col border-b bg-gray-50 lg:border-b-0 lg:border-r">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-gray-800">
                    <CalendarDays className="h-4 w-4 text-[#8B1A1A]" />
                    Fechas
                  </div>
                  <span className="text-xs text-gray-500">{historyDays.length}</span>
                </div>
                <div className="flex max-h-44 gap-2 overflow-x-auto p-3 lg:max-h-none lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
                  {historyDays.map((day) => (
                    <button
                      key={day.date}
                      type="button"
                      onClick={() => {
                        setSelectedHistoryDate(day.date);
                        setHistorySearch('');
                        loadHistory(1, historyStatus, day.date);
                      }}
                      className={`min-w-[190px] rounded-lg border px-3 py-2.5 text-left transition-colors lg:min-w-0 ${
                        selectedHistoryDate === day.date
                          ? 'border-red-200 bg-red-50'
                          : 'border-gray-200 bg-white hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold capitalize text-gray-900">{formatHistoryDay(day.date)}</span>
                        <span className="text-xs font-bold text-gray-600">{day.total}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span className="text-green-700">{day.sent} enviados</span>
                        {day.pending + day.processing > 0 && (
                          <span className="text-blue-700">{day.pending + day.processing} programados</span>
                        )}
                        {day.failed > 0 && <span className="text-red-700">{day.failed} fallidos</span>}
                      </div>
                    </button>
                  ))}
                  {!historyLoading && historyDays.length === 0 && (
                    <div className="px-3 py-8 text-center text-sm text-gray-500">Sin fechas registradas</div>
                  )}
                </div>
              </aside>

              <section className="flex min-h-0 flex-col overflow-hidden">
                <div className="grid grid-cols-1 gap-3 border-b bg-white p-4 md:grid-cols-[1fr_170px_145px_145px]">
                  <div className="relative">
                    <FaSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={historySearch}
                      onChange={(e) => setHistorySearch(e.target.value)}
                      placeholder="Buscar dentro del día"
                      className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
                    />
                  </div>
                  <select
                    value={historyStatus}
                    onChange={(e) => {
                      const value = e.target.value;
                      setHistoryStatus(value);
                      loadHistory(1, value, selectedHistoryDate);
                    }}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
                  >
                    <option value="">Todos los estados</option>
                    <option value="pending">Programados</option>
                    <option value="processing">En proceso</option>
                    <option value="sent">Enviados</option>
                    <option value="failed">Fallidos</option>
                  </select>
                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                    <div className="text-xs text-green-700">Enviados</div>
                    <div className="text-sm font-bold text-green-800">{selectedHistoryDay?.sent || 0}</div>
                  </div>
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                    <div className="text-xs text-red-700">Fallidos</div>
                    <div className="text-sm font-bold text-red-800">{selectedHistoryDay?.failed || 0}</div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {historyLoading ? (
                    <div className="flex h-full items-center justify-center py-12">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-600 border-t-transparent" />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {historyFiltered.map((h) => {
                        const date = h.sent_at || h.queued_at || h.created_at;
                        const sent = h.status === 'sent';
                        const failed = h.status === 'failed';
                        const processing = h.status === 'processing';
                        return (
                          <div key={h.id} className="rounded-lg border border-gray-200 p-3 hover:bg-gray-50">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-gray-900">{h.driver_name || '-'}</span>
                                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${
                                    sent ? 'bg-green-100 text-green-800' : failed ? 'bg-red-100 text-red-800' : processing ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'
                                  }`}>
                                    {sent ? 'Enviado' : failed ? 'Fallido' : processing ? 'En proceso' : 'Programado'}
                                  </span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                                  <span>{h.phone || '-'}</span>
                                  <span>{date ? new Date(date).toLocaleTimeString('es-PE', { hour: 'numeric', minute: '2-digit' }) : '-'}</span>
                                </div>
                                {h.error && (
                                  <div className="mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                                    {h.error}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {historyFiltered.length === 0 && (
                        <div className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-gray-400">
                          Sin envíos para los filtros actuales
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {historyTotal > HISTORY_PAGE_SIZE && (
                  <footer className="flex justify-center gap-2 border-t px-5 py-3">
                    <button
                      disabled={historyPage <= 1 || historyLoading}
                      onClick={() => loadHistory(historyPage - 1, historyStatus, selectedHistoryDate)}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      Anterior
                    </button>
                    <span className="px-3 py-2 text-sm text-gray-500">Página {historyPage}</span>
                    <button
                      disabled={historyPage * HISTORY_PAGE_SIZE >= historyTotal || historyLoading}
                      onClick={() => loadHistory(historyPage + 1, historyStatus, selectedHistoryDate)}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      Siguiente
                    </button>
                  </footer>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MiautoWhatsApp;
