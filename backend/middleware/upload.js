import multer from 'multer';
import path from 'path';

// Configurar almacenamiento en memoria para multer
const storage = multer.memoryStorage();

// Configurar filtro de archivos (solo imágenes y PDFs)
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos JPEG, PNG o PDF'));
  }
};

export const uploadVoucher = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB máximo
  },
  fileFilter: fileFilter
});




