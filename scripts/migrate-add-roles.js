import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

const migrateRoles = async () => {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/whatsapp-ai",
    );
    console.log("✅ Connected to MongoDB");

    // Find users without role field
    const usersWithoutRole = await User.find({ role: { $exists: false } });
    console.log(
      `\n📊 Found ${usersWithoutRole.length} users without role field`,
    );

    if (usersWithoutRole.length > 0) {
      // Optionally, you can set specific users as admin
      // For example, set admin@gmail.com as admin
      const adminEmails = ["admin@gmail.com", "superadmin@gmail.com"];

      for (const user of usersWithoutRole) {
        if (adminEmails.includes(user.email)) {
          user.role = "admin";
          console.log(`👨‍💼 Set ${user.email} as admin`);
        } else {
          user.role = "user";
          console.log(`👤 Set ${user.email} as user`);
        }
        await user.save();
      }

      console.log(
        `\n✅ Successfully migrated ${usersWithoutRole.length} users`,
      );
    }

    // Show all users with their roles
    console.log("\n📋 All users in database:");
    const allUsers = await User.find({}, "email role createdAt");
    allUsers.forEach((user) => {
      console.log(`  - ${user.email} (role: ${user.role || "N/A"})`);
    });

    await mongoose.connection.close();
    console.log("\n✅ Migration completed and connection closed");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration error:", error.message);
    process.exit(1);
  }
};

migrateRoles();
