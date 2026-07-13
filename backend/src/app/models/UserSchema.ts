
import mongoose, { model, models } from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: false },
  email: { type: String, required: false, unique: true },
  image: { type: String, required: false },
  access_token: { type: String, required: false },
  refresh_token: { type: String, required: false },
  githubId: { type: String, required: true },

}, { timestamps: true });


export const User = models.User || model("User", userSchema);
