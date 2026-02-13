const sanitizeText = (text) => {
  if (!text) return '';
  return text.trim().replace(/[<>]/g, '');
};

export const sanitizeBody = (req, res, next) => {
  if (req.body) {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitizeText(req.body[key]);
      }
    });
  }
  next();
};

export const sanitizeQuery = (req, res, next) => {
  if (req.query) {
    Object.keys(req.query).forEach(key => {
      if (typeof req.query[key] === 'string') {
        req.query[key] = sanitizeText(req.query[key]);
      }
    });
  }
  next();
};

