import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheckSquare, FaEye, FaHistory, FaPaperPlane, FaSearch, FaSquare } from 'react-icons/fa';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
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
import { buildMiMotoMessage } from '../../utils/mimotoWhatsAppMessageBuilder';
import {
  fetchMimotoCronogramas,
  mimotoApiErrorMessage,
  type MimotoCronograma,
  type MimotoDetail,
  type MimotoSolicitud,
  unwrap,
} from './mimotoApi';

type MessageLog = {
  id: string;
  driver_name: string;
  phone: string;
  message: string;
  message_type?: 'text' | 'document';
  media_url?: string | null;
  media_name?: string | null;
  status: string;
  error?: string | null;
  sent_at?: string | null;
  created_at: string;
};

type MessageHistoryResponse = {
  data: MessageLog[];
  total: number;
};

type ProgressItem = {
  id: string;
  name: string;
  phone: string;
  status: 'pending' | 'preparing' | 'sending' | 'queued' | 'failed';
  error?: string;
};

type PreviewItem = {
  id: string;
  name: string;
  phone: string;
  message: string;
  generatedMessage: string;
  error?: string;
};

const PAGE_SIZES = [10, 20, 50, 100];
const HISTORY_PAGE_SIZE = 50;

function safeName(row: MimotoSolicitud) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Conductor';
}

function hasValidPhone(phone?: string | null) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 12;
}

function progressLabel(status: ProgressItem['status']) {
  if (status === 'preparing') return 'Preparando';
  if (status === 'sending') return 'Programando';
  if (status === 'queued') return 'Programado';
  if (status === 'failed') return 'Fallido';
  return 'Pendiente';
}

function historyStatusLabel(status: string) {
  if (status === 'sent') return 'Enviado';
  if (status === 'failed') return 'Fallido';
  if (status === 'processing') return 'En proceso';
  return 'Programado';
}

function historyStatusClass(status: string) {
  if (status === 'sent') return 'bg-green-100 text-green-800';
  if (status === 'failed') return 'bg-red-100 text-red-800';
  if (status === 'processing') return 'bg-blue-100 text-blue-800';
  return 'bg-gray-100 text-gray-700';
}

function formatPreviewMessage(item: PreviewItem) {
  if (item.error) return `-- ${item.name} (${item.phone || 'sin teléfono'}) --\nNo se pudo generar el mensaje: ${item.error}`;
  return `-- ${item.name} (${item.phone || 'sin teléfono'}) --\n${item.message}`;
}

export default function YegoMiMotoMessages() {
  const [solicitudes, setSolicitudes] = useState<MimotoSolicitud[]>([]);
  const [cronogramas, setCronogramas] = useState<MimotoCronograma[]>([]);
  const [cronogramaId, setCronogramaId] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [messageOverrides, setMessageOverrides] = useState<Record<string, string>>({});
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<MessageLog[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyStatus, setHistoryStatus] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const loadedRef = useRef(false);

  const loadSolicitudes = useCallback(async () => {
    setLoading(true);
    try {
      const rows = unwrap<MimotoSolicitud[]>(await api.get('/mimoto/message-recipients')) || [];
      const availableIds = new Set(rows.map((row) => row.id));
      setSolicitudes(rows);
      setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
      setMessageOverrides((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => availableIds.has(id))
      ));
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudieron cargar los conductores'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCronogramas = useCallback(async () => {
    try {
      setCronogramas(await fetchMimotoCronogramas());
    } catch {
      setCronogramas([]);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadSolicitudes();
    void loadCronogramas();
  }, [loadCronogramas, loadSolicitudes]);

  useEffect(() => setPage(1), [cronogramaId, pageSize, search]);

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-CO');
    return solicitudes.filter((row) => {
      if (cronogramaId && row.cronograma_id !== cronogramaId) return false;
      if (!term) return true;
      return [safeName(row), row.phone, row.cronograma_name, row.vehiculo_name, row.document_number, row.placa_asignada]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es-CO')
        .includes(term);
    });
  }, [cronogramaId, search, solicitudes]);

  const eligibleFiltered = useMemo(() => filtered.filter((row) => hasValidPhone(row.phone)), [filtered]);
  const selectedRows = useMemo(() => solicitudes.filter((row) => selectedIds.has(row.id)), [selectedIds, solicitudes]);
  const selectedEligible = useMemo(() => selectedRows.filter((row) => hasValidPhone(row.phone)), [selectedRows]);
  const invalidSelectedCount = selectedRows.length - selectedEligible.length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const allFilteredSelected = eligibleFiltered.length > 0 && eligibleFiltered.every((row) => selectedIds.has(row.id));
  const previewMatchesSelection = previewItems.length > 0
    && previewItems.length === selectedEligible.length
    && previewItems.every((item) => selectedIds.has(item.id));
  const editedPreviewCount = previewItems.filter((item) => !item.error && item.message !== item.generatedMessage).length;
  const selectedCronograma = cronogramas.find((item) => item.id === cronogramaId)?.name || '';

  const progressStats = useMemo(() => {
    const queued = progressItems.filter((item) => item.status === 'queued').length;
    const failed = progressItems.filter((item) => item.status === 'failed').length;
    const done = queued + failed;
    return {
      queued,
      failed,
      done,
      total: progressItems.length,
      percent: progressItems.length ? Math.round((done / progressItems.length) * 100) : 0,
    };
  }, [progressItems]);

  const filteredHistory = useMemo(() => {
    const term = historySearch.trim().toLocaleLowerCase('es-CO');
    if (!term) return history;
    return history.filter((item) => [item.driver_name, item.phone, item.message, item.error, item.media_name]
      .filter(Boolean).join(' ').toLocaleLowerCase('es-CO').includes(term));
  }, [history, historySearch]);

  const historyStats = useMemo(() => ({
    sent: history.filter((item) => item.status === 'sent').length,
    failed: history.filter((item) => item.status === 'failed').length,
  }), [history]);

  function toggleOne(row: MimotoSolicitud) {
    if (!hasValidPhone(row.phone)) return toast.error('Este conductor no tiene teléfono válido');
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((current) => {
      const next = new Set(current);
      eligibleFiltered.forEach((row) => allFilteredSelected ? next.delete(row.id) : next.add(row.id));
      return next;
    });
  }

  async function buildPreview(row: MimotoSolicitud) {
    const detail = unwrap<MimotoDetail>(await api.get(`/mimoto/solicitudes/${row.id}`));
    return buildMiMotoMessage(detail);
  }

  async function openPreview(row?: MimotoSolicitud) {
    const targets = row ? [row] : selectedEligible;
    if (targets.length === 0) {
      toast.error('Selecciona al menos un conductor con teléfono válido');
      return;
    }
    setPreviewItems([]);
    setActivePreviewIndex(0);
    setShowPreview(true);
    setPreviewLoading(true);
    const items: PreviewItem[] = [];
    for (const target of targets) {
      try {
        const generatedMessage = await buildPreview(target);
        items.push({
          id: target.id,
          name: safeName(target),
          phone: target.phone,
          generatedMessage,
          message: messageOverrides[target.id] ?? generatedMessage,
        });
      } catch (error: unknown) {
        items.push({
          id: target.id,
          name: safeName(target),
          phone: target.phone,
          generatedMessage: '',
          message: '',
          error: mimotoApiErrorMessage(error, 'No se pudo generar el mensaje'),
        });
      }
    }
    setPreviewItems(items);
    setPreviewLoading(false);
  }

  function updatePreviewMessage(id: string, message: string) {
    setPreviewItems((current) => current.map((item) => item.id === id ? { ...item, message } : item));
    setMessageOverrides((current) => ({ ...current, [id]: message }));
  }

  function resetPreviewMessage(item: PreviewItem) {
    setPreviewItems((current) => current.map((entry) => entry.id === item.id
      ? { ...entry, message: entry.generatedMessage }
      : entry));
    setMessageOverrides((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
  }

  async function copyText(value: string, label: string) {
    if (!value.trim()) return;
    await navigator.clipboard.writeText(value);
    toast.success(label);
  }

  function updateProgress(id: string, patch: Partial<ProgressItem>) {
    setProgressItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function executeSend() {
    if (selectedEligible.length === 0) return toast.error('Selecciona al menos un conductor con teléfono válido');
    setShowSendConfirm(false);
    setShowProgress(true);
    setSending(true);
    setProgressItems(selectedEligible.map((row) => ({
      id: row.id,
      name: safeName(row),
      phone: row.phone,
      status: 'pending',
    })));
    const queuedIds: string[] = [];
    for (const row of selectedEligible) {
      try {
        updateProgress(row.id, { status: 'preparing' });
        const message = messageOverrides[row.id] ?? await buildPreview(row);
        if (!message.trim()) throw new Error('El mensaje está vacío');
        updateProgress(row.id, { status: 'sending' });
        await api.post(`/mimoto/solicitudes/${row.id}/mensajes`, { message: message.trim() });
        queuedIds.push(row.id);
        updateProgress(row.id, { status: 'queued' });
      } catch (error: unknown) {
        updateProgress(row.id, { status: 'failed', error: mimotoApiErrorMessage(error, 'No se pudo programar') });
      }
    }
    setSending(false);
    if (queuedIds.length > 0) {
      setSelectedIds((current) => new Set([...current].filter((id) => !queuedIds.includes(id))));
      setMessageOverrides((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !queuedIds.includes(id))
      ));
      toast.success(`Programados: ${queuedIds.length}. Se enviarán máximo 3 cada 2 minutos.`);
    }
    if (queuedIds.length < selectedEligible.length) {
      toast.error(`No programados: ${selectedEligible.length - queuedIds.length}`);
    }
  }

  const loadHistory = useCallback(async (pageToLoad = 1, statusToLoad = historyStatus) => {
    try {
      const response = unwrap<MessageHistoryResponse>(await api.get('/mimoto/mensajes', {
        params: { page: pageToLoad, limit: HISTORY_PAGE_SIZE, ...(statusToLoad ? { status: statusToLoad } : {}) },
      }));
      setHistory(response?.data || []);
      setHistoryTotal(response?.total || 0);
      setHistoryPage(pageToLoad);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo cargar el historial'));
    }
  }, [historyStatus]);

  function openHistory() {
    setShowHistory(true);
    void loadHistory(1);
  }

  const selectClass = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm bg-white';
  const iconButtonClass = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="space-y-4 lg:space-y-5">
      <header className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6B1515]">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight text-white lg:text-xl">Mensajes WhatsApp</h1>
              <p className="mt-0.5 text-xs text-white/90 lg:text-sm">Yego Mi Moto</p>
            </div>
          </div>
          <button type="button" onClick={() => void loadSolicitudes()} disabled={loading || sending} className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <SummaryCard icon={Users} label="Cargados" value={solicitudes.length} />
        <SummaryCard icon={Filter} label="Filtrados" value={filtered.length} />
        <SummaryCard icon={Phone} label="Con teléfono" value={eligibleFiltered.length} />
        <SummaryCard icon={CheckCircle2} label="Seleccionados" value={selectedEligible.length} accent />
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
          <div>
            <label htmlFor="mimoto-cronograma-filter" className="mb-1.5 block text-xs font-semibold text-gray-900">Cronograma</label>
            <select id="mimoto-cronograma-filter" value={cronogramaId} onChange={(event) => setCronogramaId(event.target.value)} className={selectClass}>
              <option value="">Todos los cronogramas</option>
              {cronogramas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mimoto-message-search" className="mb-1.5 block text-xs font-semibold text-gray-900">Buscar</label>
            <div className="relative">
              <FaSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input id="mimoto-message-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre, teléfono, documento, cronograma o moto" className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500" />
            </div>
          </div>
        </div>
        {(search || cronogramaId) && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
          {cronogramaId && <span className="rounded bg-red-50 px-2 py-1 text-[#8B1A1A]">Cronograma: {selectedCronograma}</span>}
          {search && <span className="rounded bg-gray-100 px-2 py-1 text-gray-700">Búsqueda: {search}</span>}
          <button type="button" onClick={() => { setSearch(''); setCronogramaId(''); }} className="px-2 py-1 hover:text-gray-900">Limpiar filtros</button>
        </div>}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <button type="button" onClick={toggleAll} disabled={eligibleFiltered.length === 0 || sending} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50">
          {allFilteredSelected ? <FaCheckSquare /> : <FaSquare className="text-gray-300" />}
          {allFilteredSelected ? 'Deseleccionar filtrados' : 'Seleccionar filtrados'} ({eligibleFiltered.length})
        </button>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openPreview()} disabled={selectedEligible.length === 0 || previewLoading || sending} className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50">
            <FaEye className="h-4 w-4" />
            {previewLoading ? 'Generando...' : selectedEligible.length > 1 ? `Revisar seleccionados (${selectedEligible.length})` : 'Revisar mensaje'}
          </button>
          <button type="button" onClick={openHistory} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100">
            <FaHistory className="h-4 w-4" /> Historial
          </button>
          <button type="button" onClick={() => setShowSendConfirm(true)} disabled={selectedEligible.length === 0 || sending} className="inline-flex items-center gap-2 rounded-lg bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0f766b] disabled:opacity-50">
            <FaPaperPlane className="h-4 w-4" /> Enviar ({selectedEligible.length})
          </button>
        </div>
      </section>

      {loading ? <Loading /> : filtered.length === 0 ? <Empty /> : <DriverTable rows={visibleRows} selectedIds={selectedIds} previewLoading={previewLoading} onToggle={toggleOne} onPreview={openPreview} />}

      {!loading && totalPages > 1 && <Pagination page={currentPage} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES} onPage={setPage} onPageSize={setPageSize} buttonClass={iconButtonClass} />}

      {showPreview && <PreviewModal
        items={previewItems}
        activeIndex={activePreviewIndex}
        loading={previewLoading}
        editedCount={editedPreviewCount}
        matchesSelection={previewMatchesSelection}
        iconButtonClass={iconButtonClass}
        onActiveIndex={setActivePreviewIndex}
        onChange={updatePreviewMessage}
        onReset={resetPreviewMessage}
        onClose={() => setShowPreview(false)}
        onCopy={(value, label) => void copyText(value, label)}
        onContinue={() => {
          if (previewItems.some((item) => item.error || !item.message.trim())) return toast.error('Corrige los mensajes vacíos o con error');
          setShowPreview(false);
          setShowSendConfirm(true);
        }}
      />}

      {showSendConfirm && <SendConfirmation rows={selectedEligible} invalidCount={invalidSelectedCount} sending={sending} hasEdits={Object.keys(messageOverrides).some((id) => selectedIds.has(id))} iconButtonClass={iconButtonClass} onClose={() => setShowSendConfirm(false)} onConfirm={() => void executeSend()} />}
      {showProgress && <ProgressModal items={progressItems} stats={progressStats} sending={sending} iconButtonClass={iconButtonClass} onClose={() => setShowProgress(false)} />}
      {showHistory && <HistoryModal
        logs={filteredHistory}
        pageCount={history.length}
        total={historyTotal}
        page={historyPage}
        status={historyStatus}
        search={historySearch}
        stats={historyStats}
        iconButtonClass={iconButtonClass}
        onStatus={(value) => { setHistoryStatus(value); void loadHistory(1, value); }}
        onSearch={setHistorySearch}
        onPage={(value) => void loadHistory(value)}
        onRefresh={() => void loadHistory(historyPage)}
        onClose={() => setShowHistory(false)}
      />}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, accent = false }: { icon: typeof Users; label: string; value: number; accent?: boolean }) {
  return <div className="rounded-lg border border-gray-200 bg-white p-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase text-gray-500"><Icon className="h-4 w-4" />{label}</div><div className={`mt-2 text-2xl font-bold ${accent ? 'text-[#8B1A1A]' : 'text-gray-900'}`}>{value.toLocaleString('es-CO')}</div></div>;
}

function Loading() {
  return <div className="flex justify-center py-12"><div className="h-10 w-10 animate-spin rounded-full border-2 border-red-600 border-t-transparent" /></div>;
}

function Empty() {
  return <div className="rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm"><MessageCircle className="mx-auto mb-4 h-10 w-10 text-gray-400" /><h3 className="text-lg font-bold text-gray-900">Sin resultados</h3><p className="mt-1 text-sm text-gray-600">No hay registros activos de Alquiler / Venta para los filtros actuales.</p></div>;
}

function DriverTable({ rows, selectedIds, previewLoading, onToggle, onPreview }: { rows: MimotoSolicitud[]; selectedIds: Set<string>; previewLoading: boolean; onToggle: (row: MimotoSolicitud) => void; onPreview: (row: MimotoSolicitud) => Promise<void> }) {
  return <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm"><table className="w-full"><thead className="border-b border-gray-200 bg-gray-50"><tr><th className="w-12 px-4 py-3" /><th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Conductor</th><th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Cronograma</th><th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Teléfono</th><th className="w-32 px-4 py-3 text-right text-xs font-semibold uppercase text-gray-700">Acción</th></tr></thead><tbody className="divide-y divide-gray-200">{rows.map((row) => {
    const validPhone = hasValidPhone(row.phone);
    const selected = selectedIds.has(row.id);
    return <tr key={row.id} className={`hover:bg-gray-50 ${validPhone ? '' : 'bg-amber-50/35'}`}><td className="px-4 py-3"><button type="button" onClick={() => onToggle(row)} className="inline-flex text-lg" title={validPhone ? 'Seleccionar' : 'Teléfono inválido'}>{selected ? <FaCheckSquare className="text-[#8B1A1A]" /> : <FaSquare className={validPhone ? 'text-gray-300' : 'text-amber-300'} />}</button></td><td className="px-4 py-3"><div className="text-sm font-semibold text-gray-900">{safeName(row)}</div><div className="text-xs text-gray-500">{row.vehiculo_name || `${row.document_type} ${row.document_number}`}</div></td><td className="px-4 py-3 text-sm text-gray-600">{row.cronograma_name || '-'}</td><td className={`px-4 py-3 text-sm ${validPhone ? 'text-gray-700' : 'font-medium text-amber-700'}`}>{row.phone || 'Sin teléfono'}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => void onPreview(row)} disabled={!validPhone || previewLoading} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50"><FaEye className="h-4 w-4" />Ver mensaje</button></td></tr>;
  })}</tbody></table></div>;
}

function Pagination({ page, totalPages, pageSize, pageSizes, onPage, onPageSize, buttonClass }: { page: number; totalPages: number; pageSize: number; pageSizes: number[]; onPage: (page: number) => void; onPageSize: (size: number) => void; buttonClass: string }) {
  return <section className="flex flex-col items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-4 sm:flex-row"><div className="flex items-center gap-2"><span className="text-sm font-medium text-gray-600">Por página:</span><select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700">{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></div><div className="flex items-center gap-1.5"><button disabled={page <= 1} onClick={() => onPage(1)} className={buttonClass}>«</button><button disabled={page <= 1} onClick={() => onPage(page - 1)} className={buttonClass}>‹</button><span className="px-3 py-2 text-sm text-gray-600">Página {page} de {totalPages}</span><button disabled={page >= totalPages} onClick={() => onPage(page + 1)} className={buttonClass}>›</button><button disabled={page >= totalPages} onClick={() => onPage(totalPages)} className={buttonClass}>»</button></div></section>;
}

type PreviewModalProps = {
  items: PreviewItem[]; activeIndex: number; loading: boolean; editedCount: number; matchesSelection: boolean; iconButtonClass: string;
  onActiveIndex: (index: number) => void; onChange: (id: string, value: string) => void; onReset: (item: PreviewItem) => void; onClose: () => void; onCopy: (value: string, label: string) => void; onContinue: () => void;
};

function PreviewModal(props: PreviewModalProps) {
  const active = props.items[props.activeIndex] || null;
  const multiple = props.items.length > 1;
  const single = !multiple;
  const readyCount = props.items.filter((item) => !item.error).length;
  const errorCount = props.items.length - readyCount;
  const allMessages = props.items.map(formatPreviewMessage).join('\n\n');
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}><div className={`${single ? 'max-w-2xl' : 'max-w-5xl'} flex max-h-[min(92vh,760px)] w-full flex-col rounded-lg bg-white shadow-xl`} onClick={(event) => event.stopPropagation()}><header className="flex items-center justify-between border-b px-5 py-3"><div><div className="flex items-center gap-2"><h2 className="text-lg font-bold text-gray-900">{single ? 'Mensaje del conductor' : 'Vista previa'}</h2>{!props.loading && readyCount > 0 && <span className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-600"><PencilLine className="h-3 w-3" />Editable</span>}</div><p className="text-xs text-gray-500">{props.loading ? 'Generando mensaje...' : single ? `${active?.name || 'Conductor'}${active?.phone ? ` · ${active.phone}` : ''}` : `${readyCount} listo(s)${errorCount ? `, ${errorCount} con error` : ''}`}</p></div><div className="flex items-center gap-2">{multiple && <button type="button" onClick={() => active && props.onCopy(active.message, `Mensaje de ${active.name} copiado`)} disabled={!active || !!active.error} className={props.iconButtonClass} title="Copiar mensaje"><Copy className="h-4 w-4" /></button>}<button type="button" onClick={() => props.onCopy(single ? active?.message || '' : allMessages, single ? 'Mensaje copiado' : 'Mensajes copiados')} disabled={single ? !active || !!active.error : !allMessages.trim()} className={props.iconButtonClass} title={single ? 'Copiar mensaje' : 'Copiar todos'}><Copy className="h-4 w-4" /></button><button type="button" onClick={props.onClose} className={props.iconButtonClass} title="Cerrar"><X className="h-4 w-4" /></button></div></header><div className="flex-1 overflow-hidden p-5">{props.loading ? <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-2 border-red-600 border-t-transparent" /></div> : <div className={`${single ? 'block' : 'grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]'} h-full min-h-[420px]`}>{multiple && <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200"><div className="border-b bg-gray-50 px-3 py-2"><div className="text-xs font-semibold uppercase text-gray-600">Conductores</div><div className="mt-0.5 text-xs text-gray-500">{readyCount} listos · {errorCount} errores</div></div><div className="divide-y divide-gray-100 overflow-y-auto">{props.items.map((item, index) => <button key={item.id} type="button" onClick={() => props.onActiveIndex(index)} className={`w-full px-3 py-3 text-left hover:bg-gray-50 ${props.activeIndex === index ? 'bg-red-50' : 'bg-white'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-sm font-semibold text-gray-900">{item.name}</div><div className="truncate text-xs text-gray-500">{item.phone || 'Sin teléfono'}</div></div>{item.error ? <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />}</div></button>)}</div></aside>}<section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200"><div className="flex flex-col gap-2 border-b bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0">{multiple && <div className="mb-0.5 text-xs font-semibold text-[#8B1A1A]">Mensaje {props.activeIndex + 1} de {props.items.length}</div>}<div className="truncate text-sm font-bold text-gray-900">{active?.name || 'Sin mensaje'}</div><div className="truncate text-xs text-gray-500">{active?.phone || '-'}</div></div>{multiple && <div className="flex gap-2"><button type="button" onClick={() => props.onActiveIndex(Math.max(0, props.activeIndex - 1))} disabled={props.activeIndex <= 0} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">Anterior</button><button type="button" onClick={() => props.onActiveIndex(Math.min(props.items.length - 1, props.activeIndex + 1))} disabled={props.activeIndex >= props.items.length - 1} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">Siguiente</button></div>}</div><div className="flex-1 overflow-y-auto bg-white p-4">{active?.error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">No se pudo generar este mensaje: {active.error}</div> : <div className="space-y-2"><textarea value={active?.message || ''} onChange={(event) => active && props.onChange(active.id, event.target.value)} className="min-h-[320px] w-full resize-y rounded-lg border border-gray-300 bg-white p-4 text-sm leading-relaxed text-gray-800 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100" /><div className="flex items-center justify-between gap-3 text-xs text-gray-500"><span>{active?.message.length || 0} caracteres</span>{active && active.message !== active.generatedMessage && <button type="button" onClick={() => props.onReset(active)} className="font-semibold text-[#8B1A1A] hover:underline">Restaurar mensaje generado</button>}</div></div>}</div></section></div>}</div>{!props.loading && props.matchesSelection && <footer className="flex flex-col gap-2 border-t bg-gray-50 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"><span className="text-xs text-gray-600">{props.editedCount ? `${props.editedCount} mensaje(s) editado(s); se enviarán con estos cambios.` : 'Los mensajes están listos para enviar.'}</span><button type="button" onClick={props.onContinue} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0f766b]"><FaPaperPlane className="h-4 w-4" />Continuar al envío</button></footer>}</div></div>;
}

function SendConfirmation({ rows, invalidCount, sending, hasEdits, iconButtonClass, onClose, onConfirm }: { rows: MimotoSolicitud[]; invalidCount: number; sending: boolean; hasEdits: boolean; iconButtonClass: string; onClose: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !sending && onClose()}><div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-xl" onClick={(event) => event.stopPropagation()}><header className="flex items-start justify-between gap-3 border-b px-5 py-4"><div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#128C7E]/10"><MessageCircle className="h-5 w-5 text-[#128C7E]" /></div><div><h2 className="text-lg font-bold text-gray-900">Confirmar envío</h2><p className="mt-0.5 text-sm text-gray-600">Se programará WhatsApp para {rows.length} conductor(es), con un máximo de 3 mensajes cada 2 minutos.{hasEdits ? ' Se respetarán los mensajes editados.' : ''}</p></div></div><button type="button" onClick={onClose} disabled={sending} className={iconButtonClass}><X className="h-4 w-4" /></button></header><div className="space-y-4 p-5"><div className="grid grid-cols-2 gap-3"><div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3"><div className="text-xs font-semibold uppercase text-green-700">Listos</div><div className="text-2xl font-bold text-green-800">{rows.length}</div></div><div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"><div className="text-xs font-semibold uppercase text-amber-700">Omitidos</div><div className="text-2xl font-bold text-amber-800">{invalidCount}</div></div></div><div className="overflow-hidden rounded-lg border border-gray-200"><div className="border-b bg-gray-50 px-3 py-2 text-xs font-semibold uppercase text-gray-600">Conductores a enviar</div><div className="max-h-56 divide-y divide-gray-100 overflow-y-auto">{rows.slice(0, 12).map((row) => <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2"><div className="min-w-0"><div className="truncate text-sm font-semibold text-gray-900">{safeName(row)}</div><div className="truncate text-xs text-gray-500">{row.cronograma_name || row.vehiculo_name || 'Sin cronograma'}</div></div><div className="shrink-0 text-xs text-gray-500">{row.phone}</div></div>)}{rows.length > 12 && <div className="bg-gray-50 px-3 py-2 text-xs text-gray-500">Y {rows.length - 12} conductor(es) más...</div>}</div></div></div><footer className="flex flex-col-reverse gap-2 border-t bg-gray-50 px-5 py-4 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} disabled={sending} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancelar</button><button type="button" onClick={onConfirm} disabled={sending || rows.length === 0} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0f766b] disabled:opacity-50"><FaPaperPlane className="h-4 w-4" />{sending ? 'Programando...' : `Programar ${rows.length}`}</button></footer></div></div>;
}

function ProgressModal({ items, stats, sending, iconButtonClass, onClose }: { items: ProgressItem[]; stats: { queued: number; failed: number; done: number; total: number; percent: number }; sending: boolean; iconButtonClass: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-lg rounded-lg bg-white shadow-xl"><header className="flex items-center justify-between border-b px-5 py-3"><div><h2 className="text-lg font-bold text-gray-900">Envío de WhatsApp</h2><p className="text-xs text-gray-500">Límite automático: 3 mensajes cada 2 minutos</p></div>{!sending && <button type="button" onClick={onClose} className={iconButtonClass}><X className="h-4 w-4" /></button>}</header><div className="space-y-4 p-5"><div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg border border-gray-200 p-3"><div className="text-xl font-bold text-gray-900">{stats.total}</div><div className="text-xs text-gray-500">Total</div></div><div className="rounded-lg border border-blue-200 bg-blue-50 p-3"><div className="text-xl font-bold text-blue-700">{stats.queued}</div><div className="text-xs text-blue-700">Programados</div></div><div className="rounded-lg border border-red-200 bg-red-50 p-3"><div className="text-xl font-bold text-red-700">{stats.failed}</div><div className="text-xs text-red-700">Fallidos</div></div></div><div><div className="h-2.5 w-full rounded-full bg-gray-200"><div className="h-2.5 rounded-full bg-[#128C7E] transition-all" style={{ width: `${stats.percent}%` }} /></div><p className="mt-2 text-center text-sm text-gray-600">{stats.done} de {stats.total} programados o revisados</p></div><ul className="max-h-72 space-y-1.5 overflow-y-auto">{items.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 rounded border border-gray-100 px-2 py-2 text-sm"><div className="min-w-0"><div className="truncate font-medium text-gray-800">{item.name}</div><div className="truncate text-xs text-gray-500">{item.phone}</div></div><div className="flex shrink-0 items-center gap-2 text-xs">{item.status === 'pending' && <Clock className="h-4 w-4 text-gray-400" />}{['preparing', 'sending'].includes(item.status) && <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#128C7E] border-t-transparent" />}{item.status === 'queued' && <Clock className="h-4 w-4 text-blue-600" />}{item.status === 'failed' && <AlertTriangle className="h-4 w-4 text-red-600" />}<span className={item.status === 'failed' ? 'max-w-[160px] truncate text-red-700' : 'text-gray-600'}>{item.status === 'failed' ? item.error || 'Fallido' : progressLabel(item.status)}</span></div></li>)}</ul></div></div></div>;
}

type HistoryModalProps = { logs: MessageLog[]; pageCount: number; total: number; page: number; status: string; search: string; stats: { sent: number; failed: number }; iconButtonClass: string; onStatus: (value: string) => void; onSearch: (value: string) => void; onPage: (page: number) => void; onRefresh: () => void; onClose: () => void };

function HistoryModal(props: HistoryModalProps) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}><div className="flex max-h-[min(90vh,720px)] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(event) => event.stopPropagation()}><header className="space-y-3 border-b bg-white px-5 py-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-bold text-gray-900">Historial de envíos</h2><p className="text-xs text-gray-500">Mostrando {props.logs.length} de {props.pageCount} en esta página. Total histórico: {props.total.toLocaleString('es-CO')}</p></div><div className="flex gap-2"><button type="button" onClick={props.onRefresh} className={props.iconButtonClass} title="Actualizar historial"><RefreshCw className="h-4 w-4" /></button><button type="button" onClick={props.onClose} className={props.iconButtonClass} title="Cerrar"><X className="h-4 w-4" /></button></div></div><div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_170px_170px_170px]"><div className="relative"><FaSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Buscar conductor, teléfono, mensaje o archivo" className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500" /></div><select value={props.status} onChange={(event) => props.onStatus(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"><option value="">Todos</option><option value="pending">Programados</option><option value="processing">En proceso</option><option value="sent">Enviados</option><option value="failed">Fallidos</option></select><div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2"><div className="text-xs text-green-700">En esta página</div><div className="text-sm font-bold text-green-800">{props.stats.sent} enviados</div></div><div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2"><div className="text-xs text-red-700">En esta página</div><div className="text-sm font-bold text-red-800">{props.stats.failed} fallidos</div></div></div></header><div className="overflow-y-auto p-5"><div className="space-y-2">{props.logs.map((item) => <article key={item.id} className="rounded-lg border border-gray-200 p-3 hover:bg-gray-50"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-gray-900">{item.driver_name || '-'}</span><span className={`rounded px-2 py-0.5 text-xs font-semibold ${historyStatusClass(item.status)}`}>{historyStatusLabel(item.status)}</span>{item.message_type === 'document' && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">Documento</span>}</div><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"><span>{item.phone || '-'}</span><span>{new Date(item.sent_at || item.created_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</span></div>{item.media_url && <a href={item.media_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-md items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-[#8B1A1A]"><FileText className="h-4 w-4 shrink-0" /><span className="truncate">{item.media_name || 'Comprobante adjunto'}</span></a>}<details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-gray-600">Ver mensaje</summary><p className="mt-2 whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-700">{item.message}</p></details>{item.error && <div className="mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{item.error}</div>}</div></div></article>)}{props.logs.length === 0 && <div className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-gray-400">Sin envíos para los filtros actuales</div>}</div></div>{props.total > HISTORY_PAGE_SIZE && <footer className="flex justify-center gap-2 border-t px-5 py-3"><button disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">Anterior</button><span className="px-3 py-2 text-sm text-gray-500">Página {props.page}</span><button disabled={props.page * HISTORY_PAGE_SIZE >= props.total} onClick={() => props.onPage(props.page + 1)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">Siguiente</button></footer>}</div></div>;
}
