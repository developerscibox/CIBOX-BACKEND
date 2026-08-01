// Siembra los usuarios operativos del panel de bodega (WMS) para probar el RBAC.
// Crea/actualiza gerente, operario y cajero con contraseña común "Test1234!".
// Uso:  node src/scripts/seedWmsUsers.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { ROLES, BCRYPT_ROUNDS } from "../utils/constants.js";

dotenv.config();

const PASSWORD = "Test1234!";

const USERS = [
  { email: "test@bodega12.cl",     name: "Administrador Bodega 12", role: ROLES.ADMIN },
  { email: "gerente@bodega12.cl",  name: "Gerente de Bodega", role: ROLES.MANAGER },
  { email: "vendedor@bodega12.cl", name: "Vendedor de Sala",  role: ROLES.VENDEDOR },
  { email: "cajero@bodega12.cl",   name: "Cajera",            role: ROLES.CASHIER },
  { email: "operario@bodega12.cl", name: "Bodeguero Uno",     role: ROLES.OPERATOR },
  { email: "pantalla@bodega12.cl", name: "Pantalla Kiosko",   role: ROLES.PANTALLA },
];

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ DB conectada");

    const password_hash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);

    for (const u of USERS) {
      await User.updateOne(
        { email: u.email },
        {
          $set: {
            name: u.name,
            role: u.role,
            password_hash,
            email_verified: true,
            is_active: true,
          },
        },
        { upsert: true },
      );
      console.log(`👤 ${u.role.padEnd(9)} → ${u.email}  (pass: ${PASSWORD})`);
    }

    console.log("🎉 Usuarios WMS creados/actualizados");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
};

run();
