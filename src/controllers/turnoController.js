import { asyncHandler } from "../middlewares/errorHandler.js";
import * as turnoSvc from "../services/turnoService.js";
import * as moduleSvc from "../services/moduleService.js";

/** POST /turnos (PÚBLICO, QR/kiosko) → el cliente saca su número (con motivo). */
export const createTurnoPublic = asyncHandler(async (req, res) => {
  const turno = await turnoSvc.createTurno({
    name: req.body.name,
    tipo: req.body.tipo,
    rut: req.body.rut,
  });
  // Sin rut en la respuesta: endpoint público (el rut solo lo ven los admin).
  res.status(201).json({
    success: true,
    data: {
      id: String(turno._id),
      code: turno.code,
      number: turno.number,
      status: turno.status,
      tipo: turno.tipo,
    },
  });
});

/** GET /turnos/board (PÚBLICO) → atención en curso + fila de espera. */
export const turnoBoard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await turnoSvc.getTurnoBoard() });
});

/**
 * GET /turnos/:id (PÚBLICO) → estado del turno propio (para "sigue tu proceso").
 * No expone el nombre: el endpoint es público por ObjectId (sin token) y el
 * nombre completo sería PII/IDOR. La página lo muestra desde su localStorage.
 */
export const turnoStatus = asyncHandler(async (req, res) => {
  const turno = await turnoSvc.getTurnoById(req.params.id);
  res.json({
    success: true,
    data: {
      id: String(turno._id),
      code: turno.code,
      status: turno.status,
      ahead: turno.ahead,
      tipo: turno.tipo || "compra",
    },
  });
});

/**
 * GET /turnos/pedidos-por-rut/:rut (PÚBLICO, kiosko de autoatención).
 * Pedidos de retiro ACTIVOS del RUT, sin PII (ni nombre, ni dirección, ni _id).
 */
export const pedidosPorRut = asyncHandler(async (req, res) => {
  const pedidos = await turnoSvc.getPedidosRetiroPorRut(req.params.rut);
  res.json({ success: true, data: { pedidos } });
});

/** GET /turnos/admin → turnos activos de hoy (panel del vendedor). */
export const listTurnos = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { items: await turnoSvc.listActiveTurnos() } });
});

/** POST /turnos/admin/call-next → llama al siguiente en espera (con módulo y fila
 *  opcionales: tipo "compra"=tienda / "retiro"=pedidos internet). */
export const callNext = asyncHandler(async (req, res) => {
  const turno = await turnoSvc.callNextTurno({ by: req.user?.id, module: req.body?.module, tipo: req.body?.tipo });
  res.json({ success: true, data: { turno } }); // turno = null si la fila está vacía
});

export const attend = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { turno: await turnoSvc.attendTurno({ id: req.params.id }) } });
});

export const done = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { turno: await turnoSvc.doneTurno({ id: req.params.id }) } });
});

export const cancel = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { turno: await turnoSvc.cancelTurno({ id: req.params.id }) } });
});

// ── Módulos de atención (config) ─────────────────────────────────────────────
/** GET /turnos/modules?active=1 → lista de módulos (la usa Venta Manual para elegir). */
export const listModules = asyncHandler(async (req, res) => {
  const items = await moduleSvc.listModules({ activeOnly: req.query.active === "1" });
  res.json({ success: true, data: { items } });
});

export const createModule = asyncHandler(async (req, res) => {
  const module = await moduleSvc.createModule({ name: req.body.name });
  res.status(201).json({ success: true, data: { module } });
});

export const updateModule = asyncHandler(async (req, res) => {
  const module = await moduleSvc.updateModule(req.params.id, req.body);
  res.json({ success: true, data: { module } });
});

export const removeModule = asyncHandler(async (req, res) => {
  await moduleSvc.removeModule(req.params.id);
  res.json({ success: true, data: { deleted: true } });
});
