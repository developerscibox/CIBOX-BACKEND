import mongoose from "mongoose";

const userMissionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    mission_key: {
      type: String,
      required: true,
    },
    completed_at: {
      type: Date,
      default: null,
    },
    reward_claimed: {
      type: Boolean,
      default: false,
    },
    reward_code: {
      type: String,
      default: null,
    },
    reward_coupon_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

userMissionSchema.index({ user_id: 1, mission_key: 1 }, { unique: true });

export const UserMission =
  mongoose.models.UserMission || mongoose.model("UserMission", userMissionSchema);
export default UserMission;