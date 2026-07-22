export type AdminPermissionGroupKey = 'rapidin' | 'miauto' | 'mimoto';

export type AdminPermissionSection = {
  key: string;
  label: string;
};

export type AdminPermissionGroup = {
  key: AdminPermissionGroupKey;
  label: string;
  sections: AdminPermissionSection[];
};

export const ADMIN_PERMISSION_GROUPS: AdminPermissionGroup[] = [
  {
    key: 'rapidin',
    label: 'Yego Rapidín',
    sections: [
      { key: 'rapidin.dashboard', label: 'Dashboard' },
      { key: 'rapidin.solicitudes', label: 'Solicitudes' },
      { key: 'rapidin.nueva_solicitud', label: 'Nueva solicitud' },
      { key: 'rapidin.prestamos', label: 'Préstamos' },
      { key: 'rapidin.pagos', label: 'Pagos' },
      { key: 'rapidin.cobros_masivos', label: 'Cobros masivos YEGO' },
      { key: 'rapidin.analisis', label: 'Análisis' },
      { key: 'rapidin.provisiones', label: 'Provisiones' },
      { key: 'rapidin.configuracion', label: 'Configuración' },
      { key: 'rapidin.usuarios', label: 'Usuarios y permisos' },
    ],
  },
  {
    key: 'miauto',
    label: 'Yego Mi Auto',
    sections: [
      { key: 'miauto.nueva_solicitud', label: 'Nueva Solicitud' },
      { key: 'miauto.solicitudes', label: 'Solicitudes' },
      { key: 'miauto.alquiler_venta', label: 'Alquiler / Venta' },
      { key: 'miauto.validar_comprobantes', label: 'Validar comprobantes' },
      { key: 'miauto.mensajes', label: 'Mensajes' },
      { key: 'miauto.analisis', label: 'Análisis' },
      { key: 'miauto.configuracion', label: 'Configuración' },
      { key: 'miauto.usuarios', label: 'Usuarios y permisos' },
    ],
  },
  {
    key: 'mimoto',
    label: 'Yego Mi Moto',
    sections: [
      { key: 'mimoto.nueva_solicitud', label: 'Nueva Solicitud' },
      { key: 'mimoto.solicitudes', label: 'Solicitudes' },
      { key: 'mimoto.alquiler_venta', label: 'Alquiler / Venta' },
      { key: 'mimoto.validar_comprobantes', label: 'Validar comprobantes' },
      { key: 'mimoto.mensajes', label: 'Mensajes' },
      { key: 'mimoto.analisis', label: 'Análisis' },
      { key: 'mimoto.configuracion', label: 'Configuración' },
      { key: 'mimoto.usuarios', label: 'Usuarios y permisos' },
    ],
  },
];

export const DEFAULT_ADMIN_PERMISSIONS = [
  'rapidin',
  ...ADMIN_PERMISSION_GROUPS.find((group) => group.key === 'rapidin')!.sections.map((section) => section.key),
];

export const getGroupSectionKeys = (groupKey: AdminPermissionGroupKey) =>
  ADMIN_PERMISSION_GROUPS.find((group) => group.key === groupKey)?.sections.map((section) => section.key) ?? [];

export const uniquePermissions = (permissions: string[]) =>
  Array.from(new Set(permissions.filter(Boolean)));

export const hasGroupAccess = (permissions: string[] | undefined, groupKey: AdminPermissionGroupKey) => {
  const values = permissions?.length ? permissions : DEFAULT_ADMIN_PERMISSIONS;
  return values.includes(groupKey) || values.some((permission) => permission.startsWith(`${groupKey}.`));
};

export const hasSectionAccess = (
  permissions: string[] | undefined,
  groupKey: AdminPermissionGroupKey,
  sectionKey?: string
) => {
  if (!sectionKey) return true;
  const values = permissions?.length ? permissions : DEFAULT_ADMIN_PERMISSIONS;
  const hasExplicitSections = getGroupSectionKeys(groupKey).some((key) => values.includes(key));
  return values.includes(sectionKey) || (values.includes(groupKey) && !hasExplicitSections);
};
