import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const generateLoanContract = async (loanId) => {
  const loan = await query(
    `SELECT l.*, d.first_name, d.last_name, d.dni, d.phone, d.email
     FROM module_rapidin_loans l
     JOIN module_rapidin_drivers d ON d.id = l.driver_id
     WHERE l.id = $1`,
    [loanId]
  );

  if (loan.rows.length === 0) {
    throw new Error('Préstamo no encontrado');
  }

  const loanData = loan.rows[0];
  
  const contractHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Contrato de Préstamo - ${loanData.id}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        h1 { color: #333; }
        .section { margin: 20px 0; }
        .signature { margin-top: 60px; }
      </style>
    </head>
    <body>
      <h1>CONTRATO DE PRÉSTAMO</h1>
      
      <div class="section">
        <h2>Datos del Conductor</h2>
        <p><strong>Nombre:</strong> ${loanData.first_name} ${loanData.last_name}</p>
        <p><strong>DNI:</strong> ${loanData.dni}</p>
        <p><strong>Teléfono:</strong> ${loanData.phone}</p>
        <p><strong>Email:</strong> ${loanData.email}</p>
      </div>

      <div class="section">
        <h2>Datos del Préstamo</h2>
        <p><strong>Monto desembolsado:</strong> ${loanData.disbursed_amount}</p>
        <p><strong>Monto total:</strong> ${loanData.total_amount}</p>
        <p><strong>Tasa de interés:</strong> ${loanData.interest_rate}%</p>
        <p><strong>Número de cuotas:</strong> ${loanData.number_of_installments}</p>
        <p><strong>Fecha de desembolso:</strong> ${loanData.disbursed_at}</p>
        <p><strong>Primera fecha de pago:</strong> ${loanData.first_payment_date}</p>
      </div>

      <div class="section">
        <h2>Términos y Condiciones</h2>
        <p>El conductor se compromete a pagar las cuotas según el cronograma establecido.</p>
        <p>En caso de atraso, se aplicarán cargos por mora según las condiciones del préstamo.</p>
      </div>

      <div class="signature">
        <p>Firma del Conductor:</p>
        <p>_________________________</p>
        <p>Fecha: _______________</p>
      </div>
    </body>
    </html>
  `;

  const uploadsDir = path.join(__dirname, '../../uploads/contracts');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const fileName = `contract_${loanId}_${Date.now()}.html`;
  const filePath = path.join(uploadsDir, fileName);

  fs.writeFileSync(filePath, contractHTML);

  await query(
    `INSERT INTO module_rapidin_documents (loan_id, type, file_name, file_path)
     VALUES ($1, 'contract', $2, $3)`,
    [loanId, fileName, filePath]
  );

  return { filePath, fileName };
};

export const getDocuments = async (loanId) => {
  const result = await query(
    'SELECT * FROM module_rapidin_documents WHERE loan_id = $1 ORDER BY created_at DESC',
    [loanId]
  );

  return result.rows;
};

/** Documentos de una solicitud (fotos DNI, firmas contacto/contrato) para mostrar en admin */
export const getDocumentsByRequestId = async (requestId) => {
  const result = await query(
    `SELECT id, type, file_name, file_path, created_at 
     FROM module_rapidin_documents 
     WHERE request_id = $1 
        OR (loan_id IS NULL AND (file_path LIKE $2 OR file_name LIKE $2))
     ORDER BY created_at ASC`,
    [requestId, `%${requestId}%`]
  );
  return result.rows;
};

/** Un documento por id, solo si pertenece a la solicitud (para servir archivo) */
export const getDocumentByIdAndRequestId = async (docId, requestId) => {
  const result = await query(
    `SELECT id, type, file_name, file_path 
     FROM module_rapidin_documents 
     WHERE id = $1 
       AND (request_id = $2 OR loan_id IS NULL AND (file_path LIKE $3 OR file_name LIKE $3))`,
    [docId, requestId, `%${requestId}%`]
  );
  return result.rows[0] || null;
};

export const markDocumentAsSigned = async (documentId, signedBy) => {
  await query(
    `UPDATE module_rapidin_documents 
     SET signed = true, signed_at = CURRENT_TIMESTAMP, signed_by = $1
     WHERE id = $2`,
    [signedBy, documentId]
  );
};







