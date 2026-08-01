import Module from "../models/Module.js";
import { NotFoundError } from "../utils/errors.js";
import { cacheGet, cacheSet, cacheClearPrefix } from "../utils/responseCache.js";

// El conteo de módulos activos lo consulta getTurnoBoard en CADA poll del
// tablero público (cada ~8s, varios clientes). El valor casi nunca cambia, así
// que se cachea con TTL corto y se invalida al crear/editar/eliminar módulos.
const ACTIVE_COUNT_KEY = "modules:active-count";

export const listModules = ({ activeOnly = false } = {}) =>
  Module.find(activeOnly ? { active: true } : {})
    .sort({ order: 1, created_at: 1 })
    .lean();

export const countActiveModules = async () => {
  const hit = cacheGet(ACTIVE_COUNT_KEY);
  if (hit != null) return hit;
  const n = await Module.countDocuments({ active: true });
  return cacheSet(ACTIVE_COUNT_KEY, n, 30000);
};

export const createModule = async ({ name }) => {
  const doc = await Module.create({ name: String(name).trim() });
  cacheClearPrefix("modules:");
  return doc.toObject();
};

export async function updateModule(id, patch) {
  const clean = {};
  if (patch.name != null) clean.name = String(patch.name).trim();
  if (patch.active != null) clean.active = !!patch.active;
  const m = await Module.findByIdAndUpdate(id, { $set: clean }, { new: true }).lean();
  if (!m) throw new NotFoundError("Módulo no encontrado");
  cacheClearPrefix("modules:");
  return m;
}

export async function removeModule(id) {
  const m = await Module.findByIdAndDelete(id).lean();
  if (!m) throw new NotFoundError("Módulo no encontrado");
  cacheClearPrefix("modules:");
  return m;
}
