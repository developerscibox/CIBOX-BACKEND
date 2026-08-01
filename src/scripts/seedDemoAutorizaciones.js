// Datos DEMO de Autorizaciones (anti-robo): solicitudes de anulación de boleta y de
// excepción de precio, LIGADAS a pedidos reales, para que la bandeja del jefe muestre
// pendientes y el Histórico muestre el registro inmutable (quién pidió qué, quién lo
// resolvió). Sin esto la pantalla sale vacía. CLI:  node src/scripts/seedDemoAutorizaciones.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/Order.js";
import Autorizacion from "../models/Autorizacion.js";

const folioDe = (o) => String(o._id).slice(-6).toUpperCase();
const backdate = (min) => new Date(Date.now() - min * 60000);

const SOL = [
  { label: "Carla (Caja 1)", role: "cashier" },
  { label: "María (Caja 2)", role: "cashier" },
  { label: "Ana (Caja 1)", role: "cashier" },
];
const JEFE = { label: "Don Pedro (Gerencia)" };

// hace_min = antigüedad de la solicitud; resuelto_hace = null si pendiente.
const SPECS = [
  { tipo: "anulacion", estado: "pendiente", hace_min: 4, detalle: "Cliente se arrepintió, boleta ya emitida" },
  { tipo: "precio", estado: "pendiente", hace_min: 9, detalle: "Aceite 12un a precio del cartel de la semana pasada", dctoPct: 12 },
  { tipo: "precio", estado: "aprobada", hace_min: 130, resuelto_hace: 122, nota: "OK, precio de campaña autorizado", dctoPct: 10 },
  { tipo: "anulacion", estado: "aprobada", hace_min: 200, resuelto_hace: 195, nota: "Autorizado, error de digitación" },
  { tipo: "precio", estado: "rechazada", hace_min: 300, resuelto_hace: 292, nota: "No corresponde ese descuento", dctoPct: 25 },
  { tipo: "anulacion", estado: "rechazada", hace_min: 420, resuelto_hace: 410, nota: "La mercadería ya salió, no se anula" },
  { tipo: "precio", estado: "aprobada", hace_min: 600, resuelto_hace: 590, nota: "Precio mayorista pactado con el cliente", dctoPct: 8 },
  { tipo: "anulacion", estado: "aprobada", hace_min: 900, resuelto_hace: 890, nota: "Doble cobro, se anula el duplicado" },
];

export async function seedDemoAutorizaciones({ orders = null } = {}) {
  // Capa operacional/demo: se reinicia para que la demo sea reproducible.
  await Autorizacion.deleteMany({});

  const list = orders && orders.length
    ? orders
    : await Order.find({}).sort({ created_at: -1 }).limit(30).select("_id total items").lean();
  if (!list.length) return { creados: 0 };

  let creados = 0;
  for (let i = 0; i < SPECS.length; i++) {
    const s = SPECS[i];
    const o = list[i % list.length];
    const it = (o.items || [])[0] || null;
    const precioActual = it ? (it.price || Math.round((it.subtotal || 0) / (it.quantity || 1)) || 1000) : 1000;
    const cambios = s.tipo === "precio" && it
      ? [{
          product_id: it.product_id,
          name: it.name || "Producto",
          cantidad: it.quantity || 1,
          precio_actual: precioActual,
          precio_propuesto: Math.max(1, Math.round(precioActual * (1 - (s.dctoPct || 10) / 100))),
        }]
      : [];

    const doc = await Autorizacion.create({
      tipo: s.tipo,
      order_id: o._id,
      folio: folioDe(o),
      monto: Math.round(Number(o.total || 0)),
      detalle: s.detalle || (s.tipo === "precio" ? "Excepción de precio" : "Anulación de boleta"),
      cambios,
      solicitante: SOL[i % SOL.length],
      estado: s.estado,
      resuelto_por: s.estado === "pendiente" ? { user_id: null, label: null } : JEFE,
      resuelto_en: s.estado === "pendiente" ? null : backdate(s.resuelto_hace),
      nota_resolucion: s.estado === "pendiente" ? null : (s.nota || null),
    });
    // Backdate del created_at (timestamps lo fija a "ahora" en el create).
    await Autorizacion.collection.updateOne({ _id: doc._id }, { $set: { created_at: backdate(s.hace_min) } });
    creados++;
  }

  return { creados };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/seedDemoAutorizaciones.js")) {
  dotenv.config();
  mongoose.connect(process.env.MONGO_URI)
    .then(() => seedDemoAutorizaciones())
    .then((r) => { console.log(`🛡️  Autorizaciones demo: ${r.creados} solicitudes (pendientes + histórico)`); process.exit(0); })
    .catch((e) => { console.error("❌", e); process.exit(1); });
}
