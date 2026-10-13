import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";
import SubscriptionService from "../services/SubscriptionService.js";

dotenv.config();

const makeAdmin = async () => {
  const email = process.argv[2];
  const password = process.argv[3];
  const role = process.argv[4] || "admin";

  if (!email) {
    console.log(`
Usage:
  node scripts/make-admin.js <email> [password] [role]

Examples:
  1. Promote existing user:
     node scripts/make-admin.js admin@example.com

  2. Create new admin account:
     node scripts/make-admin.js admin@example.com AdminPass123 admin
    `);
    process.exit(1);
  }

  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/whatsapp-ai";
    console.log("Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("✅ MongoDB connected");

    const cleanEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: cleanEmail });

    if (user) {
      user.role = role;
      if (password) {
        user.password = password;
      }
      user.emailVerified = true;
      await user.save();
      console.log(`\n🎉 Success! Existing user '${cleanEmail}' updated to role: '${role}'`);
    } else {
      if (!password) {
        console.error(`\n❌ User '${cleanEmail}' not found. To create a new admin, please provide a password:\n   node scripts/make-admin.js ${cleanEmail} yourPassword123 admin`);
        process.exit(1);
      }

      user = new User({
        name: "Admin User",
        email: cleanEmail,
        password: password,
        role: role,
        emailVerified: true,
        authProvider: "local"
      });
      await user.save();
      await SubscriptionService.ensureUserSubscription(user);
      console.log(`\n🎉 Success! Created new ${role} account: '${cleanEmail}'`);
    }

    console.log(`
--------------------------------------------------
Login Credentials:
  Email:    ${cleanEmail}
  Password: ${password || "(unchanged)"}
  Role:     ${user.role}

Admin Portal URL:
  http://localhost:5173/admin
--------------------------------------------------
    `);

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
};

makeAdmin();
