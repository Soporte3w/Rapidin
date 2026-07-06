export const SYSTEM_BASE_ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrador' },
  { value: 'analyst', label: 'Analista' },
  { value: 'approver', label: 'Aprobador' },
  { value: 'payer', label: 'Pagador' },
];

export const DEFAULT_SYSTEM_ROLE_OPTIONS = SYSTEM_BASE_ROLE_OPTIONS;

export const DEFAULT_SYSTEM_ROLE_LABELS = Object.fromEntries(
  DEFAULT_SYSTEM_ROLE_OPTIONS.map((role) => [role.value, role.label])
);
