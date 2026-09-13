import test from "node:test";
import assert from "node:assert/strict";

// Sin transporte: el emailService registra y descarta, no manda nada. Lo que se
// prueba aquí es el contrato del servicio de avisos, no la entrega.
process.env.EMAIL_TRANSPORT = "off";
process.env.FRONTEND_URL = "https://www.cibox.cl";

const { notificarCambioDeEstado, notificarPedidoCreado } = await import(
  "../src/services/notificacionesPedidoService.js"
);

// Pedido de ejemplo SIN user_id: es un invitado, así que no hay push ni
// notificación in-app y nada intenta escribir en Mongo (las pruebas no conectan).
let contador = 0;
const pedido = (extra = {}) => ({
  // Cada pedido lleva un _id distinto para que la guarda de duplicados (por
  // "orderId:status") no cruce una prueba con otra.
  _id: `64f1a2b3c4d5e6f7a8b9${String(++contador).padStart(4, "0")}`,
  created_at: "2025-09-15T14:30:00.000Z",
  status: "ready",
  delivery_method: "delivery",
  user_id: null,
  customer: { fullName: "María Pérez", email: "maria@example.com", phone: "+56912345678" },
  items: [{ name: "Arroz 1 kg", quantity: 2, price: 1290, subtotal: 2580, product_type: "simple" }],
  subtotal: 2580,
  shipping_amount: 2500,
  discount_amount: 0,
  total: 5080,
  shipping: { address: "Av. Libertador 1234", city: "Rancagua", region: "O'Higgins", carrier: "blueexpress_manual", tracking_number: null },
  payment: { method: "webpay", status: "approved" },
  ...extra,
});

test("ready: se manda el correo al cliente (sin cuenta no hay push)", async () => {
  const r = await notificarCambioDeEstado({ order: pedido(), status: "ready" });
  assert.deepEqual(r, { email: true, push: false });
});

test("pending no tiene correo: no se avisa nada", async () => {
  const r = await notificarCambioDeEstado({ order: pedido({ status: "pending" }), status: "pending" });
  assert.deepEqual(r, { email: false, push: false });
});

test("cada estado con mensaje para el cliente manda su correo", async () => {
  for (const status of ["paid", "preparing", "shipped", "delivered", "cancelled", "refunded"]) {
    const r = await notificarCambioDeEstado({ order: pedido({ status }), status, note: "Motivo de prueba" });
    assert.equal(r.email, true, `esperaba correo para ${status}`);
  }
});

test("nunca lanza: pedido sin cliente, sin pedido, estado vacío o desconocido", async () => {
  assert.deepEqual(
    await notificarCambioDeEstado({ order: pedido({ customer: null }), status: "ready" }),
    { email: false, push: false },
  );
  assert.deepEqual(await notificarCambioDeEstado({ order: null, status: "ready" }), { email: false, push: false });
  assert.deepEqual(await notificarCambioDeEstado({ order: pedido(), status: "" }), { email: false, push: false });
  assert.deepEqual(await notificarCambioDeEstado({ order: pedido(), status: "marciano" }), { email: false, push: false });
  assert.deepEqual(await notificarCambioDeEstado(), { email: false, push: false });
  // Un pedido roto (sin items ni montos) tampoco revienta al armar la plantilla.
  const r = await notificarCambioDeEstado({ order: { _id: "000000000000000000abc123", customer: { email: "x@y.cl" } }, status: "ready" });
  assert.equal(typeof r.email, "boolean");
});

test("guarda de duplicados: el mismo cambio dos veces seguidas manda un solo correo", async () => {
  const order = pedido();
  const primero = await notificarCambioDeEstado({ order, status: "ready" });
  const segundo = await notificarCambioDeEstado({ order, status: "ready" });
  assert.equal(primero.email, true);
  assert.equal(segundo.email, false);
  // Otro estado del MISMO pedido sí avisa: la clave es pedido + estado.
  const otro = await notificarCambioDeEstado({ order, status: "shipped", trackingNumber: "BX123" });
  assert.equal(otro.email, true);
});

test("pedido creado: manda el correo una vez y no lanza sin correo del cliente", async () => {
  const order = pedido({ status: "pending", payment: { method: "webpay", status: "pending" } });
  assert.deepEqual(await notificarPedidoCreado({ order }), { email: true });
  assert.deepEqual(await notificarPedidoCreado({ order }), { email: false });
  assert.deepEqual(await notificarPedidoCreado({ order: pedido({ customer: {} }) }), { email: false });
  assert.deepEqual(await notificarPedidoCreado(), { email: false });
});
