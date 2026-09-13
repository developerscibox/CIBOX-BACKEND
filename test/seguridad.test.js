import test from "node:test";
import assert from "node:assert/strict";

import { addItemSchema, updateItemSchema } from "../src/validators/cartValidators.js";
import { loginSchema, registerSchema } from "../src/validators/authValidators.js";
import { createFromCartSchema } from "../src/validators/orderValidators.js";

// Evidencia de las tareas 1.2 y 1.12 del plan de seguridad: el precio nunca se
// acepta del cliente, y los operadores de Mongo no pasan de la validación.

// ── 1.2 El cliente no fija precios ──────────────────────────────────────────

test("agregar al carrito: el precio que manda el cliente se ignora", () => {
  const r = addItemSchema.body.safeParse({
    productId: "66b1f0c9e4b0a1a2b3c4d5e6",
    quantity: 2,
    price: 1,
    unit_price: 1,
    subtotal: 1,
  });
  assert.equal(r.success, true);
  assert.equal("price" in r.data, false);
  assert.equal("unit_price" in r.data, false);
  assert.equal("subtotal" in r.data, false);
});

test("actualizar cantidad: tampoco acepta precio", () => {
  const r = updateItemSchema.body.safeParse({ quantity: 3, unit_price: 1 });
  assert.equal(r.success, true);
  assert.equal("unit_price" in r.data, false);
});

test("crear orden: el esquema no tiene ningún campo de monto ni de precio", () => {
  // La orden se arma en el servidor desde el carrito guardado; el cliente solo
  // manda datos de contacto, envío y pago. Si algún día alguien agrega `total`
  // o `items[].price` al esquema, este test lo delata.
  const campos = Object.keys(createFromCartSchema.body.shape);
  for (const prohibido of ["total", "subtotal", "items", "price", "unit_price", "amount"]) {
    assert.equal(campos.includes(prohibido), false, `el esquema acepta "${prohibido}"`);
  }
});

// ── 1.12 Operadores de Mongo en el login ────────────────────────────────────

test("login con {$ne: null} en el correo se rechaza con 400, no llega a Mongo", () => {
  const r = loginSchema.safeParse({ email: { $ne: null }, password: "x" });
  assert.equal(r.success, false);
  assert.equal(r.error.issues[0].path[0], "email");
});

test("login con objeto en la contraseña se rechaza", () => {
  const r = loginSchema.safeParse({ email: "a@b.cl", password: { $gt: "" } });
  assert.equal(r.success, false);
});

// ── 1.9 Política de contraseña ──────────────────────────────────────────────

test("registro: contraseña de 7 caracteres se rechaza", () => {
  const r = registerSchema.safeParse({
    name: "Prueba",
    email: "prueba@cibox.cl",
    password: "1234567",
    phone: "+56912345678",
  });
  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((i) => i.path[0] === "password"));
});
