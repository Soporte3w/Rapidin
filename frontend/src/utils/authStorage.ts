/**
 * Toda la sesión (token, usuario, flota elegida) se guarda en una sola clave "user".
 */

const STORAGE_KEY = 'user';

export interface StoredSession {
  token: string;
  user: Record<string, unknown>;
  selectedParkId?: string;
  selectedExternalDriverId?: string;
  /** Id del conductor en la flota elegida (module_rapidin_drivers). Se guarda al elegir flota. */
  selectedRapidinDriverId?: string;
  selectedFlotaName?: string;
}

export function getStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredSession(session: StoredSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function updateStoredFlota(
  selectedParkId: string,
  selectedExternalDriverId: string,
  selectedFlotaName?: string,
  selectedRapidinDriverId?: string | null
): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({
    ...session,
    selectedParkId: selectedParkId || undefined,
    selectedExternalDriverId: selectedExternalDriverId || undefined,
    selectedRapidinDriverId: selectedRapidinDriverId || undefined,
    selectedFlotaName: selectedFlotaName || undefined,
  });
}

export function getStoredFlotaName(): string | null {
  return getStoredSession()?.selectedFlotaName ?? null;
}

/** Guarda solo el nombre de la flota en sesión (ej. después de obtenerlo por API de partners). */
export function setStoredFlotaName(name: string | null | undefined): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({
    ...session,
    selectedFlotaName: name || undefined,
  });
}

export function getStoredToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function getStoredSelectedParkId(): string | null {
  return getStoredSession()?.selectedParkId ?? null;
}

export function getStoredSelectedExternalDriverId(): string | null {
  return getStoredSession()?.selectedExternalDriverId ?? null;
}

export function getStoredRapidinDriverId(): string | null {
  return getStoredSession()?.selectedRapidinDriverId ?? null;
}

/** Guarda el rapidin_driver_id en localStorage (se usa al elegir flota y cuando la API lo devuelve en loans/dashboard). */
export function setStoredRapidinDriverId(driverId: string | null | undefined): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({
    ...session,
    selectedRapidinDriverId: driverId && String(driverId).trim() ? String(driverId).trim() : undefined,
  });
}

/**
 * Persiste park_id y rapidin_driver_id en localStorage a partir de la respuesta de /driver/loans o /driver/dashboard.
 * Así, aunque el usuario entre sin haber elegido flota, la primera carga rehidrata el contexto y las siguientes peticiones ya llevan los params.
 */
export function persistDriverContextFromResponse(data: { park_id?: string | null; rapidin_driver_id?: string | null } | null | undefined): void {
  if (!data || typeof data !== 'object') return;
  const session = getStoredSession();
  if (!session) return;
  const parkId = data.park_id != null && data.park_id !== '' ? String(data.park_id).trim() : undefined;
  const driverId = data.rapidin_driver_id != null && data.rapidin_driver_id !== '' ? String(data.rapidin_driver_id).trim() : undefined;
  if (!parkId && !driverId) return;
  setStoredSession({
    ...session,
    ...(parkId != null && { selectedParkId: parkId }),
    ...(driverId != null && { selectedRapidinDriverId: driverId }),
  });
}
