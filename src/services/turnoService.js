import mongoose from "mongoose";

import Turno from "../models/Turno.js";
import Counter from "../models/Counter.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { countActiveModules } from "./moduleService.js";
import { NotFoundError, ConflictError, BadRequestError } from "../utils/errors.js";
import { isValidRut, formatRut } from "../utils/rut.js";

// Día actual en America/Santiago como "YYYY-MM-DD" (en-CA ya entrega ese formato).
const santiagoDayKey = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

// Correlativo atómico por clave (un contador por día).
async function nextSeq(key) {
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc.seq;
}

const ACTIVE = ["waiting", "calling", "attending"];

// ── RUT (kiosko de autoatención) ─────────────────────────────────────────────
/** "12.345.678-9" / "123456789" → "12345678-9" (sin puntos, con guión). */
const normalizeRut = (rut) => {
  const clean = String(rut || "")
    .replace(/\./g, "")
    .replace(/-/g, "")
    .trim()
    .toUpperCase();
  if (clean.length < 2) return null;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
};

/**
 * Variantes de escritura del MISMO rut para buscar en datos históricos:
 * Order.customer.rut se guarda formateado ("12.345.678-9", formatRut) pero
 * User.rut se guarda tal como lo escribió el usuario (solo trim), así que se
 * cubren las tres formas típicas (+ dígito K en minúscula por registros viejos).
 */
const rutVariants = (rut) => {
  const norm = normalizeRut(rut);
  if (!norm) return [];
  const variants = new Set([norm, norm.replace("-", ""), formatRut(norm)]);
  for (const v of [...variants]) {
    if (v.endsWith("K")) variants.add(`${v.slice(0, -1)}k`);
  }
  return [...variants];
};

// Migración perezosa: (1) elimina el índice legado {day_key,number} ÚNICO — choca con
// las dos numeraciones (T-005 y P-005 comparten number=5 el mismo día); el nuevo
// {day_key,tipo,number} lo crea Mongoose desde el schema. (2) Si el deploy cae a MITAD
// de día, siembra el counter de la fila web con el máximo ya emitido hoy (los retiros
// viejos comparten day_key/tipo y su number no debe repetirse → evitaría E11000 y
// rompería el FIFO). Memoiza la PROMESA: los createTurno concurrentes esperan la
// migración real, y un fallo transitorio se reintenta en la request siguiente.
let _migracion = null;
function ensureTurnoIndexes() {
  _migracion ||= (async () => {
    try {
      await Turno.collection.dropIndex("day_key_1_number_1");
    } catch (e) {
      // 27 IndexNotFound / 26 NamespaceNotFound → ya no existe: migración lista.
      if (e?.code !== 27 && e?.code !== 26) { _migracion = null; throw e; }
    }
    try {
      const day_key = santiagoDayKey();
      const last = await Turno.findOne({ day_key, tipo: "retiro" }).sort({ number: -1 }).select("number").lean();
      // $max con upsert: idempotente y no retrocede un counter que ya avanzó.
      if (last?.number) await Counter.findByIdAndUpdate(`turno-${day_key}-web`, { $max: { seq: last.number } }, { upsert: true });
    } catch { /* best-effort: solo importa si el deploy cae a mitad de día */ }
  })();
  return _migracion;
}

/** Crea un turno nuevo para hoy. DOS FILAS con numeración propia por día:
 *  compra → "T-001…" (tienda) · retiro → "P-001…" (pedidos de internet). */
export async function createTurno({ name, tipo, rut } = {}) {
  // RUT opcional (kiosko): si viene, debe ser un RUT chileno válido (módulo 11).
  const rutNorm = rut ? normalizeRut(rut) : null;
  if (rut && (!rutNorm || !isValidRut(rutNorm))) throw new BadRequestError("RUT inválido");

  await ensureTurnoIndexes();
  const day_key = santiagoDayKey();
  const tipoNorm = tipo === "retiro" ? "retiro" : "compra";
  const number = await nextSeq(tipoNorm === "retiro" ? `turno-${day_key}-web` : `turno-${day_key}`);
  const code = (tipoNorm === "retiro" ? "P-" : "T-") + String(number).padStart(3, "0");
  const turno = await Turno.create({
    day_key,
    number,
    code,
    name: String(name || "").trim() || "Cliente",
    tipo: tipoNorm,
    rut: rutNorm,
  });
  return turno.toObject();
}

/** Estado de un turno + cuántos hay delante en la fila (si sigue esperando). */
export async function getTurnoById(id) {
  const turno = await Turno.findById(id).lean();
  if (!turno) throw new NotFoundError("Turno no encontrado");
  let ahead = 0;
  if (turno.status === "waiting") {
    // "Personas antes de ti" EN TU MISMA FILA (tienda e internet son colas aparte).
    ahead = await Turno.countDocuments({
      day_key: turno.day_key,
      status: "waiting",
      tipo: turno.tipo || "compra",
      number: mongoose.trusted({ $lt: turno.number }),
    });
  }
  return { ...turno, ahead };
}

/** Tablero PÚBLICO de atención: quién se atiende ahora y quién espera. */
export async function getTurnoBoard() {
  const day_key = santiagoDayKey();
  // La fila (Turno.find) es crítica; el conteo de módulos es cosmético
  // (solo decide si mostrar el módulo). allSettled: si el conteo falla, el
  // tablero igual se entrega; si la fila falla, sí propaga el error.
  const [tRes, mRes] = await Promise.allSettled([
    // Orden por LLEGADA real: number es correlativo POR FILA (T-002 de la tarde no
    // debe salir antes que P-050 de la mañana).
    Turno.find({ day_key, status: mongoose.trusted({ $in: ACTIVE }) })
      .sort({ created_at: 1 })
      .limit(100)
      .lean(),
    countActiveModules(),
  ]);
  if (tRes.status === "rejected") throw tRes.reason;
  const turnos = tRes.value;
  const activeModules = mRes.status === "fulfilled" ? mRes.value : 0;

  const fmt = (tn) => ({
    id: String(tn._id),
    code: tn.code,
    name: String(tn.name || "").trim().split(/\s+/)[0] || "Cliente",
    status: tn.status,
    module: tn.module || null,
    tipo: tn.tipo || "compra", // la Pantalla distingue "Compra" vs "Retiro"
  });

  return {
    attending: turnos.filter((tn) => tn.status === "calling" || tn.status === "attending").map(fmt),
    waiting: turnos.filter((tn) => tn.status === "waiting").map(fmt),
    // El cliente solo necesita saber el módulo si hay más de uno activo.
    multi_module: activeModules > 1,
  };
}

/** Lista para el panel del vendedor/caja (turnos activos de hoy, por llegada). */
export async function listActiveTurnos() {
  const day_key = santiagoDayKey();
  return Turno.find({ day_key, status: mongoose.trusted({ $in: ACTIVE }) })
    .sort({ created_at: 1 })
    .limit(200)
    .lean();
}

/** Llama al siguiente en espera (el de menor número). Atómico. null si fila vacía.
 *  `tipo` opcional filtra la fila: "compra" (tienda) o "retiro" (pedidos internet) —
 *  así la cajera llama su fila de internet y el vendedor la de tienda. */
export async function callNextTurno({ by, module, tipo } = {}) {
  const day_key = santiagoDayKey();
  // SIEMPRE se llama UNA fila (default tienda): sin esto, pantallas viejas que llaman
  // sin tipo mezclarían filas con numeraciones incomparables (P-001 nuevo le ganaría
  // a T-020 que espera hace una hora) y le "robarían" clientes de internet a la caja.
  const filtro = { day_key, status: "waiting", tipo: tipo === "retiro" ? "retiro" : "compra" };
  return Turno.findOneAndUpdate(
    filtro,
    {
      $set: {
        status: "calling",
        called_at: new Date(),
        called_by: by || null,
        module: module ? String(module).trim() : null,
      },
    },
    { sort: { number: 1 }, new: true },
  ).lean();
}

// Transición de estado con guarda (espejo ligero de VALID_TRANSITIONS de pedidos):
// solo avanza si el turno está en uno de los estados de origen permitidos, así un
// turno ya 'done'/'cancelled' (terminales) no puede reactivarse y reaparecer en el
// tablero. El update condicional evita además condiciones de carrera.
async function transition(id, newStatus, allowedFrom, extra = {}) {
  const turno = await Turno.findOneAndUpdate(
    { _id: id, status: mongoose.trusted({ $in: allowedFrom }) },
    { $set: { status: newStatus, ...extra } },
    { new: true },
  ).lean();
  if (turno) return turno;
  // No actualizó: distinguir inexistente (404) de estado no permitido (409).
  const exists = await Turno.exists({ _id: id });
  if (!exists) throw new NotFoundError("Turno no encontrado");
  throw new ConflictError("El turno ya no está en un estado que permita esa acción");
}

export const attendTurno = ({ id }) =>
  transition(id, "attending", ["waiting", "calling"], { attended_at: new Date() });

export const doneTurno = ({ id, order_id = null }) =>
  transition(id, "done", ["waiting", "calling", "attending"], {
    done_at: new Date(),
    ...(order_id ? { order_id } : {}),
  });

export const cancelTurno = ({ id }) =>
  transition(id, "cancelled", ["waiting", "calling", "attending"], { done_at: new Date() });

// ── Kiosko: pedidos de retiro activos por RUT ────────────────────────────────
// Estados que el kiosko considera "activos" (aún no retirados ni anulados).
const KIOSK_ORDER_STATUSES = ["pending", "paid", "preparing", "ready"];

const ESTADO_LABELS = {
  pending: "Por pagar",
  paid: "Pagado",
  preparing: "En preparación",
  ready: "Listo para retiro",
};

/**
 * Pedidos de RETIRO activos de un RUT (kiosko de autoatención, endpoint público).
 * El rut vive en dos lugares: Order.customer.rut (venta manual / relay / checkout)
 * y User.rut (perfil) → user_id; una sola query con $or une ambos caminos sin
 * duplicar. CERO PII: solo folio corto, estado, total, método y fecha comprometida.
 */
export async function getPedidosRetiroPorRut(rut) {
  const variants = rutVariants(rut);
  if (variants.length === 0) return [];

  const users = await User.find({ rut: mongoose.trusted({ $in: variants }) })
    .select("_id")
    .lean();

  const or = [{ "customer.rut": mongoose.trusted({ $in: variants }) }];
  if (users.length) {
    or.push({ user_id: mongoose.trusted({ $in: users.map((u) => u._id) }) });
  }

  const orders = await Order.find({
    delivery_method: "pickup",
    status: mongoose.trusted({ $in: KIOSK_ORDER_STATUSES }),
    $or: or,
  })
    .select("status total payment.method payment.status pickup.committed_date created_at")
    .sort({ created_at: -1 })
    .limit(5)
    .lean();

  return orders.map((o) => ({
    folio: String(o._id).slice(-6).toUpperCase(),
    estado: o.status,
    estado_label: ESTADO_LABELS[o.status] || o.status,
    total: o.total || 0,
    metodo: o.payment?.method || null,
    pagado: o.payment?.status === "approved",
    committed_date: o.pickup?.committed_date || null,
  }));
}
