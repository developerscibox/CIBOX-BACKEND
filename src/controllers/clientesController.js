import mongoose from "mongoose";

import { asyncHandler } from "../middlewares/errorHandler.js";
import { NotFoundError, ConflictError } from "../utils/errors.js";
import Cliente from "../models/Cliente.js";
import Deuda from "../models/Deuda.js";
import { logAudit } from "../utils/audit.js";
import {
  normalizeRut,
  hoySantiago,
  diasMora,
  estadoCredito,
  deudasPendientesDe,
  aplicarAbonoFIFO,
} from "../services/clienteService.js";

const actorLabel = (req) => req.user?.name || req.user?.email || "";

// GET /clientes → { items:[{ _id, razon_social, rut, credito, estado }], count }
export const listClientes = asyncHandler(async (req, res) => {
  const clientes = await Cliente.find({}).sort({ razon_social: 1 }).lean();
  const ids = clientes.map((c) => c._id);
  const deudas = ids.length
    ? await Deuda.find({
        estado: "pendiente",
        cliente_id: mongoose.trusted({ $in: ids }),
      }).lean()
    : [];

  const porCliente = new Map();
  for (const d of deudas) {
    const key = String(d.cliente_id);
    if (!porCliente.has(key)) porCliente.set(key, []);
    porCliente.get(key).push(d);
  }

  const hoy = hoySantiago();
  const items = clientes.map((c) => ({
    _id: c._id,
    razon_social: c.razon_social,
    rut: c.rut,
    credito: c.credito,
    estado: estadoCredito(c, porCliente.get(String(c._id)) || [], hoy),
  }));

  res.json({ success: true, data: { items, count: items.length } });
});

// POST /clientes → cliente (409 si el RUT ya existe)
export const createCliente = asyncHandler(async (req, res) => {
  const { razon_social, rut, contacto = {}, credito = {}, notas = "" } = req.body;
  const rutNorm = normalizeRut(rut);
  try {
    const cliente = await Cliente.create({
      razon_social,
      rut: rutNorm,
      contacto,
      credito,
      notas,
    });
    return res.status(201).json({ success: true, data: { cliente } });
  } catch (err) {
    if (err?.code === 11000) {
      throw new ConflictError(`Ya existe un cliente con RUT ${rutNorm}`);
    }
    throw err;
  }
});

// PATCH /clientes/:id — datos + crédito; linea/bloqueado quedan auditados.
export const updateCliente = asyncHandler(async (req, res) => {
  const cliente = await Cliente.findById(req.params.id);
  if (!cliente) throw new NotFoundError("Cliente no encontrado");

  const b = req.body;
  if (b.razon_social !== undefined) cliente.razon_social = b.razon_social;
  if (b.rut !== undefined) cliente.rut = normalizeRut(b.rut);
  if (b.notas !== undefined) cliente.notas = b.notas;
  if (b.activo !== undefined) cliente.activo = b.activo;
  if (b.contacto) {
    for (const k of ["nombre", "telefono", "email"]) {
      if (b.contacto[k] !== undefined) cliente.contacto[k] = b.contacto[k];
    }
  }

  const c = b.credito || {};
  if (c.habilitado !== undefined) cliente.credito.habilitado = c.habilitado;
  if (c.condicion_dias !== undefined) cliente.credito.condicion_dias = c.condicion_dias;
  if (c.dias_gracia !== undefined) cliente.credito.dias_gracia = c.dias_gracia;

  if (c.linea !== undefined && c.linea !== cliente.credito.linea) {
    logAudit({
      req,
      action: "credito.linea",
      target: `${cliente.razon_social} (${cliente.rut})`,
      detail: `línea $${cliente.credito.linea} → $${c.linea}`,
    });
    cliente.credito.linea = c.linea;
  }

  if (c.bloqueado !== undefined && c.bloqueado !== cliente.credito.bloqueado) {
    if (c.bloqueado) {
      cliente.credito.bloqueado = true;
      cliente.credito.bloqueo_motivo = c.bloqueo_motivo || "bloqueo manual";
      cliente.credito.bloqueado_en = new Date();
      cliente.credito.bloqueado_por = { label: actorLabel(req) };
    } else {
      cliente.credito.bloqueado = false;
      cliente.credito.bloqueo_motivo = "";
      cliente.credito.bloqueado_en = null;
      cliente.credito.bloqueado_por = { label: "" };
    }
    logAudit({
      req,
      action: "credito.bloqueo",
      target: `${cliente.razon_social} (${cliente.rut})`,
      detail: c.bloqueado
        ? `bloqueado: ${cliente.credito.bloqueo_motivo}`
        : "desbloqueado",
    });
  } else if (c.bloqueo_motivo !== undefined && cliente.credito.bloqueado) {
    cliente.credito.bloqueo_motivo = c.bloqueo_motivo;
  }

  try {
    await cliente.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw new ConflictError(`Ya existe un cliente con RUT ${cliente.rut}`);
    }
    throw err;
  }
  res.json({ success: true, data: { cliente } });
});

// GET /clientes/:id/estado-cuenta → ficha completa (documentos antiguo→nuevo).
export const estadoCuenta = asyncHandler(async (req, res) => {
  const cliente = await Cliente.findById(req.params.id).lean();
  if (!cliente) throw new NotFoundError("Cliente no encontrado");

  const deudas = await Deuda.find({ cliente_id: cliente._id })
    .sort({ fecha_vencimiento: 1, created_at: 1 })
    .lean();
  const hoy = hoySantiago();

  const documentos = deudas.map((d) => {
    const abonado = (d.abonos || []).reduce(
      (acc, a) => acc + (Math.round(Number(a.monto)) || 0),
      0,
    );
    return {
      _id: d._id,
      documento: d.documento,
      order_id: d.order_id || null,
      fecha_emision: d.fecha_emision || "",
      fecha_vencimiento: d.fecha_vencimiento,
      dias_mora: d.estado === "pendiente" ? diasMora(d.fecha_vencimiento, hoy) : 0,
      monto_original: d.monto_original != null ? d.monto_original : d.monto,
      abonado,
      saldo: d.monto,
      estado: d.estado,
    };
  });

  const pendientes = deudas.filter((d) => d.estado === "pendiente");
  const abonos_recientes = deudas
    .flatMap((d) =>
      (d.abonos || []).map((a) => ({
        fecha: a.fecha,
        monto: a.monto,
        documento: d.documento,
        by_label: a.by?.label || "",
      })),
    )
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 15);

  res.json({
    success: true,
    data: {
      cliente,
      estado: estadoCredito(cliente, pendientes, hoy),
      documentos,
      abonos_recientes,
    },
  });
});

// POST /clientes/:id/abono { monto, medio?, referencia? } → aplica FIFO.
export const abonoCliente = asyncHandler(async (req, res) => {
  const cliente = await Cliente.findById(req.params.id).lean();
  if (!cliente) throw new NotFoundError("Cliente no encontrado");

  const { monto, medio, referencia } = req.body;
  const resultado = await aplicarAbonoFIFO({
    clienteId: cliente._id,
    monto,
    medio,
    referencia,
    by: {
      user_id: req.user?.id || null,
      role: req.user?.role || null,
      label: actorLabel(req) || "cobranza",
    },
  });

  if (resultado.total_aplicado === 0) {
    throw new ConflictError("El cliente no tiene deudas pendientes");
  }

  res.json({ success: true, data: resultado });
});

// GET /clientes/buscar-rut/:rut (cajera) → { cliente, estado } | 404.
export const buscarPorRut = asyncHandler(async (req, res) => {
  const rutNorm = normalizeRut(req.params.rut);
  const cliente = await Cliente.findOne({ rut: rutNorm }).lean();
  if (!cliente) throw new NotFoundError("No existe un cliente con ese RUT");

  const pendientes = await deudasPendientesDe(cliente._id);
  res.json({
    success: true,
    data: {
      cliente: { _id: cliente._id, razon_social: cliente.razon_social, rut: cliente.rut },
      estado: estadoCredito(cliente, pendientes),
    },
  });
});

export default {
  listClientes,
  createCliente,
  updateCliente,
  estadoCuenta,
  abonoCliente,
  buscarPorRut,
};
