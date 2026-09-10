/**
 * Plantillas HTML/text para emails transaccionales.
 * Toda interpolación pasa por escapeHtml para evitar inyección.
 */
import { env } from "../config/env.js";
import { brand, addressOneLine } from "../config/brand.js";

// Enlace al seguimiento público con el número ya puesto. Misma fórmula que el
// correo "Recibimos tu pedido" (orderController): quien compró sin cuenta no
// tiene otro registro que este correo, así que el enlace tiene que ir en TODOS
// los correos del pedido, no solo en el primero.
const urlSeguimiento = (folio) =>
  String(env.FRONTEND_URL || "").replace(/\/+$/, "") +
  "/seguir-mi-pedido?folio=" +
  encodeURIComponent(String(folio || "").replace("#", ""));

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

// Paleta de brand.colors, escrita a mano porque los correos no cargan CSS ni
// JS: todo va inline. Azul Cibox para cabecera y titulares, lima para el botón
// de acción (con texto oscuro encima, como manda la identidad), gris claro de
// fondo para que la tarjeta blanca se recorte.
const C = {
  azul: brand.colors?.primary || "#004568",
  navy: brand.colors?.primaryDark || "#003D49",
  lima: brand.colors?.accent || "#B6D900",
  texto: "#17202A",
  gris: "#5A6672",
  borde: "#E2E6EA",
  fondo: "#F5F6F7",
};

const baseLayout = (innerHtml) => `
  <meta charset="utf-8">
  <div style="background:${C.fondo};padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:${C.texto};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;border-collapse:collapse;">
      <tr>
        <td style="background:${C.azul};border-radius:14px 14px 0 0;padding:22px 28px;">
          <span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#ffffff;">${escapeHtml(String(brand.name || "CIBOX").toUpperCase())}</span>
          <span style="display:block;margin-top:4px;font-size:12px;color:${C.lima};font-weight:700;">${escapeHtml(brand.tagline || "Tu supermercado online")}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px;border:1px solid ${C.borde};border-top:0;">
          ${innerHtml}
        </td>
      </tr>
      <tr>
        <td style="background:${C.navy};border-radius:0 0 14px 14px;padding:18px 28px;font-size:12px;line-height:1.7;color:#cfe3ea;">
          <strong style="color:#ffffff;">${escapeHtml(brand.legal?.razon_social || brand.name || "CIBOX")}</strong><br>
          ${escapeHtml(addressOneLine())}<br>
          ${brand.contact?.whatsapp ? `WhatsApp <a href="https://wa.me/${escapeHtml(brand.contact.whatsapp)}" style="color:${C.lima};text-decoration:none;">+${escapeHtml(brand.contact.whatsapp)}</a> · ` : ""}
          <a href="mailto:${escapeHtml(brand.contact?.email_soporte || brand.contact?.email || "")}" style="color:${C.lima};text-decoration:none;">${escapeHtml(brand.contact?.email_soporte || brand.contact?.email || "")}</a>
          ${brand.contact?.instagram ? ` · <a href="https://instagram.com/${escapeHtml(brand.contact.instagram)}" style="color:${C.lima};text-decoration:none;">@${escapeHtml(brand.contact.instagram)}</a>` : ""}
        </td>
      </tr>
    </table>
  </div>
`;

// Etiquetas en español para lo que el modelo guarda en clave.
const METODO_PAGO = { webpay: "Tarjeta (Webpay)", transfer: "Transferencia", cash_on_pickup: "Efectivo al retirar", cash: "Efectivo" };
const ESTADO_PAGO = { approved: "Aprobado", paid: "Pagado", pending: "Pendiente", processing: "En proceso", failed: "Rechazado", refunded: "Reembolsado" };
const etiqueta = (mapa, clave, porDefecto) => mapa[String(clave || "").toLowerCase()] || porDefecto || String(clave || "—");

// Un dato del resumen: rótulo gris pequeño arriba, valor abajo. Se usa en
// tablas de dos columnas porque los correos no entienden flex ni grid.
const dato = (rotulo, valor) => `
  <td valign="top" width="50%" style="padding:0 8px 14px 0;">
    <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};margin-bottom:3px;">${escapeHtml(rotulo)}</div>
    <div style="font-size:14px;color:${C.texto};">${valor}</div>
  </td>`;

const titulo = (texto) => `<h3 style="margin:26px 0 12px;font-size:15px;color:${C.azul};letter-spacing:.3px;">${escapeHtml(texto)}</h3>`;

const button = (href, label) => `
  <p>
    <a href="${escapeAttr(href)}"
       style="display:inline-block;padding:12px 20px;background:#004568;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">
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
  const shortOrder = String(orderId).slice(-6).toUpperCase();

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
        <td style="padding:10px 8px;border-bottom:1px solid ${C.borde};font-size:14px;color:${C.texto};">
          ${escapeHtml(item.name || "Producto")}${label}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.borde};text-align:center;font-size:14px;color:${C.gris};">
          ${escapeHtml(item.quantity)}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.borde};text-align:right;font-size:14px;color:${C.gris};">
          ${escapeHtml(money(item.price))}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.borde};text-align:right;font-size:14px;font-weight:700;color:${C.texto};">
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

Tu número de pedido es ${shortOrder}. Puedes seguirlo acá:
${urlSeguimiento(shortOrder)}
Te pedirá ese número y tu correo. No necesitas tener cuenta.

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
      <div style="text-align:center;padding:6px 0 18px;">
        <div style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:28px;background:${C.lima};color:${C.texto};font-size:28px;font-weight:900;">&#10003;</div>
        <h1 style="margin:14px 0 6px;font-size:24px;color:${C.azul};">Pago confirmado</h1>
        <p style="margin:0;font-size:15px;color:${C.gris};">Hola ${escapeHtml(customer.fullName || "")}, ya estamos preparando tu pedido.</p>
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.fondo};border-radius:12px;">
        <tr>
          <td style="padding:18px 20px;text-align:center;">
            <div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:${C.gris};">Número de pedido</div>
            <div style="font-size:30px;font-weight:900;letter-spacing:2px;color:${C.azul};margin:4px 0 12px;">#${escapeHtml(shortOrder)}</div>
            <a href="${escapeHtml(urlSeguimiento(shortOrder))}"
               style="display:inline-block;background:${C.lima};color:${C.texto};text-decoration:none;font-weight:800;font-size:15px;padding:13px 26px;border-radius:10px;">
              Seguir mi pedido
            </a>
            <div style="font-size:12px;color:${C.gris};margin-top:10px;">Te pedirá ese número y tu correo. No necesitas tener cuenta.</div>
          </td>
        </tr>
      </table>

      ${titulo("Tu pedido")}
      ${sourceLabel}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <thead>
          <tr>
            <th align="left" style="padding:8px;border-bottom:2px solid ${C.azul};font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};">Producto</th>
            <th align="center" style="padding:8px;border-bottom:2px solid ${C.azul};font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};">Cant.</th>
            <th align="right" style="padding:8px;border-bottom:2px solid ${C.azul};font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};">Precio</th>
            <th align="right" style="padding:8px;border-bottom:2px solid ${C.azul};font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${productsHtml}
        </tbody>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">
        <tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Subtotal</td><td align="right" style="padding:6px 8px;font-size:14px;color:${C.texto};">${escapeHtml(money(order.subtotal))}</td></tr>
        <tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Envío</td><td align="right" style="padding:6px 8px;font-size:14px;color:${C.texto};">${escapeHtml(money(order.shipping_amount))}</td></tr>
        ${Number(order.discount_amount) > 0 ? `<tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Descuento</td><td align="right" style="padding:6px 8px;font-size:14px;color:#1D7A4C;">−${escapeHtml(money(order.discount_amount))}</td></tr>` : ""}
        <tr><td style="padding:12px 8px 6px;font-size:16px;font-weight:800;color:${C.azul};border-top:2px solid ${C.azul};">Total pagado</td><td align="right" style="padding:12px 8px 6px;font-size:20px;font-weight:900;color:${C.azul};border-top:2px solid ${C.azul};">${escapeHtml(money(order.total))}</td></tr>
      </table>

      ${titulo(order.delivery_method === "pickup" ? "Retiro" : "Despacho")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${order.delivery_method === "pickup"
            ? dato("Modalidad", "Retiro en bodega")
            : dato("Dirección", escapeHtml([shipping.address, shipping.city, shipping.region].filter(Boolean).join(", ") || "—"))}
          ${dato("Contacto", `${escapeHtml(customer.fullName || "—")}<br>${escapeHtml(customer.phone || "")}`)}
        </tr>
      </table>

      ${titulo("Pago")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${dato("Método", escapeHtml(etiqueta(METODO_PAGO, payment.method, "Webpay")))}
          ${dato("Estado", escapeHtml(etiqueta(ESTADO_PAGO, payment.status, "Aprobado")))}
        </tr>
        <tr>
          ${dato("Fecha", escapeHtml(formatDate(order.updated_at || order.created_at)))}
          ${payment.authorization_code ? dato("Código de autorización", escapeHtml(payment.authorization_code)) : dato("Referencia", `<span style="font-size:12px;color:${C.gris};">${escapeHtml(orderId)}</span>`)}
        </tr>
      </table>

      ${taxHtml}

      <p style="margin:26px 0 0;font-size:14px;color:${C.gris};">Gracias por comprar en <strong style="color:${C.azul};">${escapeHtml(brand.name || "CIBOX")}</strong>. Si algo no cuadra, responde este correo o escríbenos por WhatsApp.</p>
    `),
  };
};
