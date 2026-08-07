import { useState, useEffect, useMemo, type ReactNode } from 'react';
import {
  X,
  Pencil,
  Trash2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ShieldCheck,
  KeyRound,
  UserCheck,
  UserX,
  Search,
} from 'lucide-react';
import api from '../../../services/api';
import toast from 'react-hot-toast';
import {
  ADMIN_PERMISSION_GROUPS,
  DEFAULT_ADMIN_PERMISSIONS,
  getGroupSectionKeys,
  uniquePermissions,
  type AdminPermissionGroupKey,
} from '../../../config/adminPermissions';
import { DEFAULT_SYSTEM_ROLE_LABELS, DEFAULT_SYSTEM_ROLE_OPTIONS } from '../../../config/systemRoles';

const PAGE_SIZES = [5, 10, 20, 50];
const RRHH_AUTO_REFRESH_INTERVAL_MS = 30_000;
const LAST_ACCESS_FORMATTER = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const formatLastAccess = (value?: string | null) => {
  if (!value) return 'Nunca';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : LAST_ACCESS_FORMATTER.format(date);
};

const getInitialPermissions = () => [...DEFAULT_ADMIN_PERMISSIONS];

const groupIsChecked = (permissions: string[], groupKey: AdminPermissionGroupKey) =>
  permissions.includes(groupKey) || getGroupSectionKeys(groupKey).some((sectionKey) => permissions.includes(sectionKey));

const groupIsComplete = (permissions: string[], groupKey: AdminPermissionGroupKey) =>
  getGroupSectionKeys(groupKey).every((sectionKey) => permissions.includes(sectionKey));

const toggleGroup = (permissions: string[], groupKey: AdminPermissionGroupKey, checked: boolean) => {
  const sectionKeys = getGroupSectionKeys(groupKey);
  if (checked) return uniquePermissions([...permissions, groupKey, ...sectionKeys]);
  return permissions.filter((permission) => permission !== groupKey && !sectionKeys.includes(permission));
};

const toggleSection = (permissions: string[], groupKey: AdminPermissionGroupKey, sectionKey: string, checked: boolean) => {
  const sectionKeys = getGroupSectionKeys(groupKey);
  const withoutSection = permissions.filter((permission) => permission !== sectionKey);
  const next = checked ? uniquePermissions([...withoutSection, groupKey, sectionKey]) : withoutSection;
  const hasAnySection = sectionKeys.some((key) => next.includes(key));
  return hasAnySection ? uniquePermissions([...next, groupKey]) : next.filter((permission) => permission !== groupKey);
};

const PermissionsSelector = ({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) => (
  <div className="space-y-3">
    {ADMIN_PERMISSION_GROUPS.map((group) => {
      const checked = groupIsChecked(value, group.key);
      const complete = groupIsComplete(value, group.key);
      return (
        <div key={group.key} className={`rounded-lg border p-3 transition-colors ${checked ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white'}`}>
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(toggleGroup(value, group.key, e.target.checked))}
                className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
              />
              <span className="text-sm font-semibold text-gray-900">{group.label}</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${complete ? 'bg-green-100 text-green-800' : checked ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
              {complete ? 'Todo' : checked ? 'Parcial' : 'Sin acceso'}
            </span>
          </label>
          {checked && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {group.sections.map((section) => (
                <label key={section.key} className="flex items-center gap-2 rounded-md bg-white px-2.5 py-2 border border-gray-200 cursor-pointer hover:border-red-200 hover:bg-red-50/30 transition-colors">
                  <input
                    type="checkbox"
                    checked={value.includes(section.key)}
                    onChange={(e) => onChange(toggleSection(value, group.key, section.key, e.target.checked))}
                    className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
                  />
                  <span className="text-xs text-gray-700">{section.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      );
    })}
  </div>
);

type SystemRole = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  allowed_modules: string[];
  active: boolean;
  system_default?: boolean;
  assigned_users?: number;
};

type SystemUser = {
  id: string;
  directory_user_id: string;
  system_user_id?: string | null;
  email: string;
  first_name?: string;
  last_name?: string;
  rrhh_role?: string | null;
  employment_active?: boolean;
  role?: string | null;
  country: string;
  active?: boolean;
  allowed_modules?: string[];
  custom_allowed_modules?: string[] | null;
  inherits_role_permissions?: boolean;
  last_access?: string | null;
};

type EmploymentStatusFilter = 'active' | 'inactive' | 'all';

const createEmptyEditUserForm = () => ({
  first_name: '',
  last_name: '',
  role: '',
  country: 'PE',
  active: true,
  use_role_permissions: true,
  allowed_modules: getInitialPermissions(),
});

type ModalShellProps = {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  iconClassName?: string;
  maxWidth?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
};

const ModalShell = ({
  title,
  subtitle,
  icon,
  iconClassName = 'bg-red-50 text-red-700',
  maxWidth = 'max-w-5xl',
  onClose,
  children,
  footer,
}: ModalShellProps) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-950/60 backdrop-blur-sm">
    <div className={`bg-white rounded-lg shadow-2xl ${maxWidth} w-full max-h-[90vh] overflow-hidden border border-gray-200 flex flex-col`}>
      <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${iconClassName}`}>
            {icon}
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-950">{title}</h2>
            {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-9 w-9 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors flex items-center justify-center"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="p-5 space-y-5 overflow-y-auto">{children}</div>
      <div className="flex justify-end gap-3 p-5 border-t border-gray-200 bg-gray-50">{footer}</div>
    </div>
  </div>
);

const FormPanel = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) => (
  <div className="rounded-lg border border-gray-200 p-4">
    <h3 className="text-sm font-bold text-gray-950 mb-1">{title}</h3>
    {subtitle && <p className="text-xs text-gray-500 mb-4">{subtitle}</p>}
    <div className={subtitle ? '' : 'mt-4'}>{children}</div>
  </div>
);

const ConfirmModal = ({
  title,
  message,
  confirmLabel,
  loading,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <ModalShell
    title={title}
    icon={<Trash2 className="h-5 w-5" />}
    maxWidth="max-w-md"
    onClose={onCancel}
    footer={(
      <>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-all font-semibold shadow-md text-sm disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? 'Procesando...' : confirmLabel}
        </button>
      </>
    )}
  >
    <p className="text-sm text-gray-700 leading-6">{message}</p>
  </ModalShell>
);

const createEmptyRoleForm = () => ({
  name: '',
  description: '',
  allowed_modules: getInitialPermissions(),
});

const UsersManagement = ({ standalone = false }: { standalone?: boolean }) => {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState('');
  const [employmentStatusFilter, setEmploymentStatusFilter] = useState<EmploymentStatusFilter>('active');
  const [editOpen, setEditOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<SystemRole | null>(null);
  const [editingUser, setEditingUser] = useState<SystemUser | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<any>(null);
  const [roleDeleteOpen, setRoleDeleteOpen] = useState(false);
  const [roleToDelete, setRoleToDelete] = useState<SystemRole | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [loadingDelete, setLoadingDelete] = useState(false);
  const [loadingRole, setLoadingRole] = useState(false);
  const [editFormData, setEditFormData] = useState(createEmptyEditUserForm);
  const [roleFormData, setRoleFormData] = useState(createEmptyRoleForm);

  const total = users.length;
  const activeUsers = users.filter((user) => user.active !== false).length;
  const inactiveUsers = Math.max(0, total - activeUsers);
  const employmentActiveTotal = users.filter((user) => user.employment_active !== false).length;
  const employmentInactiveTotal = total - employmentActiveTotal;
  const activeRoles = roles.filter((role) => role.active).length;
  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((user) => {
      if (employmentStatusFilter === 'active' && user.employment_active === false) return false;
      if (employmentStatusFilter === 'inactive' && user.employment_active !== false) return false;
      if (!term) return true;
      return [
        user.first_name,
        user.last_name,
        user.email,
        user.rrhh_role,
        user.role,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });
  }, [users, search, employmentStatusFilter]);
  const filteredTotal = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / limit));
  const paginatedUsers = useMemo(() => {
    const start = (page - 1) * limit;
    return filteredUsers.slice(start, start + limit);
  }, [filteredUsers, page, limit]);
  const roleOptions = useMemo(
    () => roles.length
      ? roles.filter((role) => role.active).map((role) => ({ value: role.code, label: role.name }))
      : DEFAULT_SYSTEM_ROLE_OPTIONS,
    [roles]
  );
  const roleLabels = useMemo(
    () => ({
      ...DEFAULT_SYSTEM_ROLE_LABELS,
      ...Object.fromEntries(roles.map((role) => [role.code, role.name])),
    }),
    [roles]
  );

  useEffect(() => {
    fetchUsers();
    fetchRoles();

    const refreshVisibleDirectory = () => {
      if (document.visibilityState === 'visible') void fetchUsers(true);
    };
    const intervalId = window.setInterval(refreshVisibleDirectory, RRHH_AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshVisibleDirectory);
    document.addEventListener('visibilitychange', refreshVisibleDirectory);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshVisibleDirectory);
      document.removeEventListener('visibilitychange', refreshVisibleDirectory);
    };
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  useEffect(() => {
    setPage(1);
  }, [search, employmentStatusFilter]);

  const fetchUsers = async (silent = false) => {
    try {
      const response = await api.get('/users');
      setUsers(response.data.data);
    } catch {
      if (!silent) toast.error('Error al cargar usuarios');
    }
  };

  const fetchRoles = async () => {
    try {
      const response = await api.get('/users/roles');
      setRoles(response.data.data || []);
    } catch {
      toast.error('Error al cargar roles');
    }
  };

  const refreshUsersAndRoles = async () => {
    await Promise.all([fetchUsers(), fetchRoles()]);
  };

  const applyRoleToForm = (roleCode: string) => {
    setEditFormData((prev) => ({ ...prev, role: roleCode }));
  };

  const openCreateRole = () => {
    setEditingRole(null);
    setRoleFormData(createEmptyRoleForm());
    setRoleOpen(true);
  };

  const openEditRole = (role: SystemRole) => {
    setEditingRole(role);
    setRoleFormData({
      name: role.name || '',
      description: role.description || '',
      allowed_modules: role.allowed_modules?.length ? role.allowed_modules : getInitialPermissions(),
    });
    setRoleOpen(true);
  };

  const openDeleteRole = (role: SystemRole) => {
    setRoleToDelete(role);
    setRoleDeleteOpen(true);
  };

  const handleSaveRole = async () => {
    setLoadingRole(true);
    try {
      if (editingRole?.id) {
        await api.put(`/users/roles/${editingRole.id}`, roleFormData);
        toast.success('Rol actualizado correctamente');
      } else {
        await api.post('/users/roles', roleFormData);
        toast.success('Rol creado correctamente');
      }
      setRoleOpen(false);
      setEditingRole(null);
      setRoleFormData(createEmptyRoleForm());
      await refreshUsersAndRoles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al guardar el rol');
    } finally {
      setLoadingRole(false);
    }
  };

  const handleDeleteRole = async () => {
    if (!roleToDelete?.id) return;
    setLoadingRole(true);
    try {
      await api.delete(`/users/roles/${roleToDelete.id}`);
      toast.success('Rol eliminado correctamente');
      setRoleDeleteOpen(false);
      setRoleToDelete(null);
      await refreshUsersAndRoles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al eliminar el rol');
    } finally {
      setLoadingRole(false);
    }
  };

  const openEdit = (user: SystemUser) => {
    setEditingUser(user);
    setEditFormData({
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      role: user.role || '',
      country: user.country || 'PE',
      active: user.active === true || (!user.system_user_id && user.employment_active !== false),
      use_role_permissions: user.inherits_role_permissions !== false,
      allowed_modules: user.custom_allowed_modules || user.allowed_modules || getInitialPermissions(),
    });
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingUser?.id) return;
    setLoadingEdit(true);
    try {
      const payload: any = {
        first_name: editFormData.first_name,
        last_name: editFormData.last_name,
        role: editFormData.role,
        country: editFormData.country,
        active: editFormData.active,
        custom_allowed_modules: editFormData.use_role_permissions ? null : editFormData.allowed_modules,
      };
      await api.put(`/users/directory/${encodeURIComponent(editingUser.directory_user_id)}/access`, payload);
      toast.success(editFormData.active ? 'Acceso actualizado correctamente' : 'Acceso desactivado correctamente');
      setEditOpen(false);
      setEditingUser(null);
      await refreshUsersAndRoles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al actualizar el usuario');
    } finally {
      setLoadingEdit(false);
    }
  };

  const openDelete = (user: any) => {
    setUserToDelete(user);
    setDeleteOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!userToDelete?.id) return;
    setLoadingDelete(true);
    try {
      await api.put(`/users/directory/${encodeURIComponent(userToDelete.directory_user_id)}/access`, { active: false });
      toast.success('Usuario desactivado correctamente');
      setDeleteOpen(false);
      setUserToDelete(null);
      await refreshUsersAndRoles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al desactivar el usuario');
    } finally {
      setLoadingDelete(false);
    }
  };

  const getRoleColor = (role?: string | null) => {
    const colors: { [key: string]: string } = {
      admin: 'bg-red-100 text-red-800 ring-red-200',
      analyst: 'bg-blue-100 text-blue-800',
      approver: 'bg-orange-100 text-orange-800',
      payer: 'bg-green-100 text-green-800',
    };
    return (role && colors[role]) || 'bg-gray-100 text-gray-800';
  };

  const getRoleLabel = (role?: string | null) => (role ? roleLabels[role] || role : 'Sin rol');
  const countRoleSections = (role: SystemRole) =>
    role.allowed_modules?.filter((permission) => permission.includes('.')).length || 0;
  const roleDeleteDisabledReason = (role: SystemRole) => {
    if ((role.assigned_users || 0) > 0) return 'No se puede eliminar un rol asignado a usuarios';
    return '';
  };

  return (
    <div className="w-full space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-red-50 text-red-700 flex items-center justify-center">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <h2 className="text-xl font-bold text-gray-950">
            {standalone ? 'Usuarios del sistema' : 'Gestión de Usuarios'}
              </h2>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Directorio de RR. HH. con acceso, roles y permisos del financiador.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={openCreateRole}
              className="border border-gray-300 bg-white text-gray-800 hover:border-red-300 hover:bg-red-50 hover:text-red-700 font-semibold py-2.5 px-4 rounded-lg transition-all flex items-center justify-center gap-2 text-sm whitespace-nowrap"
            >
              <KeyRound className="h-4 w-4" />
              Nuevo rol
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 border-t border-gray-100">
          <div className="p-4 border-b sm:border-r xl:border-b-0 border-gray-100">
            <p className="text-xs font-semibold uppercase text-gray-500">Con acceso</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-2xl font-bold text-gray-950">{activeUsers}</span>
              <UserCheck className="h-5 w-5 text-green-600" />
            </div>
          </div>
          <div className="p-4 border-b sm:border-r sm:border-b-0 border-gray-100">
            <p className="text-xs font-semibold uppercase text-gray-500">Sin acceso</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-2xl font-bold text-gray-950">{inactiveUsers}</span>
              <UserX className="h-5 w-5 text-gray-500" />
            </div>
          </div>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase text-gray-500">Roles activos</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-2xl font-bold text-gray-950">{activeRoles}</span>
              <KeyRound className="h-5 w-5 text-red-700" />
            </div>
          </div>
        </div>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-bold text-gray-950">Roles configurados</h3>
            <p className="text-xs text-gray-500 mt-0.5">Plantillas de permisos que puedes asignar a los usuarios.</p>
          </div>
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">{roles.length} roles</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 p-4">
          {roles.map((role) => (
            <article key={role.id} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-sm font-bold text-gray-950 truncate">{role.name}</h4>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{role.description || 'Sin descripción'}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${role.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                  {role.active ? 'Activo' : 'Inactivo'}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-3">
                <span className="text-xs font-medium text-gray-500">Permisos</span>
                <span className="text-sm font-bold text-gray-950">{countRoleSections(role)} secciones</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Usuarios</span>
                <span className="text-sm font-bold text-gray-950">{role.assigned_users || 0}</span>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => openEditRole(role)}
                  className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-700 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700 transition-colors inline-flex items-center gap-1.5"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => openDeleteRole(role)}
                  disabled={!!roleDeleteDisabledReason(role)}
                  className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-45 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                  title={roleDeleteDisabledReason(role) || 'Eliminar rol'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Eliminar
                </button>
              </div>
            </article>
          ))}
          {roles.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
              Cargando roles...
            </div>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="flex flex-col gap-3 px-5 py-4 border-b border-gray-100 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-base font-bold text-gray-950">Directorio de usuarios</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Altas y bajas se reflejan automáticamente desde RR. HH.; los empleados sin asignación aparecen sin acceso.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={employmentStatusFilter}
              onChange={(event) => setEmploymentStatusFilter(event.target.value as EmploymentStatusFilter)}
              aria-label="Filtrar por estado de RR. HH."
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500 sm:w-auto"
            >
              <option value="active">Activos ({employmentActiveTotal})</option>
              <option value="inactive">Desactivados ({employmentInactiveTotal})</option>
              <option value="all">Todos ({total})</option>
            </select>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar nombre, correo o rol"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500 sm:w-72"
              />
            </label>
            <span className="whitespace-nowrap rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
              {filteredTotal === total ? `${total} usuarios` : `${filteredTotal} de ${total}`}
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Usuario
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Rol RR. HH.
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Rol financiador
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
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {paginatedUsers.map((user) => (
                <tr key={user.id} className="hover:bg-red-50/40 transition-colors">
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold">
                        {(user.first_name?.[0] || user.email?.[0] || 'U').toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-950">{user.first_name} {user.last_name}</p>
                        <p className="text-xs text-gray-500">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className="px-3 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-700">
                      {user.rrhh_role || 'Sin rol'}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className={`px-3 py-1 text-xs font-semibold rounded-full ${getRoleColor(user.role)}`}>
                      {getRoleLabel(user.role)}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.system_user_id ? user.country : '—'}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span
                      className={`px-3 py-1 text-xs font-semibold rounded-full ${
                        !user.employment_active
                          ? 'bg-amber-100 text-amber-800'
                          : user.active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {!user.employment_active ? 'Inactivo en RR. HH.' : user.active ? 'Con acceso' : 'Sin acceso'}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatLastAccess(user.last_access)}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => openEdit(user)}
                        className="p-2 text-gray-600 hover:bg-amber-50 hover:text-amber-700 rounded-lg transition-colors"
                        title={user.active ? 'Editar acceso' : 'Asignar acceso'}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {user.active && (
                        <button
                          type="button"
                          onClick={() => openDelete(user)}
                          className="p-2 text-gray-600 hover:bg-red-50 hover:text-red-700 rounded-lg transition-colors"
                          title="Desactivar acceso"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {paginatedUsers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">
                    No se encontraron usuarios con ese criterio.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredTotal > 0 && (
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
      </section>

      {roleOpen && (
        <ModalShell
          title={editingRole ? 'Editar rol' : 'Nuevo rol'}
          subtitle={editingRole ? 'Actualiza la plantilla de permisos.' : 'Define una plantilla de permisos reutilizable.'}
          icon={<KeyRound className="h-5 w-5" />}
          maxWidth="max-w-4xl"
          onClose={() => { setRoleOpen(false); setEditingRole(null); }}
          footer={(
            <>
              <button
                type="button"
                onClick={() => { setRoleOpen(false); setEditingRole(null); }}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSaveRole}
                disabled={loadingRole || !roleFormData.name.trim()}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loadingRole && <Loader2 className="h-4 w-4 animate-spin" />}
                {loadingRole ? 'Guardando...' : editingRole ? 'Guardar cambios' : 'Crear rol'}
              </button>
            </>
          )}
        >
          <FormPanel title="Datos del rol">
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Nombre del rol <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={roleFormData.name}
                  onChange={(e) => setRoleFormData({ ...roleFormData, name: e.target.value })}
                  placeholder="Ej. Cobrador Mi Auto"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                />
                <label className="block text-xs font-semibold text-gray-900 mb-1.5 mt-4">Descripción</label>
                <textarea
                  value={roleFormData.description}
                  onChange={(e) => setRoleFormData({ ...roleFormData, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm resize-none"
                />
          </FormPanel>

          <FormPanel
            title="Permisos del rol"
            subtitle="Selecciona los módulos y secciones visibles para este rol."
          >
                <PermissionsSelector
                  value={roleFormData.allowed_modules}
                  onChange={(allowed_modules) => setRoleFormData({ ...roleFormData, allowed_modules })}
                />
          </FormPanel>
        </ModalShell>
      )}

      {editOpen && editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-950/60 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden border border-gray-200 flex flex-col">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-white">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center">
                  <Pencil className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-950">{editingUser.active ? 'Editar acceso' : 'Asignar acceso'}</h2>
                  <p className="text-xs text-gray-500">{editingUser.email}</p>
                </div>
              </div>
              <button
                onClick={() => { setEditOpen(false); setEditingUser(null); }}
                className="h-9 w-9 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-5 overflow-y-auto">
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="text-sm font-bold text-gray-950 mb-4">Identidad</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email</label>
                <input
                  type="email"
                  value={editingUser.email}
                  disabled
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-600 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Rol en RR. HH.</label>
                <input
                  type="text"
                  value={editingUser.rrhh_role || 'Sin rol registrado'}
                  disabled
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-600 text-sm"
                />
              </div>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="text-sm font-bold text-gray-950 mb-4">Perfil</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Nombre</label>
                  <input
                    type="text"
                    value={editFormData.first_name}
                    onChange={(e) => setEditFormData({ ...editFormData, first_name: e.target.value })}
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-900 mb-1.5">Apellido</label>
                  <input
                    type="text"
                    value={editFormData.last_name}
                    onChange={(e) => setEditFormData({ ...editFormData, last_name: e.target.value })}
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-600"
                  />
                </div>
              </div>

              <div className="mt-4">
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Rol</label>
                <select
                  value={editFormData.role}
                  onChange={(e) => applyRoleToForm(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="">Selecciona un rol</option>
                  {roleOptions.map((role) => (
                    <option key={role.value} value={role.value}>{role.label}</option>
                  ))}
                </select>
              </div>

              <div className="mt-4">
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
                <select
                  value={editFormData.country}
                  onChange={(e) => setEditFormData({ ...editFormData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                >
                  <option value="PE">Perú</option>
                  <option value="CO">Colombia</option>
                </select>
              </div>
              </div>
              <div className="rounded-lg border border-gray-200 p-4 flex items-center gap-3">
                <input
                  type="checkbox"
                  id="edit-active"
                  checked={editFormData.active}
                  onChange={(e) => setEditFormData({ ...editFormData, active: e.target.checked })}
                  disabled={editingUser.employment_active === false}
                  className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
                />
                <div>
                  <label htmlFor="edit-active" className="text-sm font-medium text-gray-700">Acceso al financiador</label>
                  <p className="text-xs text-gray-500">
                    {editingUser.employment_active === false
                      ? 'RR. HH. tiene a esta persona inactiva; no puede habilitarse aquí.'
                      : 'Al desactivarlo no se modifica su estado laboral en RR. HH.'}
                  </p>
                </div>
              </div>

              <FormPanel
                title="Permisos del usuario"
                subtitle="Puede heredar la plantilla del rol o tener una selección particular."
              >
                <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className={`cursor-pointer rounded-lg border p-3 ${editFormData.use_role_permissions ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
                    <input
                      type="radio"
                      name="permission-mode"
                      checked={editFormData.use_role_permissions}
                      onChange={() => setEditFormData({ ...editFormData, use_role_permissions: true })}
                      className="mr-2 text-red-600 focus:ring-red-500"
                    />
                    <span className="text-sm font-semibold text-gray-800">Heredar del rol</span>
                  </label>
                  <label className={`cursor-pointer rounded-lg border p-3 ${!editFormData.use_role_permissions ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
                    <input
                      type="radio"
                      name="permission-mode"
                      checked={!editFormData.use_role_permissions}
                      onChange={() => setEditFormData({ ...editFormData, use_role_permissions: false })}
                      className="mr-2 text-red-600 focus:ring-red-500"
                    />
                    <span className="text-sm font-semibold text-gray-800">Personalizar permisos</span>
                  </label>
                </div>
                {editFormData.use_role_permissions ? (
                  <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                    Se aplicarán automáticamente los permisos configurados para {getRoleLabel(editFormData.role)}.
                  </p>
                ) : (
                  <PermissionsSelector
                    value={editFormData.allowed_modules}
                    onChange={(allowed_modules) => setEditFormData({ ...editFormData, allowed_modules })}
                  />
                )}
              </FormPanel>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => { setEditOpen(false); setEditingUser(null); }}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={handleEditSubmit}
                disabled={loadingEdit || (editFormData.active && (!editFormData.role || editingUser.employment_active === false))}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loadingEdit && <Loader2 className="h-4 w-4 animate-spin" />}
                {loadingEdit ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && userToDelete && (
        <ConfirmModal
          title="Desactivar usuario"
          message={<>¿Desactivar al usuario <strong>{userToDelete.email}</strong>? No podrá iniciar sesión.</>}
          confirmLabel="Desactivar"
          loading={loadingDelete}
          onCancel={() => { setDeleteOpen(false); setUserToDelete(null); }}
          onConfirm={handleDeleteConfirm}
        />
      )}

      {roleDeleteOpen && roleToDelete && (
        <ConfirmModal
          title="Eliminar rol"
          message={<>¿Eliminar el rol <strong>{roleToDelete.name}</strong>? Esta acción solo se permite si el rol no está asignado a ningún usuario.</>}
          confirmLabel="Eliminar"
          loading={loadingRole}
          onCancel={() => { setRoleDeleteOpen(false); setRoleToDelete(null); }}
          onConfirm={handleDeleteRole}
        />
      )}
    </div>
  );
};

export default UsersManagement;
