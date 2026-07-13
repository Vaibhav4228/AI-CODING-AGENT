import mongoose from "mongoose";

export async function dbConnection() {
  try {
    await mongoose.connect(process.env.DB_URL as string);
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}
