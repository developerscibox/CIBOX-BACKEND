// Datos DEMO de Clientes + Cobranza COHERENTES: crea documentos Cliente reales
// (maestro de crédito) y sus Deudas LIGADAS por cliente_id, para que la pantalla
// "Clientes · Crédito" muestre el perfil con facturas/estado de cuenta y la de
// Cobranza muestre el aging. Antes solo se creaban deudas huérfanas (sin cliente_id)
// y por eso Clientes salía vacío. Idempotente por cliente (upsert por RUT + reemplaza
// sus deudas). Reutilizable como función o CLI:  node src/scripts/seedDemoCobranza.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import Cliente from "../models/Cliente.js";
import Deuda from "../models/Deuda.js";
import Cheque from "../models/Cheque.js";

// Dígito verificador RUT (módulo 11) para generar RUTs válidos y coherentes.
const dvDe = (bodyNum) => {
  const body = String(bodyNum);
  let sum = 0, mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? "0" : r === 10 ? "K" : String(r);
};
const rut = (bodyNum) => `${bodyNum}-${dvDe(bodyNum)}`;

const ymd = (offDays) => {
  const x = new Date();
  x.setDate(x.getDate() + offDays);
  return x.toISOString().slice(0, 10);
};
const fechaDe = (offDays) => { const x = new Date(); x.setDate(x.getDate() + offDays); return x; };

// Clientes demo. `_deudas`: { suf, vencOff (días al vencimiento; negativo=vencida),
// original, abonado }. La emisión se deriva restando la condición al vencimiento.
const CLIENTES = [
  {
    razon_social: "Minimarket La Esquina SpA", rut: rut(76123456),
    contacto: { nombre: "Rosa Pérez", telefono: "+56 9 6123 4578", email: "laesquina@demo.cl" },
    credito: { habilitado: true, linea: 600000, condicion_dias: 30, dias_gracia: 7 },
    _deudas: [
      { suf: "A1B2C3", vencOff: 5, original: 180000, abonado: 60000 },
      { suf: "D4E5F6", vencOff: 20, original: 120000, abonado: 0 },
    ],
  },
  {
    razon_social: "Almacén Doña Rosa Ltda", rut: rut(77987654),
    contacto: { nombre: "Manuel Rojas", telefono: "+56 9 7712 3390", email: "" },
    credito: { habilitado: true, linea: 400000, condicion_dias: 15, dias_gracia: 5 },
    _deudas: [
      { suf: "11AA22", vencOff: 8, original: 150000, abonado: 0 },
      { suf: "33BB44", vencOff: -3, original: 200000, abonado: 0 },
    ],
  },
  {
    razon_social: "Distribuidora Sur Comercial", rut: rut(78555111),
    contacto: { nombre: "Patricia Díaz", telefono: "+56 9 5551 1120", email: "ventas@dsur.cl" },
    credito: { habilitado: true, linea: 1500000, condicion_dias: 60, dias_gracia: 10 },
    _deudas: [
      { suf: "55CC66", vencOff: 30, original: 800000, abonado: 0 },
      { suf: "77DD88", vencOff: 10, original: 500000, abonado: 200000 },
    ],
  },
  {
    razon_social: "Kiosco Central EIRL", rut: rut(76222333),
    contacto: { nombre: "Iván Muñoz", telefono: "+56 9 2223 3345", email: "" },
    credito: { habilitado: true, linea: 400000, condicion_dias: 30, dias_gracia: 7, bloqueado: true, bloqueo_motivo: "Mora reiterada" },
    _deudas: [
      { suf: "99EE00", vencOff: -30, original: 250000, abonado: 0 },
      { suf: "AABBCC", vencOff: -60, original: 140000, abonado: 0 },
    ],
  },
  {
    razon_social: "Abarrotes Don Manuel", rut: rut(77444555),
    contacto: { nombre: "Manuel Soto", telefono: "+56 9 4445 5567", email: "donmanuel@demo.cl" },
    credito: { habilitado: true, linea: 800000, condicion_dias: 30, dias_gracia: 7 },
    _deudas: [
      { suf: "DDEEFF", vencOff: -20, original: 300000, abonado: 300000 },
      { suf: "GG11HH", vencOff: 12, original: 200000, abonado: 0 },
    ],
  },
  {
    razon_social: "Supermercado Familiar Ñuñoa", rut: rut(78123999),
    contacto: { nombre: "Camila Toro", telefono: "+56 9 1239 9987", email: "familiar@demo.cl" },
    credito: { habilitado: true, linea: 1000000, condicion_dias: 60, dias_gracia: 7 },
    _deudas: [
      { suf: "II22JJ", vencOff: -15, original: 400000, abonado: 0 },
      { suf: "KK33LL", vencOff: 25, original: 300000, abonado: 0 },
    ],
  },
  {
    razon_social: "Botillería El Sol", rut: rut(76998877),
    contacto: { nombre: "Jorge Rivas", telefono: "+56 9 9988 7765", email: "" },
    credito: { habilitado: false },
    _deudas: [],
  },
  {
    razon_social: "Comercial Rincón Andino", rut: rut(77335588),
    contacto: { nombre: "Susana Silva", telefono: "+56 9 3355 8890", email: "" },
    credito: { habilitado: false },
    _deudas: [],
  },
];

const CHEQUES = [
  { cliente: "Minimarket La Esquina SpA", numero: "CH-7781", banco: "BancoEstado", monto: 120000, fecha_vencimiento: ymd(2) },
  { cliente: "Distribuidora Sur Comercial", numero: "CH-9032", banco: "Santander", monto: 300000, fecha_vencimiento: ymd(6) },
  { cliente: "Kiosco Central EIRL", numero: "CH-1145", banco: "BCI", monto: 250000, fecha_vencimiento: ymd(25) },
];

export async function seedDemoCobranza() {
  let clientesCreados = 0, deudasCreadas = 0;

  for (const c of CLIENTES) {
    const credito = {
      habilitado: !!c.credito.habilitado,
      linea: c.credito.linea || 0,
      condicion_dias: c.credito.condicion_dias ?? 30,
      dias_gracia: c.credito.dias_gracia ?? 7,
      bloqueado: !!c.credito.bloqueado,
      bloqueo_motivo: c.credito.bloqueo_motivo || "",
      ...(c.credito.bloqueado ? { bloqueado_en: new Date(), bloqueado_por: { label: "Gerencia (demo)" } } : {}),
    };
    // Upsert del cliente por RUT (idempotente). notas="DEMO" marca el origen.
    await Cliente.updateOne(
      { rut: c.rut },
      { $set: { razon_social: c.razon_social, contacto: c.contacto, credito, activo: true, notas: "DEMO" } },
      { upsert: true },
    );
    const cli = await Cliente.findOne({ rut: c.rut }).select("_id razon_social credito").lean();
    clientesCreados++;

    // Reemplaza las deudas de ESTE cliente (idempotente, sin tocar las de otros).
    await Deuda.deleteMany({ cliente_id: cli._id });
    const cond = credito.condicion_dias;
    for (const d of c._deudas) {
      const saldo = Math.max(0, d.original - (d.abonado || 0));
      const pagada = saldo <= 0;
      const emisionOff = d.vencOff - cond;
      const abonos = (d.abonado || 0) > 0
        ? [{
            fecha: fechaDe(Math.min(-1, emisionOff + Math.round(cond / 2))),
            monto: d.abonado,
            nota: "Abono demo (transferencia)",
            by: { user_id: null, role: "cashier", label: "Bea (cobranza)" },
          }]
        : [];
      await Deuda.create({
        cliente: cli.razon_social,
        cliente_id: cli._id,
        order_id: null,
        documento: `FCR-${d.suf}`,
        fecha_emision: ymd(emisionOff),
        fecha_vencimiento: ymd(d.vencOff),
        monto: saldo,
        monto_original: (d.abonado || 0) > 0 ? d.original : null,
        abonos,
        estado: pagada ? "pagada" : "pendiente",
      });
      deudasCreadas++;
    }
  }

  for (const ch of CHEQUES) {
    await Cheque.updateOne({ numero: ch.numero }, { $set: { ...ch, estado: "en_cartera" } }, { upsert: true });
  }

  return { clientes: clientesCreados, deudas: deudasCreadas, cheques: CHEQUES.length };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/seedDemoCobranza.js")) {
  dotenv.config();
  mongoose.connect(process.env.MONGO_URI)
    .then(() => seedDemoCobranza())
    .then((r) => { console.log(`💸 Cobranza demo: ${r.clientes} clientes + ${r.deudas} deudas (ligadas) + ${r.cheques} cheques`); process.exit(0); })
    .catch((e) => { console.error("❌", e); process.exit(1); });
}
