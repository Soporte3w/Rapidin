import axios from 'axios';
import { getStoredToken, clearSession } from '../utils/authStorage';

// En desarrollo sin VITE_API_URL: usar URL relativa para que desde la IP de red (ej. celular)
// las peticiones vayan al mismo host y el proxy de Vite las envíe al backend.
// Producción: siempre /api (mismo host, nginx hace proxy). Desarrollo: localhost:3000 o VITE_API_URL.
const API_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? 'http://localhost:3000/api' : '/api');

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      clearSession();
      const path = window.location.pathname;
      const loginPath = path.startsWith('/driver') ? '/driver/login' : '/admin/login';
      if (!path.endsWith('/login')) window.location.replace(loginPath);
    }
    return Promise.reject(error);
  }
);

export default api;







