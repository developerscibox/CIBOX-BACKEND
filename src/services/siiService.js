import crypto from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { TaxDocument } from "../models/TaxDocument.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { isValidRut } from "../utils/rut.js";
import mongoose from "mongoose";
import { brand } from "../config/brand.js";
const computeIvaBreakdown = (total) => {
  const t = Number(total || 0);
  // Los precios del catálogo van CON IVA incluido (brand.legal.precios_con_iva).
  const neto = Math.round(t / (1 + brand.legal.iva_pct / 100));
  const iva = t - neto;
  return { neto, iva };
};
const buildStubFolio = () => {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(3).toString("hex");
  return `STUB-${ts}-${rnd}`.toUpperCase();
};

const isValidType = (type) => type === "boleta" || type === "factura";

// Crea el documento tributario; si el índice único parcial (order_id,type) rechaza
// por una emisión concurrente (E11000), devuelve el documento activo existente en
// vez de fallar. Retorna SIEMPRE un objeto plano.
const createTaxDocOrExisting = async (payload, orderId, type) => {
  try {
    const doc = await TaxDocument.create(payload);
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await TaxDocument.collection.findOne({
        order_id: new mongoose.Types.ObjectId(String(orderId)),
        type,
        status: { $in: ["pending", "accepted"] },
      });
      if (existing) {
        logger.warn({ order_id: String(orderId), type }, "sii.emit.dup_concurrente — se devuelve el documento existente");
        return existing;
      }
    }
    throw err;
  }
};

export const emitDocumentForOrder = async (order, type = "boleta") => {
  if (!order || !order._id) throw new BadRequestError("Orden inválida");
  if (!isValidType(type))
    throw new BadRequestError(`Tipo de documento inválido: ${type}`);

  // Idempotencia: si ya existe documento aceptado para esta orden y tipo, retornarlo
  const existing = await TaxDocument.collection.findOne({
    order_id: new mongoose.Types.ObjectId(String(order._id)),
    type,
    status: { $in: ["pending", "accepted"] },
  });
  if (existing) return existing;

  // La boleta debe reflejar el monto REALMENTE cobrado (order.payment.amount tras
  // commit Webpay), no solo order.total. Si hay pago confirmado y diverge del
  // total, se advierte (no debería ocurrir tras la reconciliación de montos).
  const total = Number(order.total || 0);
  const paidAmount = Number(order.payment?.amount || 0);
  const fiscalAmount = paidAmount > 0 ? paidAmount : total;
  if (paidAmount > 0 && paidAmount !== total) {
    logger.warn(
      { order_id: String(order._id), total, paidAmount },
      "sii.emit.amount_mismatch — la boleta usa el monto cobrado",
    );
  }
  const { neto, iva } = computeIvaBreakdown(fiscalAmount);

  // Validar/normalizar el RUT receptor: no emitir con un RUT inválido.
  const rawRut = String(order.customer?.rut || "").trim();
  const validRut = rawRut && isValidRut(rawRut) ? rawRut : "";
  if (rawRut && !validRut) {
    logger.warn(
      { order_id: String(order._id) },
      "sii.emit.rut_invalido — receptor emitido sin RUT",
    );
  }

  if (!env.SII_ENABLED) {
    logger.warn(
      { order_id: String(order._id), type, sii_enabled: false },
      "sii.emit.stub",
    );

    const folio = buildStubFolio();
    const doc = await createTaxDocOrExisting({
      order_id: order._id,
      type,
      folio,
      rut_receptor: validRut,
      razon_social: order.customer?.fullName || "",
      total: fiscalAmount,
      neto,
      iva,
      xml_url: null,
      pdf_url: null,
      sii_track_id: `stub-${folio}`,
      status: "accepted",
      stub: true,
      emitted_at: new Date(),
    }, order._id, type);

    return { ...doc, stub: true };
  }

  // TODO: integración real con proveedor SII (openfactura, dteservice, etc.)
  // Estructura preparada para cuando se habilite:
  // 1. Construir XML del DTE según schema SII
  // 2. Firmar con certificado (env.SII_CERT_PATH / env.SII_CERT_PASSWORD)
  // 3. Enviar a SII / proveedor
  // 4. Esperar TrackId y consultar estado
  // 5. Generar PDF
  // 6. Guardar URLs y folio definitivo
  logger.error(
    { order_id: String(order._id), type },
    "sii.emit.real_integration_not_implemented",
  );

  const doc = await createTaxDocOrExisting({
    order_id: order._id,
    type,
    folio: null,
    rut_receptor: order.billing?.rut || validRut,
    razon_social:
      order.billing?.razon_social || order.shipping?.full_name || order.customer?.fullName || "",
    total: fiscalAmount,
    neto,
    iva,
    status: "pending",
    stub: false,
    emitted_at: new Date(),
  }, order._id, type);
  return doc;
};

export const voidDocument = async (folio) => {
  if (!folio) throw new BadRequestError("Folio requerido");
  const doc = await TaxDocument.findOne({ folio });
  if (!doc) throw new NotFoundError("Documento no encontrado");

  if (doc.status === "voided") return doc.toObject();

  if (!env.SII_ENABLED) {
    logger.warn({ folio, stub: true }, "sii.void.stub");
    doc.status = "voided";
    await doc.save();
    return { ...doc.toObject(), stub: true };
  }

  // TODO: anulación real ante SII / proveedor
  logger.error({ folio }, "sii.void.real_integration_not_implemented");
  doc.status = "voided";
  await doc.save();
  return doc.toObject();
};
