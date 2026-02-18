import { useState, useEffect, useMemo } from 'react';
import { Plus, X, Edit2, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const PAGE_SIZES = [5, 10, 20, 50];

const CycleConfigSettings = () => {
  const [configs, setConfigs] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<any>(null);
  const [deletingConfig, setDeletingConfig] = useState<any>(null);
  const [interestRates, setInterestRates] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    country: 'PE',
    cycle: '',
    max_credit_line: '',
    interest_rate: '',
    interest_rate_type: '',
    reference_rate_id: '',
    requires_guarantor: false,
    min_guarantor_amount: '',
  });
  const [editFormData, setEditFormData] = useState({
    max_credit_line: '',
    interest_rate: '',
    interest_rate_type: '',
    reference_rate_id: '',
    requires_guarantor: false,
    min_guarantor_amount: '',
    active: true,
  });

  const total = configs.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paginatedConfigs = useMemo(() => {
    const start = (page - 1) * limit;
    return configs.slice(start, start + limit);
  }, [configs, page, limit]);

  useEffect(() => {
    fetchConfigs();
    fetchInterestRates();
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const fetchConfigs = async () => {
    try {
      const response = await api.get('/cycle-config');
      setConfigs(response.data.data);
    } catch (error) {
      console.error('Error fetching configs:', error);
    }
  };

  const fetchInterestRates = async () => {
    try {
      const response = await api.get('/interest-rates/active');
      let ratesData = [];
      if (response.data) {
        if (response.data.success && Array.isArray(response.data.data)) {
          ratesData = response.data.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          ratesData = response.data.data;
        } else if (Array.isArray(response.data)) {
          ratesData = response.data;
        }
      }
      setInterestRates(ratesData);
    } catch (error) {
      console.error('Error fetching interest rates:', error);
    }
  };

  const handleRateChange = (rateId: string) => {
    const selectedRate = interestRates.find((r) => r.id === rateId);
    if (selectedRate) {
      setFormData({
        ...formData,
        reference_rate_id: rateId,
        interest_rate_type: selectedRate.rate_type,
        // No copiar rate_value: la tasa que se aplica al préstamo es solo interest_rate (abajo). La referencia es solo vínculo.
      });
    } else {
      setFormData({ ...formData, reference_rate_id: '', interest_rate_type: '' });
    }
  };

  const handleSubmit = async () => {
    try {
      await api.post('/cycle-config', {
        ...formData,
        max_credit_line: parseFloat(formData.max_credit_line),
        interest_rate: parseFloat(formData.interest_rate),
        reference_rate_id: formData.reference_rate_id || null,
        interest_rate_type: formData.interest_rate_type || null,
        min_guarantor_amount: formData.min_guarantor_amount ? parseFloat(formData.min_guarantor_amount) : null,
      });
      toast.success('Configuración creada correctamente');
      setOpen(false);
      setPage(1);
      fetchConfigs();
      setFormData({
        country: 'PE',
        cycle: '',
        max_credit_line: '',
        interest_rate: '',
        interest_rate_type: '',
        reference_rate_id: '',
        requires_guarantor: false,
        min_guarantor_amount: '',
      });
    } catch (error: any) {
      console.error('Error creating config:', error);
      toast.error(error.response?.data?.message || 'Error al crear la configuración');
    }
  };

  const handleEdit = (config: any) => {
    setEditingConfig(config);
    setEditFormData({
      max_credit_line: config.max_credit_line?.toString() || '',
      interest_rate: config.interest_rate?.toString() || '',
      interest_rate_type: config.interest_rate_type || '',
      reference_rate_id: config.reference_rate_id || '',
      requires_guarantor: config.requires_guarantor || false,
      min_guarantor_amount: config.min_guarantor_amount?.toString() || '',
      active: config.active ?? true,
    });
    setEditOpen(true);
  };

  const handleEditRateChange = (rateId: string) => {
    const selectedRate = interestRates.find((r) => r.id === rateId);
    if (selectedRate) {
      setEditFormData({
        ...editFormData,
        reference_rate_id: rateId,
        interest_rate_type: selectedRate.rate_type,
        // No copiar rate_value: la tasa aplicada al préstamo es solo interest_rate.
      });
    } else {
      setEditFormData({ ...editFormData, reference_rate_id: '', interest_rate_type: '' });
    }
  };

  const handleUpdate = async () => {
    try {
      await api.put(`/cycle-config/${editingConfig.id}`, {
        max_credit_line: parseFloat(editFormData.max_credit_line),
        interest_rate: parseFloat(editFormData.interest_rate),
        reference_rate_id: editFormData.reference_rate_id || null,
        interest_rate_type: editFormData.interest_rate_type || null,
        requires_guarantor: editFormData.requires_guarantor,
        min_guarantor_amount: editFormData.min_guarantor_amount ? parseFloat(editFormData.min_guarantor_amount) : null,
        active: editFormData.active,
      });
      toast.success('Configuración actualizada correctamente');
      setEditOpen(false);
      setEditingConfig(null);
      fetchConfigs();
    } catch (error: any) {
      console.error('Error updating config:', error);
      toast.error(error.response?.data?.message || 'Error al actualizar la configuración');
    }
  };

  const handleDeleteClick = (config: any) => {
    setDeletingConfig(config);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/cycle-config/${deletingConfig.id}`);
      toast.success('Configuración eliminada correctamente');
      setDeleteOpen(false);
      setDeletingConfig(null);
      fetchConfigs();
    } catch (error: any) {
      console.error('Error deleting config:', error);
      toast.error(error.response?.data?.message || 'Error al eliminar la configuración');
    }
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
        <h2 className="text-lg sm:text-xl font-bold text-gray-900">Configuración de Ciclos</h2>
        <button
          onClick={() => setOpen(true)}
          className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 text-sm whitespace-nowrap"
        >
          <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
          Nueva Configuración
        </button>
      </div>

      <div className="bg-white rounded-lg sm:rounded-xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <div className="inline-block min-w-full align-middle">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                <tr>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    País
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Ciclo
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">
                    Línea Máxima
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tasa Interés
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden lg:table-cell">
                    Tasa Referencia
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell">
                    Requiere Fiador
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden lg:table-cell">
                    Monto Mínimo Fiador
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estado
                  </th>
                  <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedConfigs.map((config) => (
                  <tr key={config.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900">
                      {config.country}
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900 font-medium">
                      {config.cycle}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {config.country === 'PE' ? 'S/.' : config.country === 'CO' ? 'COP' : ''} {parseFloat(config.max_credit_line || 0).toFixed(2)}
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900">
                      {config.interest_rate}%
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900 hidden lg:table-cell">
                      {config.reference_rate_type ? (
                        <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
                          {config.reference_rate_type}: {parseFloat(config.reference_rate_value || 0).toFixed(2)}%
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900 hidden md:table-cell">
                      {config.requires_guarantor ? 'Sí' : 'No'}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {config.min_guarantor_amount ? `${config.country === 'PE' ? 'S/.' : config.country === 'CO' ? 'COP' : ''} ${parseFloat(config.min_guarantor_amount).toFixed(2)}` : 'N/A'}
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                      <span
                        className={`px-2 py-1 text-xs font-semibold rounded-full ${
                          config.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {config.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleEdit(config)}
                          className="text-blue-600 hover:text-blue-800 transition-colors p-1.5 hover:bg-blue-50 rounded-lg"
                          title="Editar"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteClick(config)}
                          className="text-red-600 hover:text-red-800 transition-colors p-1.5 hover:bg-red-50 rounded-lg"
                          title="Eliminar"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {total > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Por página:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={page <= 1}
                className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Primera página"
              >
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Página anterior"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum: number;
                    if (totalPages <= 5) pageNum = i + 1;
                    else if (page <= 3) pageNum = i + 1;
                    else if (page >= totalPages - 2) pageNum = totalPages - 4 + i;
                    else pageNum = page - 2 + i;
                    const isActive = page === pageNum;
                    return (
                      <button
                        key={pageNum}
                        type="button"
                        onClick={() => setPage(pageNum)}
                        className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                          isActive ? 'bg-red-600 text-white border-2 border-red-600' : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Página siguiente"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
                className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Última página"
              >
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-100">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-xl font-bold text-white">Nueva Configuración de Ciclo</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
                <select
                  value={formData.country}
                  onChange={(e) => {
                    setFormData({
                      ...formData,
                      country: e.target.value,
                      reference_rate_id: '',
                      interest_rate_type: '',
                    });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="PE">Perú</option>
                  <option value="CO">Colombia</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Ciclo</label>
                <input
                  type="number"
                  value={formData.cycle}
                  onChange={(e) => setFormData({ ...formData, cycle: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Línea de Crédito Máxima</label>
                <input
                  type="number"
                  value={formData.max_credit_line}
                  onChange={(e) => setFormData({ ...formData, max_credit_line: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Vincular a tasa de referencia (opcional)
                </label>
                <select
                  value={formData.reference_rate_id}
                  onChange={(e) => handleRateChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="">Ninguna (solo tasa a cobrar)</option>
                  {interestRates
                    .filter((rate) => rate.country === formData.country && rate.active)
                    .map((rate) => (
                      <option key={rate.id} value={rate.id}>
                        {rate.rate_type} - {parseFloat(rate.rate_value || 0).toFixed(2)}% (Efectiva desde{' '}
                        {rate.effective_date
                          ? new Date(rate.effective_date).toLocaleDateString('es-ES', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })
                          : 'N/A'}
                        )
                      </option>
                    ))}
                </select>
                {formData.reference_rate_id && (
                  <p className="text-xs text-gray-500 mt-1">
                    Referencia vinculada (auditoría). La tasa del cronograma es la de abajo.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Tasa a cobrar (% semanal) — usa el cronograma
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.interest_rate}
                  onChange={(e) => setFormData({ ...formData, interest_rate: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  placeholder="ej. 5.50"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Única tasa que se aplica al préstamo en simulación y cronograma.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Requiere Fiador</label>
                <select
                  value={formData.requires_guarantor.toString()}
                  onChange={(e) => setFormData({ ...formData, requires_guarantor: e.target.value === 'true' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="false">No</option>
                  <option value="true">Sí</option>
                </select>
              </div>

              {formData.requires_guarantor && (
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Monto Mínimo Fiador</label>
                  <input
                    type="number"
                    value={formData.min_guarantor_amount}
                    onChange={(e) => setFormData({ ...formData, min_guarantor_amount: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm"
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de edición */}
      {editOpen && editingConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-100">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-xl font-bold text-white">Editar Configuración de Ciclo</h2>
              <button
                onClick={() => {
                  setEditOpen(false);
                  setEditingConfig(null);
                }}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
                <input
                  type="text"
                  value={editingConfig.country}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600 text-sm cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Ciclo</label>
                <input
                  type="text"
                  value={editingConfig.cycle}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600 text-sm cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Línea de Crédito Máxima</label>
                <input
                  type="number"
                  value={editFormData.max_credit_line}
                  onChange={(e) => setEditFormData({ ...editFormData, max_credit_line: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Vincular a tasa de referencia (opcional)
                </label>
                <select
                  value={editFormData.reference_rate_id}
                  onChange={(e) => handleEditRateChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="">Ninguna (solo tasa a cobrar)</option>
                  {interestRates
                    .filter((rate) => rate.country === editingConfig.country && rate.active)
                    .map((rate) => (
                      <option key={rate.id} value={rate.id}>
                        {rate.rate_type} - {parseFloat(rate.rate_value || 0).toFixed(2)}% (Efectiva desde{' '}
                        {rate.effective_date
                          ? new Date(rate.effective_date).toLocaleDateString('es-ES', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })
                          : 'N/A'}
                        )
                      </option>
                    ))}
                </select>
                {editFormData.reference_rate_id && (
                  <p className="text-xs text-gray-500 mt-1">
                    Referencia vinculada (auditoría). La tasa del cronograma es la de abajo.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Tasa a cobrar (% semanal) — usa el cronograma
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editFormData.interest_rate}
                  onChange={(e) => setEditFormData({ ...editFormData, interest_rate: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  placeholder="ej. 5.50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Requiere Fiador</label>
                <select
                  value={editFormData.requires_guarantor.toString()}
                  onChange={(e) => setEditFormData({ ...editFormData, requires_guarantor: e.target.value === 'true' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="false">No</option>
                  <option value="true">Sí</option>
                </select>
              </div>

              {editFormData.requires_guarantor && (
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Monto Mínimo Fiador</label>
                  <input
                    type="number"
                    value={editFormData.min_guarantor_amount}
                    onChange={(e) => setEditFormData({ ...editFormData, min_guarantor_amount: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Estado</label>
                <select
                  value={editFormData.active.toString()}
                  onChange={(e) => setEditFormData({ ...editFormData, active: e.target.value === 'true' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="true">Activo</option>
                  <option value="false">Inactivo</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => {
                  setEditOpen(false);
                  setEditingConfig(null);
                }}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpdate}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm"
              >
                Actualizar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de confirmación de eliminación */}
      {deleteOpen && deletingConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Confirmar Eliminación</h2>
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletingConfig(null);
                }}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-700 mb-4">
                ¿Estás seguro de que deseas eliminar esta configuración de ciclo?
              </p>
              <div className="bg-gray-50 rounded-lg p-3 mb-4">
                <p className="text-xs font-semibold text-gray-600 mb-1">País:</p>
                <p className="text-sm text-gray-900">{deletingConfig.country}</p>
                <p className="text-xs font-semibold text-gray-600 mb-1 mt-2">Ciclo:</p>
                <p className="text-sm text-gray-900">{deletingConfig.cycle}</p>
                <p className="text-xs font-semibold text-gray-600 mb-1 mt-2">Línea Máxima:</p>
                <p className="text-sm text-gray-900">
                  {deletingConfig.country === 'PE' ? 'S/.' : 'COP'}{' '}
                  {parseFloat(deletingConfig.max_credit_line || 0).toFixed(2)}
                </p>
                <p className="text-xs font-semibold text-gray-600 mb-1 mt-2">Tasa de Interés:</p>
                <p className="text-sm text-gray-900">{deletingConfig.interest_rate}%</p>
              </div>
              <p className="text-xs text-red-600 font-medium">Esta acción no se puede deshacer.</p>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletingConfig(null);
                }}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleDelete}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CycleConfigSettings;




