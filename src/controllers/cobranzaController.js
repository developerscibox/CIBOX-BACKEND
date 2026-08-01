import { asyncHandler } from "../middlewares/errorHandler.js";
import { BadRequestError, NotFoundError, ConflictError } from "../utils/errors.js";
import Deuda from "../models/Deuda.js";
import Cheque from "../models/Cheque.js";
import {
  agingCuentasPorCobrar,
  aQuienLlamarHoy,
  chequesPorVencer,
} from "../cobranza/aging.js";
import { diasMora } from "../services/clienteService.js";

const hoyISO = () => new Date().toISOString().slice(0, 10);

// Top 10 deudores: agrupa las deudas pendientes por cliente_id (o por el
// nombre snapshot para deudas legadas sin ficha de cliente).
const topDeudores = (deudas, hoy, limit = 10) => {
  const grupos = new Map();
  for (const d of deudas) {
    const key = d.cliente_id ? String(d.cliente_id) : `nombre:${d.cliente}`;
    const g = grupos.get(key) || {
      cliente_id: d.cliente_id ? String(d.cliente_id) : null,
      cliente: d.cliente,
      saldo: 0,
      max_mora_dias: 0,
      documentos: 0,
    };
    g.saldo += Math.round(Number(d.monto) || 0);
    g.max_mora_dias = Math.max(g.max_mora_dias, diasMora(d.fecha_vencimiento, hoy));
    g.documentos += 1;
    grupos.set(key, g);
  }
  return [...grupos.values()].sort((a, b) => b.saldo - a.saldo).slice(0, limit);
};

// GET /cobranza/resumen?hoy=YYYY-MM-DD → aging + a-quién-llamar + cheques por vencer
export const getResumen = asyncHandler(async (req, res) => {
  const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hoy) ? req.query.hoy : hoyISO();
  const [deudas, cheques] = await Promise.all([
    Deuda.find({ estado: "pendiente" }).lean(),
    Cheque.find({ estado: "en_cartera" }).lean(),
  ]);
  res.json({
    success: true,
    data: {
      hoy,
      aging: agingCuentasPorCobrar(deudas, hoy),
      llamarHoy: aQuienLlamarHoy(deudas, hoy).slice(0, 25),
      chequesPorVencer: chequesPorVencer(cheques, hoy, 10),
      top_deudores: topDeudores(deudas, hoy),
    },
  });
});

// PATCH /cobranza/deudas/:id/abono  body: { monto > 0 }
// Registra un pago parcial: descuenta del saldo (Deuda.monto, que es lo que lee
// el aging), guarda el abono con autor y marca "pagada" si el saldo llega a 0.
// El primer abono snapshotea monto_original. No permite saldo negativo: si el
// abono excede el saldo, se aplica solo hasta dejarlo en 0.
export const registrarAbono = asyncHandler(async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-fA-F0-9]{24}$/.test(id)) {
    throw new BadRequestError("id de deuda inválido");
  }
  const monto = Math.round(Number(req.body?.monto));
  if (!Number.isFinite(monto) || monto <= 0) {
    throw new BadRequestError("monto debe ser un número mayor a 0");
  }

  const deuda = await Deuda.findById(id);
  if (!deuda) throw new NotFoundError("Deuda no encontrada");
  if (deuda.estado === "pagada" || deuda.monto <= 0) {
    throw new ConflictError("La deuda ya está pagada");
  }

  const aplicado = Math.min(monto, deuda.monto); // nunca deja saldo bajo 0
  if (deuda.monto_original == null) deuda.monto_original = deuda.monto;
  deuda.monto -= aplicado;
  deuda.abonos.push({
    fecha: new Date(),
    monto: aplicado,
    by: {
      user_id: req.user?.id || null,
      role: req.user?.role || null,
      label: req.user?.email || "admin",
    },
  });
  if (deuda.monto <= 0) {
    deuda.monto = 0;
    deuda.estado = "pagada";
  }
  await deuda.save();

  res.json({
    success: true,
    data: {
      deuda: {
        id: String(deuda._id),
        cliente: deuda.cliente,
        documento: deuda.documento,
        fecha_vencimiento: deuda.fecha_vencimiento,
        saldo: deuda.monto,
        monto_original: deuda.monto_original,
        estado: deuda.estado,
        abonos: deuda.abonos,
      },
      abonado: aplicado,
    },
  });
});
