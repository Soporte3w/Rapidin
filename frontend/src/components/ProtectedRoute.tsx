import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600" />
      </div>
    );
  }

  if (!user) {
    // replace evita que el "atrás" del navegador vuelva a la ruta protegida
    if (location.pathname.startsWith('/driver')) {
      return <Navigate to="/driver/login" replace />;
    }
    if (location.pathname.startsWith('/admin')) {
      return <Navigate to="/admin/login" replace />;
    }
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;







