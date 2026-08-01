import { env } from "../config/env.js";
import Product from "../models/Product.js";
import Vendor from "../models/Vendor.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { getRequestIdentity } from "../utils/ownership.js";
import { logger } from "../utils/logger.js";
import { sendEmail } from "../services/emailService.js";
import { emitDocumentForOrder } from "../services/siiService.js";
import {
  createWebpayTransaction as svcCreate,
  commitWebpayTransaction as svcCommit,
  handleWebpayReturn as svcHandleReturn,
} from "../services/paymentService.js";
import { findOrderForOwner } from "../services/orderService.js";
import { createShipmentForPaidOrder } from "../services/shippingService.js";
import { ORDER_STATUS, PAYMENT_STATUS } from "../utils/constants.js";
import { buildPaymentApprovedTemplate } from "../utils/emailTemplates.js";
import mongoose from "mongoose";

const sanitizeOrder = (order) =>
  order && typeof order.toJSON === "function" ? order.toJSON() : order;

const money = (value) => `$${Number(value || 0).toLocaleString("es-CL")}`;

const getReturnBase = (order) => {
  const platform = order?.payment?.platform;

  if (platform === "ios" || platform === "android") {
    return env.MOBILE_DEEP_LINK.replace(/\/$/, "");
  }

  return env.FRONTEND_URL.replace(/\/$/, "");
};

const buildSuccessUrl = (order) => {
  const base = getReturnBase(order);
  return `${base}/orders/success?orderId=${encodeURIComponent(order._id)}`;
};

const buildFailedUrl = (order, status = "rejected") => {
  const base = getReturnBase(order);
  return `${base}/orders/failed?orderId=${encodeURIComponent(
    order._id,
  )}&status=${encodeURIComponent(status)}`;
};

const sendPaymentApprovedEmail = async (order, taxDocument = null) => {
  if (!order?.customer?.email) return;

  try {
    const template = buildPaymentApprovedTemplate({ order, taxDocument });

    await sendEmail({
      to: order.customer.email,
      subject: template.subject,
      text: template.text,
      html: template.html,
    });
  } catch (err) {
    logger.warn(
      { err: err.message },
      "no se pudo enviar email de pago aprobado",
    );
  }
};

const emitTaxDocumentForPaidOrder = async (order) => {
  try {
    const document = await emitDocumentForOrder(order, "boleta");

    logger.info(
      {
        orderId: String(order._id),
        taxDocumentId: String(document._id),
        folio: document.folio,
        stub: document.stub,
      },
      "boleta emitida para orden pagada",
    );

    return document;
  } catch (err) {
    logger.error(
      {
        orderId: String(order?._id || ""),
        err: err.message,
      },
      "falló emisión de boleta",
    );

    return null;
  }
};

const getVendorEmailsFromOrder = async (order) => {
  const productIds = (order.items || [])
    .map((item) => item.product_id)
    .filter(Boolean)
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (!productIds.length) return [];

  // Usar collection directamente para evitar sanitizeFilter
  const products = await Product.collection
    .find({ _id: { $in: productIds } })
    .project({ vendor: 1 })
    .toArray();

  const vendorIds = [
    ...new Set(products.map((p) => p.vendor?.id).filter(Boolean)),
  ];

  if (!vendorIds.length) return [];

  const vendors = await Vendor.collection
    .find({ _id: { $in: vendorIds.map((id) => new mongoose.Types.ObjectId(String(id))) } })
    .toArray();

  const emails = [];

  for (const vendor of vendors) {
    if (vendor.email) emails.push(vendor.email);
    if (vendor.contact_email) emails.push(vendor.contact_email);

    if (vendor.user_id) {
      const user = await User.findById(vendor.user_id).select("email").lean();
      if (user?.email) emails.push(user.email);
    }
  }

  return [...new Set(emails.filter(Boolean))];
};

const sendInternalOrderNotificationEmail = async (order) => {
  const adminEmail = "soporte@cibox.cl";

  try {
    const vendorEmails = await getVendorEmailsFromOrder(order);
    const recipients = [...new Set([adminEmail, ...vendorEmails])];

    if (!recipients.length) return;

    const orderId = String(order._id || order.id || "");
    const shortOrder = orderId.slice(-8);
    const isCustomBox = order.source === "custom_box";

    const sourceText = isCustomBox
      ? "Tipo: Caja personalizada\n"
      : "";

    const sourceHtml = isCustomBox
      ? `<p style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 14px;color:#166534;font-weight:700;margin-bottom:16px;">📦 Caja personalizada — los productos fueron elegidos por el cliente</p>`
      : "";

    const itemsText = (order.items || [])
      .map((item) => {
        const isBox = item.product_type === "box";
        const label = isBox ? " [Caja]" : "";
        return `- ${item.name}${label} x${item.quantity} | Subtotal: ${money(item.subtotal)}`;
      })
      .join("\n");

    const itemsHtml = (order.items || [])
      .map((item) => {
        const isBox = item.product_type === "box";
        const label = isBox
          ? `<span style="font-size:11px;background:#fef9c3;color:#854d0e;border-radius:4px;padding:2px 6px;margin-left:6px;font-weight:700;">Caja</span>`
          : "";
        return `<li>${item.name}${label} x${item.quantity} — ${money(item.subtotal)}</li>`;
      })
      .join("");

    await sendEmail({
      to: recipients.join(","),
      subject: `Nueva compra pagada #${shortOrder}${isCustomBox ? " — Caja personalizada" : ""}`,
      text: `
Nueva compra confirmada en CIBOX.

Orden: ${orderId}
${sourceText}Cliente: ${order.customer?.fullName || "—"}
Email: ${order.customer?.email || "—"}
Teléfono: ${order.customer?.phone || "—"}
RUT: ${order.customer?.rut || "—"}

Productos:
${itemsText}

Subtotal: ${money(order.subtotal)}
Envío: ${money(order.shipping_amount)}
Descuento: ${money(order.discount_amount)}
Total pagado: ${money(order.total)}

Dirección:
${order.shipping?.address || "—"}, ${order.shipping?.city || "—"}, ${order.shipping?.region || "—"}
      `.trim(),
      html: `
        <h2>Nueva compra pagada en CIBOX</h2>
        <p><strong>Orden:</strong> ${orderId}</p>
        ${sourceHtml}

        <h3>Cliente</h3>
        <p><strong>Nombre:</strong> ${order.customer?.fullName || "—"}</p>
        <p><strong>Email:</strong> ${order.customer?.email || "—"}</p>
        <p><strong>Teléfono:</strong> ${order.customer?.phone || "—"}</p>
        <p><strong>RUT:</strong> ${order.customer?.rut || "—"}</p>

        <h3>Productos</h3>
        <ul>${itemsHtml}</ul>

        <h3>Totales</h3>
        <p><strong>Subtotal:</strong> ${money(order.subtotal)}</p>
        <p><strong>Envío:</strong> ${money(order.shipping_amount)}</p>
        <p><strong>Descuento:</strong> ${money(order.discount_amount)}</p>
        <p><strong>Total pagado:</strong> ${money(order.total)}</p>

        <h3>Dirección</h3>
        <p>${order.shipping?.address || "—"}, ${order.shipping?.city || "—"}, ${order.shipping?.region || "—"}</p>
      `,
    });
  } catch (err) {
    logger.warn(
      { orderId: String(order?._id || ""), err: err.message },
      "no se pudo enviar correo interno de nueva compra",
    );
  }
};

// Marca atómicamente el guard de idempotencia. Devuelve true solo la primera
// vez (cuando webhook_processed_at aún no estaba seteado), de modo que los
// side-effects de pago aprobado (boleta SII, emails, envío) corran una sola vez
// aunque el commit/return se procese más de una vez.
const claimApprovedSideEffects = async (order) => {
  const now = new Date();

  try {
    const result = await order.constructor.updateOne(
      { _id: order._id, "payment.side_effects_at": mongoose.trusted({ $in: [null, undefined] }) },
      { $set: { "payment.side_effects_at": now } },
    );

    const claimed = (result.modifiedCount || result.nModified || 0) > 0;

    if (claimed && order.payment) {
      order.payment.side_effects_at = now;
    }

    return claimed;
  } catch (err) {
    logger.error(
      { orderId: String(order?._id || ""), err: err.message },
      "no se pudo marcar guard de idempotencia de pago",
    );
    // Ante un error del guard, no re-disparamos efectos para evitar duplicados.
    return false;
  }
};

const handleApprovedOrderSideEffects = async (order) => {
  if (order?.payment?.side_effects_at) {
    logger.info(
      { orderId: String(order._id) },
      "side-effects de pago aprobado ya procesados, se omiten",
    );
    return;
  }

  const claimed = await claimApprovedSideEffects(order);

  if (!claimed) {
    logger.info(
      { orderId: String(order._id) },
      "side-effects de pago aprobado ya reclamados por otro proceso, se omiten",
    );
    return;
  }

  const taxDocument = await emitTaxDocumentForPaidOrder(order);

  sendPaymentApprovedEmail(order, taxDocument).catch(() => {});
  sendInternalOrderNotificationEmail(order).catch(() => {});

  try {
    await createShipmentForPaidOrder(order);
  } catch (err) {
    logger.error(
      { orderId: String(order._id), err: err.message },
      "createShipmentForPaidOrder falló",
    );
  }
};

export const createWebpayTransaction = asyncHandler(async (req, res) => {
  const identity = getRequestIdentity(req);
  identity.guestToken = req.body?.guestToken || null;

  const order = await findOrderForOwner({
    orderId: req.body.orderId,
    identity,
    includeGuestToken: true,
  });

  const data = await svcCreate({
    order,
    platform: req.body.platform,
  });

  return res.status(200).json({ success: true, data });
});

export const commitWebpayTransaction = asyncHandler(async (req, res) => {
  const { token } = req.body;

  const order = await svcCommit({ token });

  if (
    order?.status === ORDER_STATUS.PAID &&
    order?.payment?.status === PAYMENT_STATUS.APPROVED
  ) {
    await handleApprovedOrderSideEffects(order);
  }

  return res.status(200).json({
    success: true,
    data: sanitizeOrder(order),
  });
});

export const handleWebpayReturn = asyncHandler(async (req, res) => {
  const source = req.method === "GET" ? req.query : req.body;

  const token_ws = source.token_ws || source.token || source.TOKEN_WS;
  const TBK_TOKEN = source.TBK_TOKEN || source.tbk_token;
  const TBK_ORDEN_COMPRA = source.TBK_ORDEN_COMPRA || source.tbk_orden_compra;
  const TBK_ID_SESION = source.TBK_ID_SESION || source.tbk_id_sesion;

  if (!token_ws && !TBK_TOKEN) {
    return res.redirect(
      `${env.FRONTEND_URL.replace(/\/$/, "")}/orders/failed?status=error`,
    );
  }

  try {
    const result = await svcHandleReturn({
      token_ws,
      TBK_TOKEN,
      TBK_ORDEN_COMPRA,
      TBK_ID_SESION,
    });

    if (result.kind === "commit") {
      const order = result.order;

      if (
        order?.status === ORDER_STATUS.PAID &&
        order?.payment?.status === PAYMENT_STATUS.APPROVED
      ) {
        await handleApprovedOrderSideEffects(order);
        return res.redirect(buildSuccessUrl(order));
      }

      return res.redirect(buildFailedUrl(order, "rejected"));
    }

    if (
      result.kind === "abandoned" ||
      result.kind === "abandoned_already_paid"
    ) {
      const order = result.order;
      const status =
        result.kind === "abandoned_already_paid" ? "approved" : "cancelled";

      return res.redirect(buildFailedUrl(order, status));
    }

    return res.redirect(
      `${env.FRONTEND_URL.replace(
        /\/$/,
        "",
      )}/orders/failed?status=invalid_return`,
    );
  } catch (err) {
    logger.error({ err: err.message }, "WEBPAY_RETURN handler error");
    return res.redirect(
      `${env.FRONTEND_URL.replace(/\/$/, "")}/orders/failed?status=error`,
    );
  }
});
