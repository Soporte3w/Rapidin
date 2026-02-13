export const getLoanProposalMessage = (driverName, loanAmount, weeklyInstallment, weeks, firstPaymentDate) => {
  return `Hola ${driverName},

Tu solicitud de préstamo ha sido aprobada.

Detalles del préstamo:
- Monto: ${loanAmount}
- Cuota semanal: ${weeklyInstallment}
- Número de semanas: ${weeks}
- Primera cuota: ${firstPaymentDate}

Por favor, revisa los detalles y procede con la firma del contrato.

Saludos,
Equipo Yego Rapidín`;
};

export const getLoanRejectionMessage = (driverName, reason) => {
  return `Hola ${driverName},

Lamentamos informarte que tu solicitud de préstamo ha sido rechazada.

Motivo: ${reason}

Si tienes preguntas, por favor contáctanos.

Saludos,
Equipo Yego Rapidín`;
};

export const getDisbursementMessage = (driverName, amount, date) => {
  return `Hola ${driverName},

Tu préstamo ha sido desembolsado exitosamente.

Monto: ${amount}
Fecha: ${date}

El dinero debería estar disponible en tu cuenta en las próximas horas.

Saludos,
Equipo Yego Rapidín`;
};

export const getPaymentConfirmationMessage = (driverName, amount, reference) => {
  return `Hola ${driverName},

Hemos recibido tu pago.

Monto: ${amount}
Referencia: ${reference}

Gracias por tu pago puntual.

Saludos,
Equipo Yego Rapidín`;
};

export const getPaymentReminderMessage = (driverName, installmentNumber, amount, dueDate) => {
  return `Hola ${driverName},

Recordatorio: Tu cuota #${installmentNumber} está próxima a vencer.

Monto: ${amount}
Fecha de vencimiento: ${dueDate}

Por favor, realiza el pago antes de la fecha de vencimiento para evitar cargos adicionales.

Saludos,
Equipo Yego Rapidín`;
};

export const getOverdueMessage = (driverName, installmentNumber, amount, daysOverdue) => {
  return `Hola ${driverName},

Tu cuota #${installmentNumber} está vencida.

Monto: ${amount}
Días de atraso: ${daysOverdue}

Por favor, realiza el pago lo antes posible para evitar cargos adicionales.

Saludos,
Equipo Yego Rapidín`;
};







