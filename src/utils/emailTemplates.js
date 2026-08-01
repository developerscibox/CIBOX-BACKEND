/**
 * Plantillas HTML/text para emails transaccionales.
 * Toda interpolación pasa por escapeHtml para evitar inyección.
 */

export const escapeHtml = (str) => {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const escapeAttr = (str) => escapeHtml(str);

const baseLayout = (innerHtml) => `
  <div style="font-family: Arial, sans-serif; color: #111; max-width: 600px; margin: 0 auto;">
    ${innerHtml}
  </div>
`;

const button = (href, label) => `
  <p>
    <a href="${escapeAttr(href)}"
       style="display:inline-block;padding:12px 20px;background:#4E9B27;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">
      ${escapeHtml(label)}
    </a>
  </p>
`;

export const buildVerificationTemplate = ({ name, verifyUrl }) => {
  const safeName = escapeHtml(name || "");
  const safeUrl = escapeHtml(verifyUrl);
  return {
    subject: "Verifica tu correo en CIBOX",
    text: `Hola ${name || ""}, verifica tu correo aquí: ${verifyUrl}`,
    html: baseLayout(`
      <h2>Verifica tu correo</h2>
      <p>Hola <strong>${safeName}</strong>, gracias por registrarte en CIBOX.</p>
      <p>Para activar tu cuenta, haz click en el siguiente botón:</p>
      ${button(verifyUrl, "Verificar correo")}
      <p>Si el botón no funciona, copia y pega este enlace:</p>
      <p>${safeUrl}</p>
    `),
  };
};

export const buildResetPasswordTemplate = ({ name, resetUrl }) => {
  const safeName = escapeHtml(name || "");
  const safeUrl = escapeHtml(resetUrl);
  return {
    subject: "Restablece tu contraseña en CIBOX",
    text: `Hola ${name || ""}, restablece tu contraseña aquí: ${resetUrl}`,
    html: baseLayout(`
      <h2>Restablecer contraseña</h2>
      <p>Hola <strong>${safeName}</strong>.</p>
      <p>Recibimos una solicitud para restablecer tu contraseña.</p>
      ${button(resetUrl, "Crear nueva contraseña")}
      <p>Si no solicitaste este cambio, puedes ignorar este correo.</p>
      <p>Si el botón no funciona, copia y pega este enlace:</p>
      <p>${safeUrl}</p>
    `),
  };
};

const money = (value) => `$${Number(value || 0).toLocaleString("es-CL")}`;

const formatDate = (date) =>
  date
    ? new Date(date).toLocaleString("es-CL", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

export const buildPaymentApprovedTemplate = ({ order, taxDocument = null }) => {
  const customer = order.customer || {};
  const shipping = order.shipping || {};
  const payment = order.payment || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const isCustomBox = order.source === "custom_box";

  const orderId = String(order._id || order.id || "");
  const shortOrder = orderId.slice(-8);

  const taxText = taxDocument
    ? `\nDocumento tributario:\nTipo: ${taxDocument.type || "boleta"}\nFolio: ${taxDocument.folio || "—"}\nEstado: ${taxDocument.status || "—"}\n${taxDocument.stub ? "Modo integración: documento de prueba, no válido tributariamente." : ""}`
    : "";

  const taxHtml = taxDocument
    ? `
      <h3>Documento tributario</h3>
      <p><strong>Tipo:</strong> ${escapeHtml(taxDocument.type || "boleta")}</p>
      <p><strong>Folio:</strong> ${escapeHtml(taxDocument.folio || "—")}</p>
      <p><strong>Estado:</strong> ${escapeHtml(taxDocument.status || "—")}</p>
      ${taxDocument.stub ? `<p style="color:#92400e;"><strong>Modo integración:</strong> documento de prueba, no válido tributariamente.</p>` : ""}
    `
    : "";

  const sourceLabel = isCustomBox
    ? `<p style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 14px;color:#166534;font-weight:700;margin-bottom:16px;">📦 Caja personalizada — los productos fueron elegidos por ti</p>`
    : "";

  const sourceLabelText = isCustomBox
    ? "📦 Caja personalizada — los productos fueron elegidos por ti\n\n"
    : "";

  const productsHtml = items
    .map((item) => {
      const isBox = item.product_type === "box";
      const label = isBox
        ? `<span style="font-size:11px;background:#fef9c3;color:#854d0e;border-radius:4px;padding:2px 6px;margin-left:6px;font-weight:700;">Caja</span>`
        : "";

      const boxContentsHtml =
        isBox && Array.isArray(item.box_items) && item.box_items.length
          ? `<tr>
            <td colspan="4" style="padding:0 8px 12px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fafff7;border-radius:8px;border:1px solid #e2f0d9;">
                <thead>
                  <tr>
                    <th align="left" style="padding:6px 10px;font-size:11px;color:#666;font-weight:700;border-bottom:1px solid #e2f0d9;">Contenido de la caja</th>
                    <th align="center" style="padding:6px 10px;font-size:11px;color:#666;font-weight:700;border-bottom:1px solid #e2f0d9;">Cant.</th>
                    <th align="right" style="padding:6px 10px;font-size:11px;color:#666;font-weight:700;border-bottom:1px solid #e2f0d9;">P. Ref.</th>
                  </tr>
                </thead>
                <tbody>
                  ${item.box_items
                    .map(
                      (bi) => `
                    <tr>
                      <td style="padding:5px 10px;font-size:12px;color:#333;">${escapeHtml(bi.name)}</td>
                      <td style="padding:5px 10px;font-size:12px;color:#333;text-align:center;">${escapeHtml(bi.quantity)}</td>
                      <td style="padding:5px 10px;font-size:12px;color:#333;text-align:right;">${escapeHtml(money(bi.unit_price))}</td>
                    </tr>
                  `,
                    )
                    .join("")}
                </tbody>
              </table>
            </td>
           </tr>`
          : "";

      return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">
          ${escapeHtml(item.name || "Producto")}${label}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">
          ${escapeHtml(item.quantity)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">
          ${escapeHtml(money(item.price))}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">
          ${escapeHtml(money(item.subtotal))}
        </td>
      </tr>
      ${boxContentsHtml}
    `;
    })
    .join("");

  const productsText = items
    .map((item) => {
      const isBox = item.product_type === "box";
      const label = isBox ? " [Caja]" : "";
      const boxContentsText =
        isBox && Array.isArray(item.box_items) && item.box_items.length
          ? "\n" +
            item.box_items
              .map(
                (bi) =>
                  `    · ${bi.quantity}x ${bi.name} — ${money(bi.unit_price)}`,
              )
              .join("\n")
          : "";
      return `- ${item.name}${label} x${item.quantity} | ${money(item.price)} | Subtotal: ${money(item.subtotal)}${boxContentsText}`;
    })
    .join("\n");
  return {
    subject: `Pago confirmado #${shortOrder}`,
    text: `
Hola ${customer.fullName || ""},

Tu pago fue confirmado correctamente.

Orden: ${orderId}
Fecha: ${formatDate(order.updated_at || order.created_at)}
${isCustomBox ? "Tipo: Caja personalizada\n" : ""}
Cliente: ${customer.fullName || "—"}
RUT: ${customer.rut || "—"}
Email: ${customer.email || "—"}
Teléfono: ${customer.phone || "—"}

Productos:
${sourceLabelText}${productsText}

Subtotal: ${money(order.subtotal)}
Envío: ${money(order.shipping_amount)}
Descuento: ${money(order.discount_amount)}
Total pagado: ${money(order.total)}

Dirección de envío:
${shipping.address || "—"}, ${shipping.city || "—"}, ${shipping.region || "—"}

Método de pago: ${payment.method || "Webpay"}
Estado: ${payment.status || "approved"}
${taxText}

Gracias por comprar en CIBOX.
    `.trim(),

    html: baseLayout(`
      <h2 style="color:#4E9B27;">Pago confirmado</h2>

      <p>Hola <strong>${escapeHtml(customer.fullName || "")}</strong>,</p>
      <p>Tu pago fue confirmado correctamente. Ahora comenzaremos a preparar tu pedido.</p>

      <h3>Resumen de la orden</h3>
      <p><strong>Número de orden:</strong> ${escapeHtml(orderId)}</p>
      <p><strong>Fecha:</strong> ${escapeHtml(formatDate(order.updated_at || order.created_at))}</p>

      <h3>Datos del cliente</h3>
      <p><strong>Nombre:</strong> ${escapeHtml(customer.fullName || "—")}</p>
      <p><strong>RUT:</strong> ${escapeHtml(customer.rut || "—")}</p>
      <p><strong>Email:</strong> ${escapeHtml(customer.email || "—")}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(customer.phone || "—")}</p>

      <h3>Productos</h3>
      ${sourceLabel}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <thead>
          <tr>
            <th align="left" style="padding:8px;border-bottom:2px solid #ddd;">Producto</th>
            <th align="center" style="padding:8px;border-bottom:2px solid #ddd;">Cant.</th>
            <th align="right" style="padding:8px;border-bottom:2px solid #ddd;">Precio</th>
            <th align="right" style="padding:8px;border-bottom:2px solid #ddd;">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${productsHtml}
        </tbody>
      </table>

      <h3>Totales</h3>
      <p><strong>Subtotal:</strong> ${escapeHtml(money(order.subtotal))}</p>
      <p><strong>Envío:</strong> ${escapeHtml(money(order.shipping_amount))}</p>
      <p><strong>Descuento:</strong> ${escapeHtml(money(order.discount_amount))}</p>
      <p style="font-size:18px;"><strong>Total pagado:</strong> ${escapeHtml(money(order.total))}</p>

      <h3>Envío</h3>
      <p><strong>Región:</strong> ${escapeHtml(shipping.region || "—")}</p>
      <p><strong>Ciudad:</strong> ${escapeHtml(shipping.city || "—")}</p>
      <p><strong>Dirección:</strong> ${escapeHtml(shipping.address || "—")}</p>
      <p><strong>Servicio:</strong> ${escapeHtml(shipping.service_name || "—")}</p>

      <h3>Pago</h3>
      <p><strong>Método:</strong> ${escapeHtml(payment.method || "Webpay")}</p>
      <p><strong>Estado:</strong> ${escapeHtml(payment.status || "approved")}</p>
      <p><strong>Código autorización:</strong> ${escapeHtml(payment.authorization_code || "—")}</p>

      ${taxHtml}

      <p style="margin-top:24px;">Gracias por comprar en <strong>CIBOX</strong>.</p>
    `),
  };
};
