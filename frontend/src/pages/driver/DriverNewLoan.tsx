import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export default function DriverNewLoan() {
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    // Redirigir al flujo de beneficios primero
    if (user) {
      navigate('/driver/loan-benefits', { replace: true });
    }
  }, [user, navigate]);

  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600" />
    </div>
  );
}




