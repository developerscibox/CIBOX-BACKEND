/**
 * Emite un token de sesión para el panel de bodega, usando el mismo servicio de
 * autenticación del backend. Solo para el entorno LOCAL: sirve para abrir el
 * panel y revisarlo sin escribir credenciales en el formulario.
 *
 *   node emitir-sesion.mjs [correo]
 */
import fs from "node:fs";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const correo = process.argv[2] || "admin@cibox.cl";
const salida = process.argv[3] || "sesion.json";

const { signAccessToken } = await import("./src/services/authService.js");

await mongoose.connect(process.env.MONGO_URI);
const u = await mongoose.connection.collection("users").findOne({ email: correo });
if (!u) {
  console.error(`No existe el usuario ${correo}`);
  process.exit(1);
}

const datos = {
  token: signAccessToken(u),
  user: {
    id: String(u._id),
    _id: String(u._id),
    email: u.email,
    name: u.name,
    role: u.role,
    permissions: u.permissions,
  },
};

fs.writeFileSync(salida, JSON.stringify(datos));
console.log(`sesion de ${u.email} (${u.role}) -> ${salida}`);
await mongoose.disconnect();
