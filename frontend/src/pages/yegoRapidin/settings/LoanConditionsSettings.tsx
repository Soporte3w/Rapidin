import { useState, useEffect, useMemo } from 'react';
import { Plus, X, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import api from '../../../services/api';
import toast from 'react-hot-toast';

const PAGE_SIZES = [5, 10, 20, 50];

type ConditionRow = {
  id: string;
  country: string;
  version: number;
  active: boolean;
  late_fee_type: string;
  late_fee_rate: string | number;
  late_fee_cap: string | number | null;
  initial_wait_days: number;
  payment_day_of_week: number;
  min_weeks: number;
  max_weeks: number;
};

const defaultForm = {
  country: 'PE',
  late_fee_type: 'linear',
  late_fee_rate: '',
  late_fee_cap: '',
  initial_wait_days: '',
  payment_day_of_week: '1',
  min_weeks: '',
  max_weeks: '',
  active: true,
};

const LoanConditionsSettings = () => {
  const [conditions, setConditions] = useState<ConditionRow[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(defaultForm);

  const total = conditions.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paginatedConditions = useMemo(() => {
    const start = (page - 1) * limit;
    return conditions.slice(start, start + limit);
  }, [conditions, page, limit]);

  useEffect(() => {
    fetchConditions();
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const fetchConditions = async () => {
    try {
      const response = await api.get('/loan-conditions');
      setConditions(response.data.data);
    } catch (error) {
      console.error('Error fetching conditions:', error);
    }
  };

  const handleSubmit = async () => {
    try {
      if (editingId) {
        await api.put(`/loan-conditions/${editingId}`, {
          late_fee_type: formData.late_fee_type,
          late_fee_rate: formData.late_fee_rate ? Number(formData.late_fee_rate) : undefined,
          late_fee_cap: formData.late_fee_cap === '' ? null : (formData.late_fee_cap ? Number(formData.late_fee_cap) : undefined),
          initial_wait_days: formData.initial_wait_days ? Number(formData.initial_wait_days) : undefined,
          payment_day_of_week: formData.payment_day_of_week ? Number(formData.payment_day_of_week) : undefined,
          min_weeks: formData.min_weeks ? Number(formData.min_weeks) : undefined,
          max_weeks: formData.max_weeks ? Number(formData.max_weeks) : undefined,
          active: formData.active,
        });
        toast.success('Condición actualizada correctamente');
      } else {
        await api.post('/loan-conditions', formData);
        toast.success('Condición creada correctamente');
      }
      setOpen(false);
      setEditingId(null);
      setFormData(defaultForm);
      setPage(1);
      fetchConditions();
    } catch (error: any) {
      console.error(editingId ? 'Error updating conditions' : 'Error creating conditions', error);
      toast.error(error.response?.data?.message || (editingId ? 'Error al actualizar la condición' : 'Error al crear la condición'));
    }
  };

  const handleEdit = (condition: ConditionRow) => {
    setEditingId(condition.id);
    setFormData({
      country: condition.country,
      late_fee_type: condition.late_fee_type || 'linear',
      late_fee_rate: String(condition.late_fee_rate ?? ''),
      late_fee_cap: condition.late_fee_cap != null ? String(condition.late_fee_cap) : '',
      initial_wait_days: String(condition.initial_wait_days ?? ''),
      payment_day_of_week: String(condition.payment_day_of_week ?? '1'),
      min_weeks: String(condition.min_weeks ?? ''),
      max_weeks: String(condition.max_weeks ?? ''),
      active: condition.active,
    });
    setOpen(true);
  };

  const handleDelete = async (condition: ConditionRow) => {
    if (!window.confirm(`¿Eliminar la condición ${condition.country} v${condition.version}? Solo se pueden eliminar condiciones inactivas.`)) return;
    try {
      await api.delete(`/loan-conditions/${condition.id}`);
      toast.success('Condición eliminada');
      fetchConditions();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al eliminar la condición');
    }
  };

  const closeModal = () => {
    setOpen(false);
    setEditingId(null);
    setFormData(defaultForm);
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
        <h2 className="text-lg sm:text-xl font-bold text-gray-900">Condiciones de Préstamo</h2>
        <button
          onClick={() => setOpen(true)}
          className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 text-sm whitespace-nowrap"
        >
          <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
          Nueva Condición
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
                  Versión
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Tipo Mora
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Tasa Mora
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Tope Mora
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Semanas Min/Max
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedConditions.map((condition) => (
                <tr key={condition.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.country}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.version}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.late_fee_type}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.late_fee_rate}%
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.late_fee_cap ?? 'N/A'}%
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {condition.min_weeks} - {condition.max_weeks}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span
                      className={`px-3 py-1 text-xs font-medium rounded-full ${
                        condition.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {condition.active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleEdit(condition)}
                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(condition)}
                        disabled={condition.active}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        title={condition.active ? 'No se puede eliminar la condición activa' : 'Eliminar'}
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

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-100">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-xl font-bold text-white">
                {editingId ? 'Editar Condición de Préstamo' : 'Nueva Condición de Préstamo'}
              </h2>
              <button
                onClick={closeModal}
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
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  disabled={!!editingId}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  <option value="PE">Perú</option>
                  <option value="CO">Colombia</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Tipo de Mora</label>
                <select
                  value={formData.late_fee_type}
                  onChange={(e) => setFormData({ ...formData, late_fee_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="linear">Lineal</option>
                  <option value="compound">Compuesta</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Tasa de Mora (%)</label>
                <input
                  type="number"
                  value={formData.late_fee_rate}
                  onChange={(e) => setFormData({ ...formData, late_fee_rate: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Tope de Mora (%)</label>
                <input
                  type="number"
                  value={formData.late_fee_cap}
                  onChange={(e) => setFormData({ ...formData, late_fee_cap: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Días de Espera Inicial</label>
                <input
                  type="number"
                  value={formData.initial_wait_days}
                  onChange={(e) => setFormData({ ...formData, initial_wait_days: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Semanas Mínimas</label>
                  <input
                    type="number"
                    value={formData.min_weeks}
                    onChange={(e) => setFormData({ ...formData, min_weeks: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Semanas Máximas</label>
                  <input
                    type="number"
                    value={formData.max_weeks}
                    onChange={(e) => setFormData({ ...formData, max_weeks: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
              </div>

              {editingId && (
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Estado</label>
                  <select
                    value={formData.active ? 'true' : 'false'}
                    onChange={(e) => setFormData({ ...formData, active: e.target.value === 'true' })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  >
                    <option value="true">Activa</option>
                    <option value="false">Inactiva</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">Solo una condición por país puede estar activa a la vez.</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 p-6 border-t border-gray-200">
              <button
                onClick={closeModal}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm"
              >
                {editingId ? 'Guardar' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LoanConditionsSettings;




