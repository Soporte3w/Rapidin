import { useState, useEffect, useMemo } from 'react';
import { Plus, X, Edit2, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import api from '../../../services/api';
import toast from 'react-hot-toast';

const PAGE_SIZES = [5, 10, 20, 50];

const InterestRatesSettings = () => {
  const [rates, setRates] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingRate, setEditingRate] = useState<any>(null);
  const [deletingRate, setDeletingRate] = useState<any>(null);
  const [formData, setFormData] = useState({
    country: 'PE',
    rate_type: 'TEA',
    rate_value: '',
    effective_date: new Date().toISOString().split('T')[0],
  });
  const [editFormData, setEditFormData] = useState({
    rate_value: '',
    effective_date: '',
    active: true,
  });

  const total = rates.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paginatedRates = useMemo(() => {
    const start = (page - 1) * limit;
    return rates.slice(start, start + limit);
  }, [rates, page, limit]);

  useEffect(() => {
    fetchRates();
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const fetchRates = async () => {
    try {
      const response = await api.get('/interest-rates');
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
      setRates(ratesData);
    } catch (error: any) {
      console.error('Error fetching rates:', error);
      setRates([]);
    }
  };

  const handleSubmit = async () => {
    try {
      if (!formData.rate_value) {
        toast.error('Por favor ingresa el valor de la tasa');
        return;
      }
      await api.post('/interest-rates', {
        ...formData,
        rate_value: parseFloat(formData.rate_value),
      });
      toast.success('Tasa creada correctamente');
      setOpen(false);
      setPage(1);
      fetchRates();
      setFormData({
        country: 'PE',
        rate_type: 'TEA',
        rate_value: '',
        effective_date: new Date().toISOString().split('T')[0],
      });
    } catch (error: any) {
      console.error('Error creating rate:', error);
      toast.error(error.response?.data?.message || 'Error al crear la tasa');
    }
  };

  const handleEdit = (rate: any) => {
    setEditingRate(rate);
    setEditFormData({
      rate_value: rate.rate_value?.toString() || '',
      effective_date: rate.effective_date ? rate.effective_date.split('T')[0] : '',
      active: rate.active ?? true,
    });
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    try {
      if (!editFormData.rate_value) {
        toast.error('Por favor ingresa el valor de la tasa');
        return;
      }
      await api.put(`/interest-rates/${editingRate.id}`, {
        rate_value: parseFloat(editFormData.rate_value),
        effective_date: editFormData.effective_date,
        active: editFormData.active,
      });
      toast.success('Tasa actualizada correctamente');
      setEditOpen(false);
      setEditingRate(null);
      fetchRates();
    } catch (error: any) {
      console.error('Error updating rate:', error);
      toast.error(error.response?.data?.message || 'Error al actualizar la tasa');
    }
  };

  const handleDeleteClick = (rate: any) => {
    setDeletingRate(rate);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/interest-rates/${deletingRate.id}`);
      toast.success('Tasa eliminada correctamente');
      setDeleteOpen(false);
      setDeletingRate(null);
      fetchRates();
    } catch (error: any) {
      console.error('Error deleting rate:', error);
      toast.error(error.response?.data?.message || 'Error al eliminar la tasa');
    }
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
        <h2 className="text-lg sm:text-xl font-bold text-gray-900">Tasas de Interés</h2>
        <button
          onClick={() => setOpen(true)}
          className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 text-sm whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          Nueva Tasa
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  País
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Tipo de Tasa
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Valor (%)
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Fecha Efectiva
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedRates.map((rate) => (
                <tr key={rate.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {rate.country}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {rate.rate_type}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {parseFloat(rate.rate_value || 0).toFixed(2)}%
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {rate.effective_date ? new Date(rate.effective_date).toLocaleDateString('es-ES', { 
                      year: 'numeric', 
                      month: 'short', 
                      day: 'numeric' 
                    }) : 'N/A'}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span
                      className={`px-3 py-1 text-xs font-medium rounded-full ${
                        rate.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {rate.active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleEdit(rate)}
                        className="text-blue-600 hover:text-blue-800 transition-colors p-1.5 hover:bg-blue-50 rounded-lg"
                        title="Editar"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteClick(rate)}
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

      {/* Modal de creación */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Nueva Tasa de Interés</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  País
                </label>
                <select
                  id="country"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="PE">Perú</option>
                  <option value="CO">Colombia</option>
                </select>
              </div>

              <div>
                <label htmlFor="rate_type" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Tipo de Tasa
                </label>
                <select
                  id="rate_type"
                  value={formData.rate_type}
                  onChange={(e) => setFormData({ ...formData, rate_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="TEA">TEA (Tasa Efectiva Anual)</option>
                  <option value="TES">TES (Tasa Efectiva Semanal)</option>
                  <option value="TED">TED (Tasa Efectiva Diaria)</option>
                </select>
              </div>

              <div>
                <label htmlFor="rate_value" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Valor de la Tasa (%)
                </label>
                <input
                  id="rate_value"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.rate_value}
                  onChange={(e) => setFormData({ ...formData, rate_value: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label htmlFor="effective_date" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Fecha Efectiva
                </label>
                <input
                  id="effective_date"
                  type="date"
                  value={formData.effective_date}
                  onChange={(e) => setFormData({ ...formData, effective_date: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all font-medium text-sm"
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
      {editOpen && editingRate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Editar Tasa de Interés</h2>
              <button
                onClick={() => {
                  setEditOpen(false);
                  setEditingRate(null);
                }}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  País
                </label>
                <input
                  type="text"
                  value={editingRate.country}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600 text-sm cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Tipo de Tasa
                </label>
                <input
                  type="text"
                  value={editingRate.rate_type}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600 text-sm cursor-not-allowed"
                />
              </div>

              <div>
                <label htmlFor="edit_rate_value" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Valor de la Tasa (%)
                </label>
                <input
                  id="edit_rate_value"
                  type="number"
                  step="0.01"
                  min="0"
                  value={editFormData.rate_value}
                  onChange={(e) => setEditFormData({ ...editFormData, rate_value: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label htmlFor="edit_effective_date" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Fecha Efectiva
                </label>
                <input
                  id="edit_effective_date"
                  type="date"
                  value={editFormData.effective_date}
                  onChange={(e) => setEditFormData({ ...editFormData, effective_date: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label htmlFor="edit_active" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Estado
                </label>
                <select
                  id="edit_active"
                  value={editFormData.active.toString()}
                  onChange={(e) => setEditFormData({ ...editFormData, active: e.target.value === 'true' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="true">Activa</option>
                  <option value="false">Inactiva</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => {
                  setEditOpen(false);
                  setEditingRate(null);
                }}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all font-medium text-sm"
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
      {deleteOpen && deletingRate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Confirmar Eliminación</h2>
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletingRate(null);
                }}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-700 mb-4">
                ¿Estás seguro de que deseas eliminar la tasa de interés?
              </p>
              <div className="bg-gray-50 rounded-lg p-3 mb-4">
                <p className="text-xs font-semibold text-gray-600 mb-1">País:</p>
                <p className="text-sm text-gray-900">{deletingRate.country}</p>
                <p className="text-xs font-semibold text-gray-600 mb-1 mt-2">Tipo:</p>
                <p className="text-sm text-gray-900">{deletingRate.rate_type}</p>
                <p className="text-xs font-semibold text-gray-600 mb-1 mt-2">Valor:</p>
                <p className="text-sm text-gray-900">{parseFloat(deletingRate.rate_value || 0).toFixed(2)}%</p>
              </div>
              <p className="text-xs text-red-600 font-medium">
                Esta acción no se puede deshacer.
              </p>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletingRate(null);
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

export default InterestRatesSettings;
