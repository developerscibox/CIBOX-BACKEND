import mongoose from "mongoose";
import { isValidRut } from "../utils/rut.js";

const bankInfoSchema = new mongoose.Schema(
  {
    bank: { type: String, trim: true, default: null },
    account_type: { type: String, trim: true, default: null },
    account_number: { type: String, trim: true, default: null },
    holder_name: { type: String, trim: true, default: null },
    holder_rut: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: (v) => v == null || v === "" || isValidRut(v),
        message: "RUT del titular inválido",
      },
    },
  },
  { _id: false }
);

const statsSchema = new mongoose.Schema(
  {
    total_sales: { type: Number, default: 0, min: 0 },
    total_orders: { type: Number, default: 0, min: 0 },
    avg_rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews_count: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const vendorSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    rut: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: (v) => v == null || v === "" || isValidRut(v),
        message: "RUT inválido",
      },
    },
    description: { type: String, trim: true, default: "" },
    logo_url: { type: String, trim: true, default: null },
    banner_url: { type: String, trim: true, default: null },

    commune: { type: String, trim: true, default: null },
    region: { type: String, trim: true, default: null },
    address: { type: String, trim: true, default: null },

    is_active: { type: Boolean, default: true },
    is_verified: { type: Boolean, default: false },
    commission_rate: { type: Number, default: 0.1, min: 0, max: 1 },

    stats: { type: statsSchema, default: () => ({}) },
    bank_info: { type: bankInfoSchema, default: () => ({}) },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: {
      transform: (_doc, ret) => {
        if (ret.bank_info) {
          delete ret.bank_info.account_number;
        }
        delete ret.__v;
        return ret;
      },
    },
  }
);

vendorSchema.index({ user_id: 1 }, { unique: true });
vendorSchema.index({ is_active: 1, is_verified: 1 });
vendorSchema.index({ commune: 1 });

export const Vendor = mongoose.models.Vendor || mongoose.model("Vendor", vendorSchema);
export default Vendor;
