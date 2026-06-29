import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { verifyModule } from '../../middleware/permissions.js';
import solicitudesRouter from './miauto/solicitudes.js';
import cronogramasRouter from './miauto/cronogramas.js';
import cuotasRouter from './miauto/cuotas.js';
import comprobantesRouter from './miauto/comprobantes.js';
import otrosRouter from './miauto/otros.js';
import evidenciasRouter from './miauto/evidencias.js';
import whatsappRouter from './miauto/whatsapp.js';

const router = Router();
router.use(authenticate);
router.use(verifyModule('miauto'));

router.use((req, res, next) => {
  if (req.user?.id && req.method !== 'GET' && req.body && typeof req.body === 'object') {
    req.body.updated_by = req.user.id;
  }
  next();
});

router.use(solicitudesRouter);
router.use(cronogramasRouter);
router.use(cuotasRouter);
router.use(comprobantesRouter);
router.use(otrosRouter);
router.use(evidenciasRouter);
router.use(whatsappRouter);

export default router;
