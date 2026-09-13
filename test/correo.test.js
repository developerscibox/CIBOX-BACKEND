import test from "node:test";
import assert from "node:assert/strict";

// EMAIL_TRANSPORT=off deja el servicio sin transporte: las pruebas no mandan
// correo de verdad, solo comprueban el contrato que ven los 7 puntos de llamada.
process.env.EMAIL_TRANSPORT = "off";

const { sendEmail, normalizarDestinatarios } = await import("../src/services/emailService.js");

test("varios destinatarios en una cadena con comas se parten uno por uno", () => {
  // Es lo que manda paymentController con recipients.join(","). Mientras esto no
  // se partía, Resend recibía una única dirección malformada, respondía 422 y la
  // notificación de compra pagada no le llegaba a nadie.
  assert.deepEqual(
    normalizarDestinatarios("developers@cibox.cl,proveedor@otro.cl"),
    ["developers@cibox.cl", "proveedor@otro.cl"],
  );
  assert.deepEqual(
    normalizarDestinatarios("uno@cibox.cl , dos@cibox.cl "),
    ["uno@cibox.cl", "dos@cibox.cl"],
  );
});

test("un destinatario suelto sigue siendo uno", () => {
  assert.deepEqual(normalizarDestinatarios("cliente@cibox.cl"), ["cliente@cibox.cl"]);
  assert.deepEqual(normalizarDestinatarios(["a@cibox.cl", "b@cibox.cl"]), ["a@cibox.cl", "b@cibox.cl"]);
});

test("lo vacío no se cuela como destinatario", () => {
  assert.deepEqual(normalizarDestinatarios(""), []);
  assert.deepEqual(normalizarDestinatarios(null), []);
  assert.deepEqual(normalizarDestinatarios(undefined), []);
  assert.deepEqual(normalizarDestinatarios("a@cibox.cl,,  ,b@cibox.cl"), ["a@cibox.cl", "b@cibox.cl"]);
});

test("sendEmail nunca lanza, pase lo que pase", async () => {
  // El registro de usuarios y el checkout esperan a sendEmail. Si lanzara, un
  // problema de correo tumbaría el alta de una cuenta o el cierre de una compra,
  // que es justo lo que no puede pasar.
  for (const entrada of [
    { to: "a@cibox.cl", subject: "s", text: "t" },
    { to: "", subject: "s", text: "t" },
    { to: null, subject: "s" },
    {},
  ]) {
    const r = await sendEmail(entrada);
    assert.equal(typeof r, "object");
    assert.equal(r.sent, false);
    assert.equal(typeof r.reason, "string");
  }
});

test("sin transporte el correo se descarta, no se finge enviado", async () => {
  const r = await sendEmail({ to: "cliente@cibox.cl", subject: "Hola", text: "Hola" });
  assert.equal(r.sent, false);
  // Que devuelva sent:false es lo que permite distinguir "no salió" de "salió":
  // dar por enviado lo que se descartó es como se pierde el rastro de un correo.
  assert.ok(r.reason);
});
