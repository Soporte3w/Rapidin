import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx';

export async function fetchRRHHUsers(search = '') {
  const term = (search || '').trim().toLowerCase();
  if (term.length < 2) {
    const r = await query(
      'SELECT id, first_name, last_name, dni, role FROM module_rrhh_users WHERE is_active = true ORDER BY last_name, first_name LIMIT 50'
    );
    return r.rows;
  }
  const pattern = `%${term.replace(/\s+/g, '%')}%`;
  const r = await query(
    `SELECT id, first_name, last_name, dni, role FROM module_rrhh_users
     WHERE is_active = true
       AND (LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(first_name || ' ' || last_name) LIKE $1 OR dni LIKE $1)
     ORDER BY last_name, first_name LIMIT 25`,
    [pattern]
  );
  return r.rows;
}

export async function getConfigCreditoPersonal() {
  const r = await query(
    'SELECT interest_rate, max_installments FROM module_rapidin_creditos_personal_config WHERE active = true ORDER BY created_at DESC LIMIT 1'
  );
  if (r.rows.length === 0) return { interest_rate: 7.00, max_installments: 10 };
  return {
    interest_rate: parseFloat(r.rows[0].interest_rate),
    max_installments: parseInt(r.rows[0].max_installments, 10),
  };
}

export async function updateConfigCreditoPersonal(data, userId) {
  const { interest_rate, max_installments } = data;
  const updates = [];
  const params = [];
  let n = 1;
  if (interest_rate != null) {
    updates.push(`interest_rate = $${n++}`);
    params.push(parseFloat(interest_rate));
  }
  if (max_installments != null) {
    updates.push(`max_installments = $${n++}`);
    params.push(parseInt(max_installments, 10));
  }
  if (updates.length === 0) throw new Error('Nada que actualizar');
  params.push(userId);
  await query(
    `UPDATE module_rapidin_creditos_personal_config SET ${updates.join(', ')}, updated_by = $${n}, updated_at = CURRENT_TIMESTAMP WHERE active = true`,
    params
  );
  return getConfigCreditoPersonal();
}

export async function createCreditoPersonal(data, userId) {
  const config = await getConfigCreditoPersonal();
  const interestRate = config.interest_rate;

  const {
    user_gestion_id, first_name, last_name, dni, document_type,
    email, phone, role, amount, number_of_installments,
    payment_frequency = 'monthly',
    bank_name, bank_account, bank_account_type,
  } = data;

  const bankName = bank_name || null;
  const bankAccount = bank_account || null;
  const bankAccountType = bank_account_type || null;
  const totalInterest = amount * (interestRate / 100) * number_of_installments;
  const totalAmount = amount + totalInterest;
  const installmentAmount = totalAmount / number_of_installments;

  const result = await query(
    `INSERT INTO module_rapidin_creditos_personal
     (user_gestion_id, first_name, last_name, dni, document_type, email, phone, role,
      amount, total_amount, interest_rate, number_of_installments, payment_frequency,
      pending_balance, bank_name, bank_account, bank_account_type, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [user_gestion_id, first_name, last_name, dni, document_type, email, phone, role,
     amount, totalAmount, interestRate, number_of_installments, payment_frequency,
     totalAmount, bankName, bankAccount, bankAccountType, userId, 'pending']
  );

  const creditoId = result.rows[0].id;

  for (let i = 1; i <= number_of_installments; i++) {
    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + i);
    await query(
      `INSERT INTO module_rapidin_creditos_personal_cuotas
       (credito_id, installment_number, installment_amount, due_date)
       VALUES ($1, $2, $3, $4)`,
      [creditoId, i, installmentAmount, dueDate.toISOString().slice(0, 10)]
    );
  }

  return getCreditoPersonalById(creditoId);
}

export async function getCreditoPersonalById(id) {
  const r = await query(
    'SELECT * FROM module_rapidin_creditos_personal WHERE id = $1',
    [id]
  );
  if (r.rows.length === 0) return null;
  const credito = r.rows[0];

  const cuotas = await query(
    `SELECT * FROM module_rapidin_creditos_personal_cuotas
     WHERE credito_id = $1 ORDER BY installment_number`,
    [id]
  );
  credito.cuotas = cuotas.rows;

  const docs = await query(
    `SELECT d.* FROM module_rapidin_creditos_personal_docs d
     WHERE d.credito_id = $1 ORDER BY d.created_at DESC`,
    [id]
  );
  credito.documentos = docs.rows;

  return credito;
}

export async function listCreditosPersonales(filters = {}) {
  const { status, page = 1, limit = 20, q } = filters;
  const params = [];
  let n = 1;
  let where = ' WHERE 1=1';
  if (status) {
    where += ` AND c.status = $${n}`;
    params.push(status);
    n++;
  }
  if (q) {
    const tok = `%${q.toLowerCase()}%`;
    where += ` AND (LOWER(c.first_name || ' ' || c.last_name) LIKE $${n} OR LOWER(c.dni) LIKE $${n})`;
    params.push(tok);
    n++;
  }

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM module_rapidin_creditos_personal c ${where}`,
    params
  );
  const total = countRes.rows[0]?.total ?? 0;

  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const offset = (Math.max(1, parseInt(page) || 1) - 1) * limitNum;

  const data = await query(
    `SELECT c.*, COALESCE(d.doc_count, 0)::int AS doc_count, d.first_file_path AS doc_file_path
     FROM module_rapidin_creditos_personal c
     LEFT JOIN (
       SELECT credito_id, COUNT(*)::int AS doc_count, MIN(file_path) AS first_file_path FROM module_rapidin_creditos_personal_docs GROUP BY credito_id
     ) d ON d.credito_id = c.id
     ${where}
     ORDER BY c.created_at DESC LIMIT $${n} OFFSET $${n + 1}`,
    [...params, limitNum, offset]
  );

  return { data: data.rows, total };
}

export async function getLastBankDetailsForUser(userGestionId) {
  if (!userGestionId) return null;
  const r = await query(
    `SELECT bank_name, bank_account, bank_account_type
     FROM module_rapidin_creditos_personal
     WHERE user_gestion_id = $1
       AND bank_account IS NOT NULL
       AND TRIM(COALESCE(bank_account, '')) <> ''
     ORDER BY created_at DESC LIMIT 1`,
    [userGestionId]
  );
  return r.rows[0] || null;
}

export async function addDocumentoCredito(creditoId, fileName, filePath, userId) {
  await query(
    `INSERT INTO module_rapidin_creditos_personal_docs (credito_id, type, file_name, file_path, uploaded_by)
     VALUES ($1, 'compromiso_pago', $2, $3, $4)`,
    [creditoId, fileName, filePath, userId || null]
  );
}

export async function approveCreditoPersonal(creditoId, userId) {
  const now = new Date().toISOString().slice(0, 10);
  await query(
    `UPDATE module_rapidin_creditos_personal SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'`,
    [creditoId]
  );
  await query(
    `UPDATE module_rapidin_creditos_personal_cuotas SET due_date = due_date + ($1::date - created_at::date) WHERE credito_id = $2`,
    [now, creditoId]
  );
  return getCreditoPersonalById(creditoId);
}

export async function getDocumentosCredito(creditoId) {
  const r = await query(
    `SELECT d.* FROM module_rapidin_creditos_personal_docs d
     WHERE d.credito_id = $1 ORDER BY d.created_at DESC`,
    [creditoId]
  );
  return r.rows;
}

export async function deleteDocumentoCredito(docId) {
  await query('DELETE FROM module_rapidin_creditos_personal_docs WHERE id = $1', [docId]);
}

export async function deleteCreditoPersonal(creditoId) {
  await query('DELETE FROM module_rapidin_creditos_personal_docs WHERE credito_id = $1', [creditoId]);
  await query('DELETE FROM module_rapidin_creditos_personal_cuotas WHERE credito_id = $1', [creditoId]);
  await query('DELETE FROM module_rapidin_creditos_personal WHERE id = $1', [creditoId]);
}

export async function generateCompromisoWord(creditoId) {
  const credito = await getCreditoPersonalById(creditoId);
  if (!credito) throw new Error('Crédito no encontrado');

  const workerName = `${credito.first_name} ${credito.last_name}`;
  const cuotas = credito.cuotas || [];
  const cuotaMensual = cuotas.length > 0 ? parseFloat(cuotas[0].installment_amount) : 0;
  const totalInteres = parseFloat(credito.total_amount) - parseFloat(credito.amount);
  const amount = parseFloat(credito.amount);

  const cuotaRows = cuotas.map((c, i) => {
    const d = new Date(c.due_date);
    const fecha = d.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
    return new TableRow({
      children: [
        new TableCell({ width: { size: 10, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: `${i + 1}`, alignment: AlignmentType.CENTER })] }),
        new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: `S/ ${parseFloat(c.installment_amount).toFixed(2)}`, alignment: AlignmentType.RIGHT })] }),
        new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: fecha, alignment: AlignmentType.LEFT })] }),
        new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: c.status === 'paid' ? 'Pagada' : 'Pendiente', alignment: AlignmentType.LEFT })] }),
      ],
    });
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: 'Constancia de préstamo a personal Yego', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
        new Paragraph({ spacing: { after: 300 }, children: [
          new TextRun({ text: 'El/La trabajador(a) ' }),
          new TextRun({ text: workerName, bold: true }),
          new TextRun({ text: `, identificado(a) con DNI N° ${credito.dni}, se hace constar que recibe el siguiente crédito personal bajo las siguientes condiciones:` }),
        ]}),

        new Paragraph({ spacing: { before: 300, after: 200 }, children: [new TextRun({ text: 'Condiciones del crédito', bold: true, size: 24 })], border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' } } }),

        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Monto solicitado: ', bold: true }), new TextRun({ text: `S/ ${amount.toFixed(2)}` })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Tasa de interés (TNA fija): ', bold: true }), new TextRun({ text: `${credito.interest_rate}% mensual` })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Plazo: ', bold: true }), new TextRun({ text: `${credito.number_of_installments} mes(es)` })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Interés total: ', bold: true }), new TextRun({ text: `S/ ${totalInteres.toFixed(2)}` })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Total a pagar: ', bold: true }), new TextRun({ text: `S/ ${parseFloat(credito.total_amount).toFixed(2)}` })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Cuota mensual: ', bold: true }), new TextRun({ text: `S/ ${cuotaMensual.toFixed(2)}` })] }),

        cuotas.length > 0 ? new Paragraph({ spacing: { before: 300, after: 200 }, children: [new TextRun({ text: 'Cronograma de pagos', bold: true, size: 24 })], border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' } } }) : new Paragraph({ text: '' }),

        ...(cuotas.length > 0 ? [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({ width: { size: 10, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: 'N°', bold: true, alignment: AlignmentType.CENTER })], shading: { fill: 'EEEEEE' } }),
                  new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: 'Monto', bold: true, alignment: AlignmentType.RIGHT })], shading: { fill: 'EEEEEE' } }),
                  new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: 'Vencimiento', bold: true, alignment: AlignmentType.LEFT })], shading: { fill: 'EEEEEE' } }),
                  new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: 'Estado', bold: true, alignment: AlignmentType.LEFT })], shading: { fill: 'EEEEEE' } }),
                ],
              }),
              ...cuotaRows,
            ],
          }),
        ] : []),

        new Paragraph({ spacing: { before: 500, after: 200 }, text: '_________________________', alignment: AlignmentType.CENTER }),
        new Paragraph({ spacing: { after: 50 }, children: [new TextRun({ text: workerName, bold: true })], alignment: AlignmentType.CENTER }),
        new Paragraph({ spacing: { after: 50 }, text: `DNI: ${credito.dni}`, alignment: AlignmentType.CENTER }),
        new Paragraph({ text: 'Trabajador(a)', alignment: AlignmentType.CENTER }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = `Compromiso_Pago_${workerName.replace(/\s+/g, '_')}_${credito.dni}.docx`;
  return { buffer, fileName };
}
