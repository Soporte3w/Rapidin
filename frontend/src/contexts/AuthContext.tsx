import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../services/api';
import { getStoredSession, setStoredSession, clearSession } from '../utils/authStorage';

interface User {
  id: string;
  email?: string;
  phone?: string;
  first_name: string;
  last_name: string;
  role: string;
  country: string;
  document_number?: string;
  document_type?: string;
  rating?: number;
  account_balance?: number;
  has_active_loan?: boolean;
  active_loan?: {
    loan_amount: number;
    pending_amount: number;
  };
  /** ID del conductor (consulta por teléfono al hacer login) */
  driver_id?: string | null;
  /** ID del car/registro en tabla drivers (consulta por teléfono al hacer login) */
  car_id?: string | null;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  loginWithPhone: (phone: string, code: string, country: 'PE' | 'CO') => Promise<{ flotas?: Array<{ driver_id: string | null; park_id: string | null; flota_name: string }> }>;
  logout: () => void;
  updateUser: (partial: Partial<User>) => void;
  loading: boolean;
}

/** Decodifica el payload del JWT sin verificar firma (solo para leer exp en cliente). */
function getTokenExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    ) as { exp?: number };
    return decoded.exp ?? null;
  } catch {
    return null;
  }
}

/** Devuelve true si el token está expirado (o inválido). */
function isTokenExpired(token: string): boolean {
  const exp = getTokenExp(token);
  if (exp == null) return true;
  return Date.now() >= exp * 1000;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const session = getStoredSession();
    if (!session) {
      clearSession();
      setLoading(false);
      return;
    }

    if (isTokenExpired(session.token)) {
      clearSession();
      setUser(null);
      setLoading(false);
      return;
    }

    setUser((session.user as unknown) as User);
    setLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    const { token, user: userData } = response.data.data;
    setStoredSession({ token, user: userData });
    setUser(userData);
  };

  const loginWithPhone = async (phone: string, code: string, country: 'PE' | 'CO') => {
    const response = await api.post('/auth/verify-otp', { phone, code, country });
    const { token, user: userData, flotas } = response.data.data || {};
    setStoredSession({ token, user: userData });
    setUser(userData);
    return { flotas: flotas || [] };
  };

  const logout = () => {
    clearSession();
    setUser(null);
  };

  const updateUser = (partial: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return null;
      const next = { ...prev, ...partial };
      const session = getStoredSession();
      if (session) {
        setStoredSession({ ...session, user: next });
      }
      return next;
    });
  };

  return (
    <AuthContext.Provider value={{ user, login, loginWithPhone, logout, updateUser, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};







