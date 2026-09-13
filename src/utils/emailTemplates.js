/**
 * Plantillas HTML/text para emails transaccionales.
 * Toda interpolación pasa por escapeHtml para evitar inyección.
 */
import { env } from "../config/env.js";
import { brand, addressOneLine } from "../config/brand.js";
import { caminoDe } from "../pedidos/estados.js";

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
          ${addressOneLine() ? `${escapeHtml(addressOneLine())}<br>` : ""}
          ${brand.contact?.whatsapp ? `WhatsApp <a href="https://wa.me/${escapeHtml(brand.contact.whatsapp)}" style="color:${C.lima};text-decoration:none;">+${escapeHtml(brand.contact.whatsapp)}</a> · ` : ""}
          <a href="mailto:${escapeHtml(brand.contact?.email_soporte || brand.contact?.email || "")}" style="color:${C.lima};text-decoration:none;">${escapeHtml(brand.contact?.email_soporte || brand.contact?.email || "")}</a>
          ${brand.contact?.instagram ? ` · <a href="https://instagram.com/${escapeHtml(brand.contact.instagram)}" style="color:${C.lima};text-decoration:none;">@${escapeHtml(brand.contact.instagram)}</a>` : ""}
        </td>
      </tr>
    </table>
  </div>
`;

// Etiquetas en español para lo que el modelo guarda en clave.
const METODO_PAGO = { webpay: "Tarjeta (Webpay)", card: "Tarjeta", transfer: "Transferencia", cash_on_pickup: "Efectivo al retirar", cash: "Efectivo", credito: "Crédito" };
const ESTADO_PAGO = { approved: "Aprobado", paid: "Pagado", pending: "Pendiente", processing: "En proceso", failed: "Rechazado", refunded: "Reembolsado" };
// Documento tributario (TaxDocument.js): tipo y estado tal como los guarda el modelo.
const TIPO_DOCUMENTO = { boleta: "Boleta", factura: "Factura" };
const ESTADO_DOCUMENTO = { pending: "Pendiente", accepted: "Aceptado", rejected: "Rechazado", voided: "Anulado" };
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

const money = (value) => {
  const n = Number(value || 0);
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString("es-CL")}`;
};

/**
 * Lo que va en la línea "Envío" de un correo. Devuelve TEXTO PLANO: quien lo
 * imprime decide si lo escapa y con qué estilo.
 *
 * Un despacho en 0 puede significar dos cosas distintas y la palabra no es la
 * misma. Si el pedido es a domicilio, el cero es la promoción y se dice
 * "Gratis". Si es un retiro —ya no se venden así, pero quedan pedidos viejos en
 * la base y los correos se pueden reenviar—, el cero es que no hubo despacho
 * que cobrar, y escribir "Gratis" ahí sería anunciar un regalo que no existió.
 *
 * La línea NO se oculta cuando vale 0, al revés de lo que hace la de Descuento:
 * un correo sin línea de envío se lee como que el pedido no se despachó.
 */
export const textoDespacho = (order) => {
  const monto = Number(order?.shipping_amount || 0);
  if (monto > 0) return money(monto);
  if (order?.delivery_method === "pickup") return "Sin despacho (retiro)";
  return "Gratis";
};

// Fechas siempre en hora de Chile: el servidor corre en UTC y sin timeZone el
// correo mostraba la hora corrida. Una fecha inválida sale como "—", nunca
// como "Invalid Date".
const formatDate = (date) => {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Santiago" });
};

// "lunes, 15 de septiembre de 2025": para la fecha comprometida de retiro.
const fechaLarga = (date) => {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "full", timeZone: "America/Santiago" }).format(d);
};

/**
 * Folio del pedido tal como lo ve el cliente: los 6 últimos caracteres del _id
 * en mayúscula. Se muestra como #ABC123 y es lo que pide el seguimiento
 * público. ÚNICA fórmula: todos los correos del pedido la usan para que el
 * asunto, el cuerpo y la web digan el mismo número.
 */
export const folioDe = (order) => String(order?._id || order?.id || "").slice(-6).toUpperCase();

const nombreCliente = (order) => String(order?.customer?.fullName || "").trim();

// ── Piezas compartidas por toda la familia de correos del pedido ─────────────
// Un solo diseño (el de "Pago confirmado"): cabecera con icono en círculo lima,
// tarjeta con el folio grande y el botón "Seguir mi pedido", secciones con
// titulo() y datos en dos columnas con dato().

// `extraHtml` va centrado bajo el mensaje (p. ej. el número de seguimiento).
const cabecera = ({ icono, encabezado, mensajeHtml, extraHtml = "" }) => `
      <div style="text-align:center;padding:6px 0 18px;">
        <div style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:28px;background:${C.lima};color:${C.texto};font-size:28px;font-weight:900;">${icono}</div>
        <h1 style="margin:14px 0 6px;font-size:24px;color:${C.azul};">${escapeHtml(encabezado)}</h1>
        <p style="margin:0;font-size:15px;color:${C.gris};">${mensajeHtml}</p>
        ${extraHtml}
      </div>`;

const tarjetaFolio = (folio) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.fondo};border-radius:12px;">
        <tr>
          <td style="padding:18px 20px;text-align:center;">
            <div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:${C.gris};">Número de pedido</div>
            <div style="font-size:30px;font-weight:900;letter-spacing:2px;color:${C.azul};margin:4px 0 12px;">#${escapeHtml(folio)}</div>
            <a href="${escapeHtml(urlSeguimiento(folio))}"
               style="display:inline-block;background:${C.lima};color:${C.texto};text-decoration:none;font-weight:800;font-size:15px;padding:13px 26px;border-radius:10px;">
              Seguir mi pedido
            </a>
            <div style="font-size:12px;color:${C.gris};margin-top:10px;">Te pedirá ese número y tu correo. No necesitas tener cuenta.</div>
          </td>
        </tr>
      </table>`;

const seguimientoTexto = (folio) =>
  `Tu número de pedido es ${folio}. Puedes seguirlo acá:\n${urlSeguimiento(folio)}\nTe pedirá ese número y tu correo. No necesitas tener cuenta.`;

const whatsappHtml = () =>
  brand.contact?.whatsapp
    ? `<a href="https://wa.me/${escapeHtml(brand.contact.whatsapp)}" style="color:${C.azul};font-weight:700;text-decoration:none;">WhatsApp</a>`
    : "WhatsApp";

const cierreHtml = () =>
  `<p style="margin:26px 0 0;font-size:14px;color:${C.gris};">Gracias por comprar en <strong style="color:${C.azul};">${escapeHtml(brand.name || "CIBOX")}</strong>. Si algo no cuadra, responde este correo o escríbenos por ${whatsappHtml()}.</p>`;

const cierreTexto = () =>
  `Si algo no cuadra, responde este correo o escríbenos por WhatsApp${brand.contact?.whatsapp ? ` (+${brand.contact.whatsapp})` : ""}.`;

// Franja para los pedidos armados desde "Arma tu caja" (order.source
// "custom_box"). Va bajo "Tu pedido" en "Recibimos tu pedido" y en "Pago
// confirmado": son el mismo pedido y los dos correos tienen que decirlo igual.
const ROTULO_CAJA = "Caja personalizada — los productos fueron elegidos por ti";
const esCajaPersonalizada = (order) => order?.source === "custom_box";
const franjaCajaHtml = (order) =>
  esCajaPersonalizada(order)
    ? `<p style="margin:0 0 14px;padding:10px 14px;background:#F1F7D9;border-left:4px solid ${C.lima};border-radius:8px;font-size:14px;font-weight:700;color:${C.texto};">${escapeHtml(ROTULO_CAJA)}</p>`
    : "";
const franjaCajaTexto = (order) => (esCajaPersonalizada(order) ? ROTULO_CAJA : null);

// Filas de la tabla de productos. Una caja (product_type "box") lleva la
// etiqueta "Caja" y, debajo, su contenido en una tabla anidada.
const filasProductosHtml = (items) =>
  items
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
                      <td style="padding:5px 10px;font-size:12px;color:#333;">${escapeHtml(bi.name || "Producto")}</td>
                      <td style="padding:5px 10px;font-size:12px;color:#333;text-align:center;">${escapeHtml(bi.quantity ?? "—")}</td>
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
          ${escapeHtml(item.quantity ?? "—")}
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

const productosTexto = (items) =>
  items
    .map((item) => {
      const isBox = item.product_type === "box";
      const label = isBox ? " [Caja]" : "";
      const boxContentsText =
        isBox && Array.isArray(item.box_items) && item.box_items.length
          ? "\n" +
            item.box_items
              .map((bi) => `    · ${bi.quantity ?? "—"}x ${bi.name || "Producto"} — ${money(bi.unit_price)}`)
              .join("\n")
          : "";
      return `- ${item.name || "Producto"}${label} x${item.quantity ?? "—"} | ${money(item.price)} | Subtotal: ${money(item.subtotal)}${boxContentsText}`;
    })
    .join("\n");

const tablaProductosHtml = (items) => `
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
          ${filasProductosHtml(items)}
        </tbody>
      </table>`;

// Subtotal, envío, descuento (solo si hay) y total. El rótulo del total cambia
// según el correo: "Total pagado" cuando ya se pagó, "Total" cuando no.
const tablaTotalesHtml = (order, rotuloTotal) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">
        <tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Subtotal</td><td align="right" style="padding:6px 8px;font-size:14px;color:${C.texto};">${escapeHtml(money(order.subtotal))}</td></tr>
        <tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Envío</td><td align="right" style="padding:6px 8px;font-size:14px;color:${C.texto};">${escapeHtml(textoDespacho(order))}</td></tr>
        ${Number(order.discount_amount) > 0 ? `<tr><td style="padding:6px 8px;font-size:14px;color:${C.gris};">Descuento</td><td align="right" style="padding:6px 8px;font-size:14px;color:#1D7A4C;">−${escapeHtml(money(order.discount_amount))}</td></tr>` : ""}
        <tr><td style="padding:12px 8px 6px;font-size:16px;font-weight:800;color:${C.azul};border-top:2px solid ${C.azul};">${escapeHtml(rotuloTotal)}</td><td align="right" style="padding:12px 8px 6px;font-size:20px;font-weight:900;color:${C.azul};border-top:2px solid ${C.azul};">${escapeHtml(money(order.total))}</td></tr>
      </table>`;

const totalesTexto = (order, rotuloTotal) =>
  [
    `Subtotal: ${money(order.subtotal)}`,
    `Envío: ${textoDespacho(order)}`,
    Number(order.discount_amount) > 0 ? `Descuento: −${money(order.discount_amount)}` : null,
    `${rotuloTotal}: ${money(order.total)}`,
  ]
    .filter(Boolean)
    .join("\n");

// Unidades del pedido (una caja cuenta por sus unidades, como en el modelo).
const unidadesDe = (items) => items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);

const direccionCorta = (shipping) => [shipping.address, shipping.city].filter(Boolean).join(", ");

// Bloque "Despacho" / "Retiro". Completo (correo de pedido recibido) o compacto
// (avisos de estado: dirección y comuna, sin RUT ni datos de más).
const bloqueEntregaHtml = (order, { compacto = false } = {}) => {
  const shipping = order.shipping || {};
  const pickup = order.pickup || {};
  const customer = order.customer || {};
  const esRetiro = order.delivery_method === "pickup";

  if (compacto) {
    const celda = esRetiro
      ? dato("Retiro en", escapeHtml(pickup.location || "—"))
      : dato("Despacho a", `${escapeHtml(shipping.address || "—")}${shipping.city ? `<br>${escapeHtml(shipping.city)}` : ""}`);
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>${celda}${dato("Contacto", `${escapeHtml(customer.fullName || "—")}${customer.phone ? `<br>${escapeHtml(customer.phone)}` : ""}`)}</tr>
      </table>`;
  }

  const filas = esRetiro
    ? [
        [
          dato("Lugar de retiro", escapeHtml(pickup.location || "—")),
          dato("Fecha comprometida", escapeHtml(fechaLarga(pickup.committed_date))),
        ],
        [dato("Contacto", `${escapeHtml(customer.fullName || "—")}${customer.phone ? `<br>${escapeHtml(customer.phone)}` : ""}`)],
      ]
    : [
        [
          dato("Dirección", escapeHtml([shipping.address, shipping.addressLine2].filter(Boolean).join(", ") || "—")),
          dato("Comuna / ciudad", escapeHtml([shipping.city, shipping.region].filter(Boolean).join(", ") || "—")),
        ],
        [
          shipping.reference ? dato("Referencia", escapeHtml(shipping.reference)) : "",
          dato("Contacto", `${escapeHtml(customer.fullName || "—")}${customer.phone ? `<br>${escapeHtml(customer.phone)}` : ""}`),
        ],
      ];
  return `
      ${titulo(esRetiro ? "Retiro" : "Despacho")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${filas.map((celdas) => `<tr>${celdas.join("")}</tr>`).join("")}
      </table>`;
};

const bloqueEntregaTexto = (order, { compacto = false } = {}) => {
  const shipping = order.shipping || {};
  const pickup = order.pickup || {};
  const customer = order.customer || {};
  const esRetiro = order.delivery_method === "pickup";
  const contacto = [customer.fullName || "—", customer.phone].filter(Boolean).join(" · ");

  if (compacto) {
    return esRetiro
      ? `Retiro en: ${pickup.location || "—"}\nContacto: ${contacto}`
      : `Despacho a: ${direccionCorta(shipping) || "—"}\nContacto: ${contacto}`;
  }
  const lineas = esRetiro
    ? [
        "Retiro:",
        `Lugar de retiro: ${pickup.location || "—"}`,
        `Fecha comprometida: ${fechaLarga(pickup.committed_date)}`,
      ]
    : [
        "Despacho:",
        `Dirección: ${[shipping.address, shipping.addressLine2].filter(Boolean).join(", ") || "—"}`,
        `Comuna / ciudad: ${[shipping.city, shipping.region].filter(Boolean).join(", ") || "—"}`,
        shipping.reference ? `Referencia: ${shipping.reference}` : null,
      ];
  lineas.push(`Contacto: ${contacto}`);
  return lineas.filter(Boolean).join("\n");
};

export const buildPaymentApprovedTemplate = ({ order, taxDocument = null }) => {
  const customer = order.customer || {};
  const shipping = order.shipping || {};
  const payment = order.payment || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const esRetiro = order.delivery_method === "pickup";

  const orderId = String(order._id || order.id || "");
  const shortOrder = folioDe(order);
  const nombre = nombreCliente(order);
  // Misma copia que la web (CLIENT_COPY.paid) y el push: el pedido ENTRÓ a la
  // cola. Que ya se está armando lo anuncia el correo de "preparing", que llega
  // después; si este dijera lo mismo, el cliente leería dos veces la misma noticia.
  const saludo = `Hola${nombre ? ` ${nombre}` : ""}, tu pedido entró a la cola de preparación.`;
  const fecha = formatDate(order.updated_at || order.created_at);
  const direccion = [shipping.address, shipping.city, shipping.region].filter(Boolean).join(", ") || "—";
  const contacto = [customer.fullName || "—", customer.phone].filter(Boolean).join(" · ");
  const metodo = etiqueta(METODO_PAGO, payment.method, "Webpay");
  const estadoPago = etiqueta(ESTADO_PAGO, payment.status, "Aprobado");
  // Sin código de autorización (transferencia, efectivo) la referencia es el id
  // completo del pedido, que es lo que se busca en el panel.
  const referencia = payment.authorization_code
    ? ["Código de autorización", String(payment.authorization_code)]
    : ["Referencia", orderId];

  // Documento tributario: tipo y estado en español (el modelo guarda
  // "boleta"/"accepted"), en el mismo formato de datos que el resto del correo.
  const tipoDoc = taxDocument ? etiqueta(TIPO_DOCUMENTO, taxDocument.type, "Boleta") : "";
  const estadoDoc = taxDocument ? etiqueta(ESTADO_DOCUMENTO, taxDocument.status, "—") : "";
  const avisoStub = "Modo integración: documento de prueba, no válido tributariamente.";
  const taxHtml = taxDocument
    ? `
      ${titulo("Documento tributario")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${dato("Tipo", escapeHtml(tipoDoc))}
          ${dato("Folio", escapeHtml(taxDocument.folio || "—"))}
        </tr>
        <tr>
          ${dato("Estado", escapeHtml(estadoDoc))}
        </tr>
      </table>
      ${taxDocument.stub ? `<p style="margin:0;font-size:13px;color:#92400E;">${escapeHtml(avisoStub)}</p>` : ""}`
    : "";
  const taxTexto = taxDocument
    ? [
        "",
        "Documento tributario:",
        `Tipo: ${tipoDoc}`,
        `Folio: ${taxDocument.folio || "—"}`,
        `Estado: ${estadoDoc}`,
        taxDocument.stub ? avisoStub : null,
      ]
    : [];

  const text = [
    `Hola${nombre ? ` ${nombre}` : ""},`,
    "",
    "Tu pago fue confirmado. Tu pedido entró a la cola de preparación.",
    "",
    seguimientoTexto(shortOrder),
    "",
    "Tu pedido:",
    franjaCajaTexto(order),
    productosTexto(items) || "(sin productos)",
    "",
    totalesTexto(order, "Total pagado"),
    "",
    esRetiro ? "Retiro:\nModalidad: Retiro en bodega" : `Despacho:\nDirección: ${direccion}`,
    `Contacto: ${contacto}`,
    "",
    "Pago:",
    `Método: ${metodo}`,
    `Estado: ${estadoPago}`,
    `Fecha: ${fecha}`,
    `${referencia[0]}: ${referencia[1]}`,
    ...taxTexto,
    "",
    cierreTexto(),
  ]
    .filter((l) => l !== null)
    .join("\n");

  return {
    subject: `Pago confirmado #${shortOrder}`,
    text,
    html: baseLayout(`
      ${cabecera({ icono: "&#10003;", encabezado: "Pago confirmado", mensajeHtml: escapeHtml(saludo) })}

      ${tarjetaFolio(shortOrder)}

      ${titulo("Tu pedido")}
      ${franjaCajaHtml(order)}
      ${tablaProductosHtml(items)}
      ${tablaTotalesHtml(order, "Total pagado")}

      ${titulo(esRetiro ? "Retiro" : "Despacho")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${esRetiro ? dato("Modalidad", "Retiro en bodega") : dato("Dirección", escapeHtml(direccion))}
          ${dato("Contacto", `${escapeHtml(customer.fullName || "—")}${customer.phone ? `<br>${escapeHtml(customer.phone)}` : ""}`)}
        </tr>
      </table>

      ${titulo("Pago")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${dato("Método", escapeHtml(metodo))}
          ${dato("Estado", escapeHtml(estadoPago))}
        </tr>
        <tr>
          ${dato("Fecha", escapeHtml(fecha))}
          ${payment.authorization_code ? dato(referencia[0], escapeHtml(referencia[1])) : dato(referencia[0], `<span style="font-size:12px;color:${C.gris};">${escapeHtml(referencia[1])}</span>`)}
        </tr>
      </table>

      ${taxHtml}

      ${cierreHtml()}
    `),
  };
};

// ── Pedido recibido ──────────────────────────────────────────────────────────

// Los tres pasos de "Qué sigue" dependen de cómo paga: con tarjeta esperamos
// la confirmación de Webpay; con transferencia el primer paso es que la haga;
// en efectivo paga al final. La entrega cambia si es retiro.
const pasosQueSigue = (order, folio) => {
  const metodo = String(order.payment?.method || "").toLowerCase();
  const esRetiro = order.delivery_method === "pickup";
  const entrega = esRetiro ? "Te avisamos cuando esté listo para retirar" : "Lo llevamos a tu dirección";
  if (metodo === "transfer") {
    return [
      `Haz la transferencia con los datos de abajo e indica el folio #${folio}`,
      "Cuando confirmemos el pago, preparamos tu pedido en bodega",
      entrega,
    ];
  }
  if (metodo === "cash_on_pickup" || metodo === "cash") {
    return ["Preparamos tu pedido en bodega", entrega, esRetiro ? "Pagas al retirarlo" : "Pagas al recibirlo"];
  }
  const confirmacion =
    metodo === "webpay" || metodo === "card"
      ? "Confirmamos tu pago con tarjeta (si ya pagaste, en unos minutos te llega la confirmación)"
      : "Confirmamos tu pago y te avisamos por este mismo medio";
  return [confirmacion, "Preparamos tu pedido en bodega", entrega];
};

const pasosHtml = (pasos) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${pasos
          .map(
            (p, i) => `
        <tr>
          <td width="36" valign="top" style="padding:0 0 12px;">
            <div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${C.lima};color:${C.texto};text-align:center;font-size:13px;font-weight:800;">${i + 1}</div>
          </td>
          <td valign="top" style="padding:3px 0 12px;font-size:14px;line-height:1.5;color:${C.texto};">${escapeHtml(p)}</td>
        </tr>`,
          )
          .join("")}
      </table>`;

// Datos bancarios para el pago por transferencia. Sin BANK_TRANSFER_INFO
// configurada no se inventa ningún dato: se pide contacto.
const datosTransferencia = () =>
  String(env.BANK_TRANSFER_INFO || "").trim() || "Responde este correo y te enviamos los datos de transferencia.";

export const buildOrderCreatedTemplate = ({ order }) => {
  const folio = folioDe(order);
  const payment = order.payment || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const nombre = nombreCliente(order);
  const saludo = nombre ? `Hola ${nombre}, gracias por comprar en ${brand.name || "Cibox"}.` : `Hola, gracias por comprar en ${brand.name || "Cibox"}.`;
  const pasos = pasosQueSigue(order, folio);
  const esTransfer = String(payment.method || "").toLowerCase() === "transfer";
  const bankInfo = esTransfer ? datosTransferencia() : "";
  const bankInfoHtml = bankInfo
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(escapeHtml)
    .join("<br>");
  const instruccionTransfer = `Indica el folio #${folio} en el comentario de la transferencia y luego sube el comprobante desde "Mis pedidos" para que confirmemos tu pago.`;

  const pagoHtml = `
      ${titulo("Pago")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${dato("Método", escapeHtml(etiqueta(METODO_PAGO, payment.method, "—")))}
          ${dato("Estado", "Pendiente")}
        </tr>
      </table>
      ${
        esTransfer
          ? `
      <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.gris};margin-bottom:6px;">Datos para transferir</div>
      <div style="background:${C.fondo};border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.7;color:${C.texto};">${bankInfoHtml}</div>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:${C.texto};">Indica el folio <strong>#${escapeHtml(folio)}</strong> en el comentario de la transferencia y luego sube el comprobante desde <strong>"Mis pedidos"</strong> para que confirmemos tu pago.</p>`
          : ""
      }`;

  const text = [
    saludo,
    "",
    `Recibimos tu pedido #${folio}.`,
    "",
    seguimientoTexto(folio),
    "",
    "Qué sigue:",
    ...pasos.map((p, i) => `${i + 1}. ${p}`),
    "",
    "Tu pedido:",
    franjaCajaTexto(order),
    productosTexto(items) || "(sin productos)",
    "",
    totalesTexto(order, "Total"),
    "",
    bloqueEntregaTexto(order),
    "",
    "Pago:",
    `Método: ${etiqueta(METODO_PAGO, payment.method, "—")}`,
    "Estado: Pendiente",
    esTransfer ? `Datos para transferir:\n${bankInfo}\n${instruccionTransfer}` : null,
    "",
    cierreTexto(),
  ]
    .filter((l) => l !== null)
    .join("\n");

  return {
    subject: `Recibimos tu pedido #${folio}`,
    text,
    html: baseLayout(`
      ${cabecera({ icono: "&#9993;", encabezado: "Recibimos tu pedido", mensajeHtml: escapeHtml(saludo) })}

      ${tarjetaFolio(folio)}

      ${titulo("Qué sigue")}
      ${pasosHtml(pasos)}

      ${titulo("Tu pedido")}
      ${franjaCajaHtml(order)}
      ${tablaProductosHtml(items)}
      ${tablaTotalesHtml(order, "Total")}

      ${bloqueEntregaHtml(order)}

      ${pagoHtml}

      ${cierreHtml()}
    `),
  };
};

// ── Cambios de estado ────────────────────────────────────────────────────────

// Etiquetas de la línea de avance: las mismas palabras que el título del
// correo de cada estado, la web y el push ("Listo para despacho", no "Listo").
// En retiro, "ready" se reemplaza por "Listo para retirar" al dibujar.
const ETIQUETA_PASO = {
  pending: "Pedido recibido",
  paid: "Pago confirmado",
  preparing: "En preparación",
  ready: "Listo para despacho",
  shipped: "En camino",
  delivered: "Entregado",
};

// Línea de avance: una fila de celdas iguales (los correos no entienden flex).
// Hechos en lima con ✓, el actual en azul y negrita, los pendientes en gris.
const lineaAvanceHtml = (order, estado) => {
  const camino = caminoDe(order.delivery_method);
  const esRetiro = order.delivery_method === "pickup";
  const idx = camino.indexOf(estado);
  const ancho = `${Math.floor(100 / camino.length)}%`;
  const celdas = camino
    .map((paso, i) => {
      const hecho = idx >= 0 && i < idx;
      const actual = i === idx;
      const etiquetaPaso = paso === "ready" && esRetiro ? "Listo para retirar" : ETIQUETA_PASO[paso] || paso;
      const fondo = hecho ? C.lima : actual ? C.azul : C.borde;
      const colorCirculo = hecho ? C.texto : actual ? "#ffffff" : C.gris;
      const colorEtiqueta = actual ? C.azul : hecho ? C.texto : C.gris;
      return `
          <td width="${ancho}" valign="top" align="center" style="padding:0 2px;">
            <div style="display:inline-block;width:28px;height:28px;line-height:28px;border-radius:14px;background:${fondo};color:${colorCirculo};font-size:13px;font-weight:800;">${hecho ? "&#10003;" : i + 1}</div>
            <div style="margin-top:6px;font-size:11px;line-height:1.3;color:${colorEtiqueta};font-weight:${actual ? 800 : 400};">${escapeHtml(etiquetaPaso)}</div>
          </td>`;
    })
    .join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 8px;">
        <tr>${celdas}</tr>
      </table>`;
};

const lineaAvanceTexto = (order, estado) => {
  const camino = caminoDe(order.delivery_method);
  const esRetiro = order.delivery_method === "pickup";
  const idx = camino.indexOf(estado);
  return camino
    .map((paso, i) => {
      const marca = idx >= 0 && i < idx ? "[x]" : i === idx ? "[>]" : "[ ]";
      const etiquetaPaso = paso === "ready" && esRetiro ? "Listo para retirar" : ETIQUETA_PASO[paso] || paso;
      return `${marca} ${etiquetaPaso}`;
    })
    .join("  ");
};

// Franja de aviso para los estados fuera del camino feliz (anulado /
// reembolsado), en lugar de la línea de avance.
const franjaAvisoHtml = (textoHtml, tono) => {
  const fondo = tono === "danger" ? "#FDECEC" : "#F1F7D9";
  const borde = tono === "danger" ? brand.colors?.danger || "#b00020" : C.lima;
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0 4px;">
        <tr>
          <td style="padding:14px 18px;background:${fondo};border-left:4px solid ${borde};border-radius:8px;font-size:14px;line-height:1.5;color:${C.texto};">${textoHtml}</td>
        </tr>
      </table>`;
};

// Nombre legible del transportista. "blueexpress_manual" es el valor por
// defecto del modelo (etiqueta hecha a mano), no un courier que mostrar.
const TRANSPORTISTA = { blueexpress: "Blue Express", starken: "Starken", chilexpress: "Chilexpress", correos_chile: "Correos de Chile" };
const nombreTransportista = (carrier) => {
  const c = String(carrier || "").trim();
  if (!c || c === "blueexpress_manual") return "";
  return TRANSPORTISTA[c.toLowerCase()] || c;
};

/**
 * Correo al cliente por cambio de estado. Devuelve null cuando el estado no
 * tiene mensaje para el cliente (pending y desconocidos). "paid" reutiliza la
 * plantilla de pago confirmado (confirmación manual de transferencia/efectivo).
 */
export const buildOrderStatusTemplate = ({ order, status, trackingNumber = null, note = null }) => {
  if (!order) return null;
  const estado = String(status || "").toLowerCase();
  if (estado === "paid") return buildPaymentApprovedTemplate({ order });

  const folio = folioDe(order);
  const items = Array.isArray(order.items) ? order.items : [];
  const shipping = order.shipping || {};
  const pickup = order.pickup || {};
  const esRetiro = order.delivery_method === "pickup";
  const destino = direccionCorta(shipping);
  const seguimiento = String(trackingNumber || shipping.tracking_number || "").trim();
  const transportista = nombreTransportista(shipping.carrier);
  const motivo = String(note || "").trim();

  let subject;
  let encabezado;
  let icono;
  let mensaje;
  const datos = []; // [rótulo, valor] extra bajo la cabecera (seguimiento, transportista)
  let aviso = null; // { texto, tono } para anulado / reembolsado

  switch (estado) {
    case "preparing":
      subject = `Estamos preparando tu pedido #${folio}`;
      encabezado = "Preparando tu pedido";
      icono = "&#9881;";
      mensaje = "Nuestro equipo ya está armando tu compra. Te avisaremos cuando esté lista para salir.";
      break;
    case "ready":
      if (esRetiro) {
        subject = `Tu pedido #${folio} está listo para retirar`;
        encabezado = "Listo para retirar";
        mensaje = pickup.location
          ? `Tu pedido está empacado y te espera en ${pickup.location}.`
          : "Tu pedido está empacado y listo para que lo retires.";
        if (pickup.committed_date) mensaje += ` Fecha comprometida: ${fechaLarga(pickup.committed_date)}.`;
      } else {
        subject = `Tu pedido #${folio} está listo para despacho`;
        encabezado = "Listo para despacho";
        mensaje = "Tu pedido está empacado y saldrá en el próximo reparto. Te avisaremos cuando vaya en camino.";
      }
      icono = "&#9745;";
      break;
    case "shipped":
      subject = `Tu pedido #${folio} va en camino`;
      encabezado = "En camino";
      icono = "&#10148;";
      mensaje = destino ? `Tu pedido salió a reparto hacia ${destino}.` : "Tu pedido salió a reparto.";
      if (seguimiento) datos.push(["Número de seguimiento", seguimiento]);
      if (seguimiento && transportista) datos.push(["Transportista", transportista]);
      break;
    case "delivered":
      subject = `Tu pedido #${folio} fue entregado`;
      encabezado = "Entregado";
      icono = "&#10003;";
      mensaje =
        "Esperamos que disfrutes tu compra. Si falta algo o algo llegó en mal estado, responde este correo o escríbenos por WhatsApp y lo resolvemos.";
      break;
    case "cancelled":
      subject = `Tu pedido #${folio} fue anulado`;
      encabezado = "Pedido anulado";
      icono = "&#10005;";
      mensaje = `Tu pedido fue anulado.${motivo ? ` Motivo: ${motivo}` : ""}`;
      aviso = { texto: "Si ya habías pagado, gestionaremos la devolución y te avisaremos por este mismo medio.", tono: "danger" };
      break;
    case "refunded":
      subject = `Reembolso de tu pedido #${folio}`;
      encabezado = "Reembolso realizado";
      icono = "&#8629;";
      mensaje = "Te devolvimos el dinero de este pedido por el mismo medio de pago.";
      aviso = {
        texto: `Monto reembolsado: ${money(order.total)}. Según tu banco, puede tardar algunos días en verse reflejado.`,
        tono: "ok",
      };
      break;
    default:
      return null;
  }

  const unidades = unidadesDe(items);
  const resumen = `${unidades} ${unidades === 1 ? "producto" : "productos"} · Total ${money(order.total)}`;

  const datosHtml = datos.length
    ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:${C.texto};">${datos
        .map(([r, v]) => `${escapeHtml(r)}: <strong>${escapeHtml(v)}</strong>`)
        .join("<br>")}</p>`
    : "";

  const text = [
    `Hola ${nombreCliente(order) || ""}`.trim() + ",",
    "",
    mensaje,
    ...datos.map(([r, v]) => `${r}: ${v}`),
    "",
    seguimientoTexto(folio),
    "",
    aviso ? aviso.texto : `Avance: ${lineaAvanceTexto(order, estado)}`,
    "",
    `Resumen: ${resumen}`,
    bloqueEntregaTexto(order, { compacto: true }),
    "",
    cierreTexto(),
  ].join("\n");

  return {
    subject,
    text,
    html: baseLayout(`
      ${cabecera({ icono, encabezado, mensajeHtml: escapeHtml(mensaje), extraHtml: datosHtml })}

      ${tarjetaFolio(folio)}

      ${aviso ? franjaAvisoHtml(escapeHtml(aviso.texto), aviso.tono) : `${titulo("Avance de tu pedido")}${lineaAvanceHtml(order, estado)}`}

      ${titulo("Resumen")}
      <p style="margin:0 0 12px;font-size:14px;color:${C.texto};">${escapeHtml(resumen)}</p>
      ${bloqueEntregaHtml(order, { compacto: true })}

      ${cierreHtml()}
    `),
  };
};
