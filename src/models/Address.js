import mongoose from "mongoose";
import { isValidRut } from "../utils/rut.js";

const addressSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: { type: String, default: "", trim: true, maxlength: 60 },
    full_name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    rut: {
      type: String,
      default: "",
      trim: true,
      validate: {
        validator: (v) => !v || isValidRut(v),
        message: "RUT inválido",
      },
    },
    street: { type: String, required: true, trim: true, maxlength: 200 },
    number: { type: String, default: "", trim: true, maxlength: 30 },
    apartment: { type: String, default: "", trim: true, maxlength: 60 },
    commune: { type: String, required: true, trim: true, maxlength: 100 },
    region: { type: String, required: true, trim: true, maxlength: 100 },
    postal_code: { type: String, default: "", trim: true, maxlength: 20 },
    is_default: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

addressSchema.index({ user_id: 1, is_default: -1 });

addressSchema.pre("save", async function (next) {
  if (this.is_default && this.user_id) {
    try {
      await this.constructor.updateMany(
        { user_id: this.user_id, _id: { $ne: this._id }, is_default: true },
        { $set: { is_default: false } }
      );
    } catch (err) {
      return next(err);
    }
  }
  next();
});

export const Address = mongoose.models.Address || mongoose.model("Address", addressSchema);
export default Address;
