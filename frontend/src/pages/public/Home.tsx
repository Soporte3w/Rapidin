import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export default function Home() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading) {
      if (user) {
        // Si está logueado, redirigir según tipo de usuario
        if (user.role === 'driver' || user.phone) {
          // Conductor
          navigate('/driver/resumen', { replace: true });
        } else {
          // Admin
          navigate('/admin/dashboard', { replace: true });
        }
      } else {
        // Si no está logueado, ir al login de conductor
        navigate('/driver/login', { replace: true });
      }
    }
  }, [user, loading, navigate]);

  // Mostrar loader mientras verifica autenticación
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600" />
    </div>
  );
}




