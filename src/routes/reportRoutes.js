import { Router } from "express";

import { protect } from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/roleMiddleware.js";
import { PERMISSIONS } from "../utils/constants.js";
import { validate } from "../middlewares/validate.js";
import {
  kardexValorizado,
  valorizacion,
  rotacion,
  ranking,
  margen,
  libroVentas,
  cuadres,
} from "../controllers/reportsController.js";
import {
  kardexValorizadoSchema,
  rotacionSchema,
  rankingSchema,
  margenSchema,
  libroVentasSchema,
  cuadresSchema,
} from "../validators/reportValidators.js";

const router = Router();

// Biblioteca de informes: TODO gateado con reports.read (gerente/admin).
const reports = requirePermission(PERMISSIONS.REPORTS_READ);

router.get("/kardex-valorizado", protect, reports, validate(kardexValorizadoSchema), kardexValorizado);
router.get("/valorizacion", protect, reports, valorizacion);
router.get("/rotacion", protect, reports, validate(rotacionSchema), rotacion);
router.get("/ranking", protect, reports, validate(rankingSchema), ranking);
router.get("/margen", protect, reports, validate(margenSchema), margen);
router.get("/libro-ventas", protect, reports, validate(libroVentasSchema), libroVentas);
router.get("/cuadres", protect, reports, validate(cuadresSchema), cuadres);

export default router;
