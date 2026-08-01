import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ROLES } from "../utils/constants.js";
import { isValidRut } from "../utils/rut.js";

const refreshTokenHashSchema = new mongoose.Schema(
  {
    hash: { type: String, required: true },
    created_at: { type: Date, default: () => new Date() },
    expires_at: { type: Date, required: true },
    device: { type: String, default: null },
    revoked: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password_hash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.CUSTOMER,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    rut: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: (v) => v == null || v === "" || isValidRut(v),
        message: "RUT inválido",
      },
    },

    email_verified: { type: Boolean, default: false },
    email_verification_token_hash: { type: String, default: null, index: true },
    email_verification_expires: { type: Date, default: null },

    reset_password_token_hash: { type: String, default: null, index: true },
    reset_password_expires: { type: Date, default: null },
    password_changed_at: { type: Date, default: null },

    // Presencia: se actualiza (con throttle) en cada request autenticado.
    last_seen: { type: Date, default: null },

    refresh_token_hashes: {
      type: [refreshTokenHashSchema],
      default: [],
      select: false,
    },

    push_token: { type: String, default: null },
    push_token_updated_at: { type: Date, default: null },

    is_active: { type: Boolean, default: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: {
      virtuals: false,
      transform: (_doc, ret) => {
        delete ret.password_hash;
        delete ret.refresh_token_hashes;
        delete ret.email_verification_token_hash;
        delete ret.email_verification_expires;
        delete ret.reset_password_token_hash;
        delete ret.reset_password_expires;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.password_hash;
        delete ret.refresh_token_hashes;
        delete ret.email_verification_token_hash;
        delete ret.email_verification_expires;
        delete ret.reset_password_token_hash;
        delete ret.reset_password_expires;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.methods.comparePassword = function (plain) {
  if (!this.password_hash) return Promise.resolve(false);
  return bcrypt.compare(String(plain || ""), this.password_hash);
};

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
