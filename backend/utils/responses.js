export const successResponse = (res, data, message = 'Operación exitosa', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data
  });
};

export const errorResponse = (res, message = 'Error en la operación', statusCode = 400, details = null) => {
  const response = {
    success: false,
    message
  };

  if (details) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};

export const paginatedResponse = (res, data, page, limit, total) => {
  return res.json({
    success: true,
    data,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
};







