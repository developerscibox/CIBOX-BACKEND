import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import Product from "../models/Product.js";
import Sector from "../models/Sector.js";
import { ROLES, BCRYPT_ROUNDS } from "../utils/constants.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// Seed idempotente de PRODUCCIÓN al arrancar (usa la MONGO_URI del entorno).
// Solo AÑADE lo que falte: sectores y la asignación de sector a productos.
// NO crea pedidos demo (mantiene prod limpio). La creación de cuentas operativas
// está DESACTIVADA por defecto: solo ocurre con SEED_RELAY_USERS=true +
// SEED_RELAY_PASSWORD provista — nunca con contraseña hardcodeada. Nunca rompe el arranque.

const USERS = [
  { email: "test@bodega12.cl", name: "Administrador Bodega 12", role: ROLES.ADMIN },
  { email: "gerente@bodega12.cl", name: "Gerente de Bodega", role: ROLES.MANAGER },
  { email: "vendedor@bodega12.cl", name: "Vendedor de Sala", role: ROLES.VENDEDOR },
  { email: "cajero@bodega12.cl", name: "Cajera", role: ROLES.CASHIER },
  { email: "operario@bodega12.cl", name: "Bodeguero Uno", role: ROLES.OPERATOR },
  { email: "pantalla@bodega12.cl", name: "Pantalla Kiosko", role: ROLES.PANTALLA },
];

const SECTORES = [
  { nombre: "Lácteos y refrigerados", orden: 1 },
  { nombre: "Abarrotes", orden: 2 },
  { nombre: "Bebidas y licores", orden: 3 },
  { nombre: "Limpieza y aseo", orden: 4 },
  { nombre: "Snacks y confites", orden: 5 },
];

const REGLAS = [
  [/leche|yogur|queso|mantequilla|margarina|crema|huevo|refriger/i, "Lácteos y refrigerados"],
  [/bebida|jugo|agua|cerveza|vino|gaseosa|n[eé]ctar|energ|pisco|ron/i, "Bebidas y licores"],
  [/detergente|cloro|jab[oó]n|lavaloza|papel|toalla|shampoo|pasta dental|aseo|limpia|desinfect/i, "Limpieza y aseo"],
  [/galleta|papas|snack|chocolate|dulce|caramelo|ramita|suflito|confite|man[ií]/i, "Snacks y confites"],
];
const clasificar = (nombre = "") => {
  for (const [re, s] of REGLAS) if (re.test(nombre)) return s;
  return "Abarrotes";
};

// Creación de cuentas operativas: SOLO si está explícitamente habilitada y se
// entregó una contraseña por entorno. Sin flag → no toca usuarios (prod no crea
// admins con contraseña conocida). El password nunca se hardcodea.
const seedUsers = async () => {
  if (!env.SEED_RELAY_USERS) return;
  const pass = String(env.SEED_RELAY_PASSWORD || "");
  if (pass.length < 8) {
    logger.warn(
      "ensureRelaySeed: SEED_RELAY_USERS activo pero SEED_RELAY_PASSWORD ausente o débil (<8) → se omite la creación de usuarios",
    );
    return;
  }
  // La contraseña solo se fija al CREAR ($setOnInsert): nunca pisa la de un usuario existente.
  const hash = await bcrypt.hash(pass, BCRYPT_ROUNDS);
  for (const u of USERS) {
    await User.updateOne(
      { email: u.email },
      { $set: { name: u.name, role: u.role, email_verified: true, is_active: true }, $setOnInsert: { password_hash: hash } },
      { upsert: true },
    );
  }
  logger.info({ usuarios: USERS.length }, "ensureRelaySeed: cuentas operativas aseguradas (bootstrap habilitado)");
};

export const ensureRelaySeed = async () => {
  try {
    await seedUsers();

    // Sectores: solo si la colección está vacía.
    if ((await Sector.estimatedDocumentCount()) === 0) {
      await Sector.insertMany(SECTORES);
      logger.info("ensureRelaySeed: sectores sembrados");
    }

    // Asignar sector a los productos que no lo tengan (sin $-operators de input → sin sanitizer).
    const prods = await Product.find({}).select("_id name location").lean();
    let asignados = 0;
    for (const p of prods) {
      if (!p.location?.sector) {
        await Product.updateOne({ _id: p._id }, { $set: { "location.sector": clasificar(p.name) } });
        asignados++;
      }
    }

    logger.info({ sectorAsignados: asignados }, "ensureRelaySeed OK");
  } catch (e) {
    logger.warn({ err: e.message }, "ensureRelaySeed falló (no crítico, el arranque sigue)");
  }
};

export default ensureRelaySeed;
