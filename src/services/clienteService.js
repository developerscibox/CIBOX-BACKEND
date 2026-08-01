import mongoose from "mongoose";

import Deuda from "../models/Deuda.js";
import { BadRequestError } from "../utils/errors.js";
import { withTransaction } from "../utils/transactions.js";

const MS_DIA = 86_400_000;

/**
 * Normaliza un RUT a "12345678-9" (sin puntos, DV en mayúscula).
 * NO valida — usar isValidRut (utils/rut.js) antes.
 */
export const normalizeRut = (rut) => {
  const clean = String(rut || "")
    .replace(/\./g, "")
    .replace(/-/g, "")
    .trim()
    .toUpperCase();
  if (clean.length < 2) return clean;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
};

/** Día actual en America/Santiago como "YYYY-MM-DD" (en-CA entrega ese formato). */
export const hoySantiago = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/**
 * Suma días calendario a una fecha "YYYY-MM-DD" (aritmética anclada a UTC para
 * que el string local Santiago no se corra un día). Para fecha_vencimiento.
 */
export const addDaysISO = (fechaISO, dias) => {
  const base = Date.parse(`${fechaISO}T00:00:00Z`);
  if (!Number.isFinite(base)) return fechaISO;
  return new Date(base + Math.round(Number(dias) || 0) * MS_DIA).toISOString().slice(0, 10);
};

/** Días de mora: max(0, hoy - fecha_vencimiento) en días calendario. */
export const diasMora = (fechaVencimiento, hoy = hoySantiago()) => {
  const a = Date.parse(`${String(fechaVencimiento || "")}T00:00:00Z`);
  const b = Date.parse(`${hoy}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / MS_DIA));
};

/**
 * Estado de crédito de un cliente frente a sus deudas pendientes.
 * Rojo si bloqueado o mora > dias_gracia; amarillo si mora > 0 o uso >= 80%.
 * motivo_rechazo: null | "bloqueado" | "mora" | "limite" | "deshabilitado".
 */
export const estadoCredito = (cliente, deudasPendientes = [], hoy = hoySantiago()) => {
  const credito = cliente?.credito || {};
  const linea = Math.max(0, Math.round(Number(credito.linea) || 0));
  const diasGracia = Math.max(0, Math.round(Number(credito.dias_gracia) || 0));

  const pendientes = (deudasPendientes || []).filter((d) => d && d.estado !== "pagada");
  const saldo = pendientes.reduce(
    (acc, d) => acc + Math.max(0, Math.round(Number(d.monto) || 0)),
    0,
  );
  const disponible = Math.max(0, linea - saldo);
  const uso_pct = linea > 0 ? Math.round((saldo / linea) * 100) : saldo > 0 ? 100 : 0;
  const max_mora_dias = pendientes.reduce(
    (acc, d) => Math.max(acc, diasMora(d.fecha_vencimiento, hoy)),
    0,
  );

  let puede_comprar = true;
  let motivo_rechazo = null;
  if (!credito.habilitado) {
    puede_comprar = false;
    motivo_rechazo = "deshabilitado";
  } else if (credito.bloqueado) {
    puede_comprar = false;
    motivo_rechazo = "bloqueado";
  } else if (max_mora_dias > diasGracia) {
    puede_comprar = false;
    motivo_rechazo = "mora";
  } else if (disponible <= 0) {
    puede_comprar = false;
    motivo_rechazo = "limite";
  }

  let semaforo = "verde";
  if (credito.bloqueado || max_mora_dias > diasGracia) semaforo = "rojo";
  else if (max_mora_dias > 0 || uso_pct >= 80) semaforo = "amarillo";

  return { saldo, disponible, uso_pct, max_mora_dias, semaforo, puede_comprar, motivo_rechazo };
};

/** Deudas pendientes de un cliente, más antigua primero (lean). */
export const deudasPendientesDe = (clienteId) =>
  Deuda.find({ cliente_id: clienteId, estado: "pendiente" })
    .sort({ fecha_vencimiento: 1, created_at: 1 })
    .lean();

/**
 * Aplica un abono FIFO sobre las deudas pendientes del cliente (documento más
 * antiguo primero). Misma mecánica que registrarAbono: clamp al saldo, snapshot
 * de monto_original en el primer abono, push a abonos[] con autor y nota del
 * medio/referencia, y marca "pagada" al llegar a 0.
 * La fecha de vencimiento NO cambia con abonos.
 */
export const aplicarAbonoFIFO = async ({ clienteId, monto, medio = "efectivo", referencia = "", by = {} }) => {
  const total = Math.round(Number(monto));
  if (!Number.isFinite(total) || total <= 0) {
    throw new BadRequestError("monto debe ser un número mayor a 0");
  }

  const nota = `${medio}${referencia ? ` (${referencia})` : ""}`;

  // Atómico: aplicar el abono a varias deudas es todo-o-nada. Además, en replica set
  // la transacción serializa (dos abonos concurrentes del mismo cliente chocan y uno
  // reintenta) → no hay doble abono ni abono perdido.
  return withTransaction(async (session) => {
    const pendientes = await Deuda.find({
      cliente_id: clienteId,
      estado: "pendiente",
      monto: mongoose.trusted({ $gt: 0 }),
    })
      .sort({ fecha_vencimiento: 1, created_at: 1 })
      .session(session);

    const aplicaciones = [];
    let restante = total;

    for (const deuda of pendientes) {
      if (restante <= 0) break;
      const saldoDoc = Math.max(0, Math.round(Number(deuda.monto) || 0));
      if (saldoDoc <= 0) continue;

      const aplicado = Math.min(restante, saldoDoc); // nunca deja saldo bajo 0
      if (deuda.monto_original == null) deuda.monto_original = saldoDoc;
      deuda.monto = saldoDoc - aplicado;
      deuda.abonos.push({
        fecha: new Date(),
        monto: aplicado,
        nota,
        by: { user_id: by.user_id || null, role: by.role || null, label: by.label || "" },
      });
      if (deuda.monto <= 0) {
        deuda.monto = 0;
        deuda.estado = "pagada";
      }
      await deuda.save({ session });

      restante -= aplicado;
      aplicaciones.push({ deuda_id: String(deuda._id), documento: deuda.documento, aplicado });
    }

    return { aplicaciones, sobrante: restante, total_aplicado: total - restante };
  });
};

export default {
  normalizeRut,
  hoySantiago,
  addDaysISO,
  diasMora,
  estadoCredito,
  deudasPendientesDe,
  aplicarAbonoFIFO,
};
