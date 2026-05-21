import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function YegoMiMotoNewRequest() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const creditType = searchParams.get('type');

  useEffect(() => {
    if (!creditType) {
      navigate('/admin/yego-mi-moto/loan-requests/credit-type', { replace: true });
    }
  }, [creditType, navigate]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Nueva solicitud de Yego mi moto</h1>
      <p className="text-gray-600">Formulario — Próximamente.</p>
    </div>
  );
}
