/**
 * Asciende una cuenta existente a administrador y le deja una contraseña nueva.
 *
 * POR QUÉ EXISTE: el panel no permite crear usuarios (solo listar y cambiar
 * roles), y los administradores solo pueden nacer de otro administrador. Si el
 * único admin pierde su clave —que fue justo lo que pasó— el sistema queda sin
 * llave y sin forma de recuperarla desde la aplicación. Este script es esa
 * salida de emergencia, para usar desde el servidor.
 *
 * La contraseña NO se pasa por argumento: quedaría en el historial del shell y
 * en la lista de procesos, visible para cualquiera con acceso a la máquina. Se
 * lee de la variable de entorno ADMIN_PASSWORD.
 *
 * Uso:
 *   ADMIN_PASSWORD='...' node scripts/ascenderAdmin.js correo@ejemplo.cl
 *   ADMIN_PASSWORD='...' node scripts/ascenderAdmin.js correo@ejemplo.cl --crear
 *   ADMIN_PASSWORD='...' node scripts/ascenderAdmin.js correo@ejemplo.cl --crear --rol=operator
 *
 * Con --crear, si la cuenta no existe, la crea. Sin eso, solo asciende cuentas
 * que ya existan (más seguro: evita crear un admin por escribir mal el correo).
 *
 * --rol por defecto es admin, pero acepta manager y operator: si no, es muy
 * fácil terminar creando administradores para gente que solo necesita preparar
 * pedidos.
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "../src/config/db.js";
import { BCRYPT_ROUNDS, PASSWORD_MIN_LENGTH, ROLES } from "../src/utils/constants.js";

const email = (process.argv[2] || "").trim().toLowerCase();
const crear = process.argv.includes("--crear");
const argRol = (process.argv.find((a) => a.startsWith("--rol=")) || "").split("=")[1];
const rol = (argRol || ROLES.ADMIN).toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";

const ROLES_VALIDOS = [ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR];

const main = async () => {
  if (!email || !email.includes("@")) {
    console.error("✗ Falta el correo. Uso: ADMIN_PASSWORD='...' node scripts/ascenderAdmin.js correo@ejemplo.cl");
    process.exit(1);
  }
  if (!ROLES_VALIDOS.includes(rol)) {
    console.error(`✗ Rol no válido: "${rol}". Usa uno de: ${ROLES_VALIDOS.join(", ")}`);
    process.exit(1);
  }
  const minimo = PASSWORD_MIN_LENGTH || 8;
  if (password.length < minimo) {
    console.error(`✗ ADMIN_PASSWORD debe tener al menos ${minimo} caracteres.`);
    process.exit(1);
  }

  await connectDB();
  const col = mongoose.connection.db.collection("users");
  const actual = await col.findOne({ email });

  if (!actual && !crear) {
    console.error(`✗ No existe la cuenta ${email}. Si quieres crearla, agrega --crear.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const ahora = new Date();
  const nombre =
    rol === ROLES.OPERATOR ? "Operaciones" : rol === ROLES.MANAGER ? "Gerencia" : "Administrador";

  if (actual) {
    console.log(`  cuenta encontrada: ${actual.name || "(sin nombre)"} · rol actual: ${actual.role}`);
    await col.updateOne(
      { _id: actual._id },
      {
        $set: {
          role: rol,
          password_hash: hash,
          password_changed_at: ahora,
          // Verificado, si no algunos flujos (recuperación incluida) lo tratan
          // como cuenta a medio registrar.
          email_verified: true,
          is_active: true,
          updated_at: ahora,
          // Invalida cualquier enlace de recuperación que estuviera dando vueltas.
          reset_password_token_hash: null,
          reset_password_expires: null,
        },
      },
    );
    console.log(`  ✓ ${email} ahora tiene rol "${rol}" y contraseña nueva`);
  } else {
    await col.insertOne({
      name: nombre,
      email,
      password_hash: hash,
      role: rol,
      is_active: true,
      email_verified: true,
      created_at: ahora,
      updated_at: ahora,
      password_changed_at: ahora,
    });
    console.log(`  ✓ cuenta ${email} creada con rol "${rol}"`);
  }

  const admins = await col.countDocuments({ role: ROLES.ADMIN });
  console.log(`  administradores en el sistema: ${admins}`);
  console.log("\n  ⚠️  Cambia esta contraseña apenas entres: pasó por un canal que no es seguro.\n");

  await mongoose.disconnect();
};

main().catch(async (e) => {
  console.error("✗", e.message);
  await mongoose.disconnect();
  process.exit(1);
});
