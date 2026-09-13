import test from "node:test";
import assert from "node:assert/strict";

// Sin transporte (no manda nada) y con la URL pública de la tienda, que es la
// que llevan los enlaces "Seguir mi pedido".
process.env.EMAIL_TRANSPORT = "off";
process.env.FRONTEND_URL = "https://www.cibox.cl";

const {
  buildOrderCreatedTemplate,
  buildOrderStatusTemplate,
  buildPaymentApprovedTemplate,
  folioDe,
} = await import("../src/utils/emailTemplates.js");

// Pedido de ejemplo. Los nombres llevan <script> a propósito: son texto que
// escribe un tercero (catálogo, cliente) y en el HTML tienen que salir escapados.
const pedidoBase = () => ({
  _id: "64f1a2b3c4d5e6f7a8b9c0de",
  created_at: "2025-09-15T14:30:00.000Z",
  status: "pending",
  source: "cart",
  delivery_method: "delivery",
  customer: {
    fullName: "María <script>alert(1)</script> Pérez",
    email: "maria@example.com",
    phone: "+56 9 1234 5678",
    rut: "12.345.678-9",
  },
  items: [
    { name: "Arroz Grado 1 <script>x</script> 1 kg", quantity: 2, price: 1290, subtotal: 2580, product_type: "simple" },
    {
      name: "Caja Desayuno",
      quantity: 1,
      price: 9990,
      subtotal: 9990,
      product_type: "box",
      box_items: [
        { name: "Pan de molde <script>y</script>", quantity: 1, unit_price: 2190 },
        { name: "Mermelada", quantity: 2, unit_price: 1490 },
      ],
    },
  ],
  subtotal: 12570,
  shipping_amount: 2500,
  discount_amount: 1000,
  total: 14070,
  shipping: {
    address: "Av. Libertador 1234 <script>z</script>",
    addressLine2: "Depto 45",
    city: "Rancagua",
    region: "O'Higgins",
    reference: "Portón verde",
    carrier: "blueexpress_manual",
    tracking_number: null,
  },
  payment: { method: "webpay", status: "pending" },
  pickup: { committed_date: null, location: "" },
});

const pedidoWebpay = () => pedidoBase();
const pedidoTransfer = () => ({ ...pedidoBase(), payment: { method: "transfer", status: "pending" } });
const pedidoPickup = () => ({
  ...pedidoBase(),
  delivery_method: "pickup",
  shipping: { address: null, city: null, region: null },
  payment: { method: "cash_on_pickup", status: "pending" },
  pickup: { committed_date: "2025-09-17T15:00:00.000Z", location: "Bodega Cibox, Rancagua" },
});

const FOLIO = "B9C0DE";
const ENLACE = `https://www.cibox.cl/seguir-mi-pedido?folio=${FOLIO}`;
const ESTADOS_CON_CORREO = ["paid", "preparing", "ready", "shipped", "delivered", "cancelled", "refunded"];

// Lo que nunca puede llegarle a un cliente: un hueco del código impreso en el correo.
const sinBasura = (s, etiqueta) => {
  for (const malo of [/\bundefined\b/, /\bNaN\b/, /\bnull\b/, /Invalid Date/]) {
    assert.ok(!malo.test(s), `${etiqueta} contiene ${malo}`);
  }
};

const sinScriptCrudo = (html, etiqueta) => {
  assert.ok(!html.includes("<script>"), `${etiqueta}: el <script> salió crudo`);
  assert.ok(html.includes("&lt;script&gt;"), `${etiqueta}: el <script> no aparece escapado`);
};

test("folioDe: 6 últimos caracteres del _id en mayúscula, con o sin ObjectId", () => {
  assert.equal(folioDe(pedidoBase()), FOLIO);
  assert.equal(folioDe({ _id: { toString: () => "abcdef0123456789abcdef12" } }), "CDEF12");
  assert.equal(folioDe({ id: "xyz" }), "XYZ");
  assert.equal(folioDe({}), "");
});

test("pedido recibido: asunto con folio de 6 mayúsculas y enlace de seguimiento en html y text", () => {
  for (const pedido of [pedidoWebpay(), pedidoTransfer(), pedidoPickup()]) {
    const t = buildOrderCreatedTemplate({ order: pedido });
    assert.equal(t.subject, `Recibimos tu pedido #${FOLIO}`);
    assert.match(t.subject, /#[A-Z0-9]{6}$/);
    assert.ok(t.html.includes(ENLACE), "html sin enlace de seguimiento");
    assert.ok(t.text.includes(ENLACE), "text sin enlace de seguimiento");
    assert.ok(t.html.includes("Seguir mi pedido"));
    sinScriptCrudo(t.html, "pedido recibido");
    sinBasura(t.html, "html pedido recibido");
    sinBasura(t.text, "text pedido recibido");
  }
});

test("pedido recibido: los pasos de 'Qué sigue' cambian con el método de pago", () => {
  const webpay = buildOrderCreatedTemplate({ order: pedidoWebpay() });
  assert.ok(webpay.html.includes("Confirmamos tu pago con tarjeta"));
  assert.ok(webpay.html.includes("Lo llevamos a tu dirección"));
  assert.ok(!webpay.html.includes("Datos para transferir"));

  const transfer = buildOrderCreatedTemplate({ order: pedidoTransfer() });
  assert.ok(transfer.html.includes("Haz la transferencia con los datos de abajo"));
  assert.ok(transfer.html.includes("Datos para transferir"));
  assert.ok(transfer.html.includes(`Indica el folio <strong>#${FOLIO}</strong>`));
  assert.ok(transfer.text.includes(`Indica el folio #${FOLIO}`));
  assert.ok(transfer.html.includes("Mis pedidos"));

  const pickup = buildOrderCreatedTemplate({ order: pedidoPickup() });
  assert.ok(pickup.html.includes("Pagas al retirarlo"));
  assert.ok(pickup.html.includes("Retiro"));
  assert.ok(pickup.html.includes("Bodega Cibox, Rancagua"));
  assert.ok(pickup.text.includes("Bodega Cibox, Rancagua"));
  // Fecha comprometida en español y en hora de Chile.
  assert.match(pickup.html, /17 de septiembre de 2025/);
});

test("pedido recibido: productos, caja con su contenido, totales y despacho", () => {
  const t = buildOrderCreatedTemplate({ order: pedidoWebpay() });
  assert.ok(t.html.includes("Contenido de la caja"));
  assert.ok(t.html.includes("Mermelada"));
  assert.ok(t.html.includes("$14.070"));
  assert.ok(t.html.includes("$2.500"));
  assert.ok(t.html.includes("Descuento"));
  assert.ok(t.html.includes("Depto 45"));
  assert.ok(t.html.includes("Portón verde"));
  assert.ok(t.html.includes("Pendiente"));
  assert.ok(t.text.includes("Total: $14.070"));
  assert.ok(t.text.includes("Mermelada"));
});

test("cambio de estado: cada estado con mensaje devuelve plantilla y pending devuelve null", () => {
  for (const status of ESTADOS_CON_CORREO) {
    for (const pedido of [pedidoWebpay(), pedidoPickup()]) {
      const t = buildOrderStatusTemplate({ order: pedido, status });
      assert.ok(t, `${status} sin plantilla`);
      assert.match(t.subject, /#[A-Z0-9]{6}\b/, `${status}: asunto sin folio`);
      assert.ok(t.subject.includes(`#${FOLIO}`), `${status}: asunto con otro folio`);
      assert.ok(t.html.includes(ENLACE), `${status}: html sin enlace`);
      assert.ok(t.text.includes(ENLACE), `${status}: text sin enlace`);
      sinScriptCrudo(t.html, status);
      sinBasura(t.html, `html ${status}`);
      sinBasura(t.text, `text ${status}`);
    }
  }
  assert.equal(buildOrderStatusTemplate({ order: pedidoWebpay(), status: "pending" }), null);
  assert.equal(buildOrderStatusTemplate({ order: pedidoWebpay(), status: "inventado" }), null);
  assert.equal(buildOrderStatusTemplate({ order: pedidoWebpay(), status: null }), null);
});

test("cambio de estado: paid reutiliza la plantilla de pago confirmado", () => {
  const pedido = { ...pedidoWebpay(), status: "paid", payment: { method: "transfer", status: "paid" } };
  const t = buildOrderStatusTemplate({ order: pedido, status: "paid" });
  const directa = buildPaymentApprovedTemplate({ order: pedido });
  assert.equal(t.subject, `Pago confirmado #${FOLIO}`);
  assert.equal(t.html, directa.html);
  assert.equal(t.text, directa.text);
});

test("cambio de estado: ready dice 'despacho' con envío y 'retirar' con retiro", () => {
  const despacho = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "ready" });
  assert.equal(despacho.subject, `Tu pedido #${FOLIO} está listo para despacho`);
  assert.ok(despacho.html.includes("Listo para despacho"));
  assert.ok(!despacho.subject.includes("retirar"));

  const retiro = buildOrderStatusTemplate({ order: pedidoPickup(), status: "ready" });
  assert.equal(retiro.subject, `Tu pedido #${FOLIO} está listo para retirar`);
  assert.ok(retiro.html.includes("Listo para retirar"));
  assert.ok(retiro.html.includes("Bodega Cibox, Rancagua"));
  assert.ok(!retiro.subject.includes("despacho"));
  // En retiro la línea de avance no tiene "En camino".
  assert.ok(!retiro.html.includes("En camino"));
  assert.ok(despacho.html.includes("En camino"));
});

test("cambio de estado: shipped lleva la dirección y el número de seguimiento", () => {
  const t = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "shipped", trackingNumber: "BX-<script>1</script>-999" });
  assert.equal(t.subject, `Tu pedido #${FOLIO} va en camino`);
  assert.ok(t.html.includes("Número de seguimiento"));
  assert.ok(t.html.includes("BX-&lt;script&gt;1&lt;/script&gt;-999"));
  assert.ok(t.text.includes("Número de seguimiento: BX-<script>1</script>-999"));
  assert.ok(t.html.includes("Rancagua"));
  // El carrier por defecto del modelo es una etiqueta manual, no un courier que mostrar.
  assert.ok(!t.html.includes("blueexpress_manual"));
  assert.ok(!t.html.includes("Transportista"));

  // Sin número explícito toma el del pedido; con carrier real lo nombra.
  const pedido = pedidoWebpay();
  pedido.shipping.tracking_number = "TRK123";
  pedido.shipping.carrier = "starken";
  const t2 = buildOrderStatusTemplate({ order: pedido, status: "shipped" });
  assert.ok(t2.html.includes("TRK123"));
  assert.ok(t2.html.includes("Starken"));

  // Sin seguimiento no aparece el dato vacío.
  const t3 = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "shipped" });
  assert.ok(!t3.html.includes("Número de seguimiento"));
});

test("cambio de estado: anulado muestra el motivo y la franja, sin línea de avance", () => {
  const t = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "cancelled", note: "Sin stock <script>n</script>" });
  assert.equal(t.subject, `Tu pedido #${FOLIO} fue anulado`);
  assert.ok(t.html.includes("Motivo: Sin stock &lt;script&gt;n&lt;/script&gt;"));
  assert.ok(t.text.includes("Motivo: Sin stock"));
  assert.ok(t.html.includes("Si ya habías pagado"));
  assert.ok(!t.html.includes("Avance de tu pedido"));

  const sinMotivo = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "cancelled" });
  assert.ok(!sinMotivo.html.includes("Motivo:"));

  const reembolso = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "refunded" });
  assert.equal(reembolso.subject, `Reembolso de tu pedido #${FOLIO}`);
  assert.ok(reembolso.html.includes("mismo medio de pago"));
  assert.ok(!reembolso.html.includes("Avance de tu pedido"));
});

test("cambio de estado: la línea de avance marca hechos, actual y pendientes", () => {
  const t = buildOrderStatusTemplate({ order: pedidoWebpay(), status: "preparing" });
  assert.ok(t.html.includes("Avance de tu pedido"));
  for (const paso of ["Pedido recibido", "Pago confirmado", "En preparación", "Listo", "En camino", "Entregado"]) {
    assert.ok(t.html.includes(paso), `falta el paso ${paso}`);
  }
  assert.ok(t.text.includes("[x] Pedido recibido"));
  assert.ok(t.text.includes("[>] En preparación"));
  assert.ok(t.text.includes("[ ] Entregado"));
  assert.ok(t.html.includes("2 productos") || t.html.includes("3 productos"));
});

test("pago confirmado: sigue usando el mismo folio y enlace que el resto", () => {
  const t = buildPaymentApprovedTemplate({ order: { ...pedidoWebpay(), payment: { method: "webpay", status: "approved", authorization_code: "123456" } } });
  assert.equal(t.subject, `Pago confirmado #${FOLIO}`);
  assert.ok(t.html.includes(ENLACE));
  assert.ok(t.text.includes(ENLACE));
  assert.ok(t.html.includes("Total pagado"));
  sinScriptCrudo(t.html, "pago confirmado");
  sinBasura(t.html, "html pago confirmado");
  sinBasura(t.text, "text pago confirmado");
});

test("un pedido con lo mínimo no imprime huecos del código", () => {
  const minimo = { _id: "000000000000000000abc123", customer: { email: "x@y.cl" }, items: [] };
  const creado = buildOrderCreatedTemplate({ order: minimo });
  sinBasura(creado.html, "html mínimo creado");
  sinBasura(creado.text, "text mínimo creado");
  assert.equal(creado.subject, "Recibimos tu pedido #ABC123");
  for (const status of ESTADOS_CON_CORREO) {
    const t = buildOrderStatusTemplate({ order: minimo, status });
    sinBasura(t.html, `html mínimo ${status}`);
    sinBasura(t.text, `text mínimo ${status}`);
  }
});
