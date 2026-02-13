import { useState, useEffect, useMemo } from 'react';
import { Plus, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const PAGE_SIZES = [5, 10, 20, 50];

const UsersManagement = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    first_name: '',
    last_name: '',
    role: '',
    country: 'PE',
  });

  const total = users.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paginatedUsers = useMemo(() => {
    const start = (page - 1) * limit;
    return users.slice(start, start + limit);
  }, [users, page, limit]);

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const fetchUsers = async () => {
    try {
      const response = await api.get('/users');
      setUsers(response.data.data);
    } catch (error) {
      console.error('Error fetching users:', error);
    }
  };

  const handleSubmit = async () => {
    try {
      await api.post('/users', formData);
      toast.success('Usuario creado correctamente');
      setOpen(false);
      setPage(1);
      fetchUsers();
      setFormData({
        email: '',
        password: '',
        first_name: '',
        last_name: '',
        role: '',
        country: 'PE',
      });
    } catch (error: any) {
      console.error('Error creating user:', error);
      toast.error(error.response?.data?.message || 'Error al crear el usuario');
    }
  };

  const getRoleColor = (role: string) => {
    const colors: { [key: string]: string } = {
      admin: 'bg-red-100 text-red-800',
      analyst: 'bg-blue-100 text-blue-800',
      approver: 'bg-orange-100 text-orange-800',
      payer: 'bg-green-100 text-green-800',
    };
    return colors[role] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
        <h2 className="text-lg sm:text-xl font-bold text-gray-900">Gestión de Usuarios</h2>
        <button
          onClick={() => setOpen(true)}
          className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 text-sm whitespace-nowrap"
        >
          <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
          Nuevo Usuario
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Nombre
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Rol
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  País
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Último Acceso
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.email}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.first_name} {user.last_name}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className={`px-3 py-1 text-xs font-medium rounded-full ${getRoleColor(user.role)}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.country}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span
                      className={`px-3 py-1 text-xs font-medium rounded-full ${
                        user.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {user.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.last_access ? new Date(user.last_access).toLocaleDateString('es-ES', { 
                      year: 'numeric', 
                      month: 'short', 
                      day: 'numeric' 
                    }) : 'Nunca'}
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
              <h2 className="text-xl font-bold text-white">Nuevo Usuario</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Email <span className="text-red-600">*</span>
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Contraseña <span className="text-red-600">*</span>
                </label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                    Nombre <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.first_name}
                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                    Apellido <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.last_name}
                    onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Rol <span className="text-red-600">*</span>
                </label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="">Selecciona un rol</option>
                  <option value="admin">Admin</option>
                  <option value="analyst">Analista</option>
                  <option value="approver">Aprobador</option>
                  <option value="payer">Pagador</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
                <select
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="PE">Perú</option>
                  <option value="CO">Colombia</option>
                </select>
              </div>
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
    </div>
  );
};

export default UsersManagement;
