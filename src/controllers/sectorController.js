import { asyncHandler } from "../middlewares/errorHandler.js";
import Sector from "../models/Sector.js";

// GET /sectores → sectores ordenados por recorrido (cualquier rol WMS).
export const listSectores = asyncHandler(async (req, res) => {
  const sectores = await Sector.find({}).sort({ orden: 1, nombre: 1 }).lean();
  return res.status(200).json({ success: true, data: { sectores } });
});

// PUT /sectores { sectores:[{nombre, orden, activo?}] } → reconfigura recorrido (products.manage).
export const upsertSectores = asyncHandler(async (req, res) => {
  const arr = Array.isArray(req.body?.sectores) ? req.body.sectores : [];
  for (const s of arr) {
    const nombre = String(s.nombre || "").trim();
    if (!nombre) continue;
    await Sector.updateOne(
      { nombre },
      { $set: { orden: Number(s.orden) || 0, activo: s.activo !== false } },
      { upsert: true },
    );
  }
  const sectores = await Sector.find({}).sort({ orden: 1, nombre: 1 }).lean();
  return res.status(200).json({ success: true, data: { sectores } });
});

export default { listSectores, upsertSectores };
