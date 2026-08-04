import admin from "firebase-admin";
import axios from "axios";

let firebaseApp = null;

const getServiceAccount = () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.error("Missing Firebase Config:", {
      projectId: !!projectId,
      clientEmail: !!clientEmail,
      privateKey: !!privateKey,
    });
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
};

export const getFirebaseAdmin = () => {
  if (firebaseApp) return firebaseApp;

  const serviceAccount = getServiceAccount();
  if (!serviceAccount) {
    throw new Error(
      "Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.",
    );
  }

  if (!admin.apps.length) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    firebaseApp = admin.app();
  }

  return firebaseApp;
};

const verifyFirebaseIdTokenViaRest = async (idToken) => {
  const apiKey =
    process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Firebase verification is not configured. Set Firebase Admin credentials or FIREBASE_WEB_API_KEY.",
    );
  }

  try {
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { idToken },
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;
    if (!Array.isArray(data?.users) || data.users.length === 0) {
      throw new Error("Unable to validate Firebase token: Profile not found");
    }

    const profile = data.users[0];
    return {
      uid: profile.localId,
      email: profile.email,
      email_verified: !!profile.emailVerified,
      name: profile.displayName || "",
      picture: profile.photoUrl || "",
    };
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message || "Unable to validate Firebase token";
    throw new Error(`Firebase REST verification failed: ${reason}`);
  }
};

export const verifyFirebaseIdToken = async (idToken) => {
  try {
    const app = getFirebaseAdmin();
    return await app.auth().verifyIdToken(idToken);
  } catch (err) {
    // Fallback for environments where Firebase Admin credentials are not set.
    return verifyFirebaseIdTokenViaRest(idToken);
  }
};

export const isFirebaseEmailPasswordVerified = async (email, password) => {
  const apiKey =
    process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;

  if (!apiKey) {
    return {
      verified: false,
      reason:
        "FIREBASE_WEB_API_KEY is missing. Cannot check email verification.",
    };
  }

  try {
    const signInResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      { email, password, returnSecureToken: true },
      { headers: { "Content-Type": "application/json" } }
    );

    const signInData = signInResponse.data;
    if (!signInData?.idToken) {
      return {
        verified: false,
        reason: "Unable to sign in with Firebase: missing ID token",
      };
    }

    const lookupResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { idToken: signInData.idToken },
      { headers: { "Content-Type": "application/json" } }
    );

    const lookupData = lookupResponse.data;
    if (!Array.isArray(lookupData?.users) || lookupData.users.length === 0) {
      return {
        verified: false,
        reason: "Unable to fetch Firebase user profile",
      };
    }

    const profile = lookupData.users[0];
    return { verified: !!profile?.emailVerified };
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message || "Firebase REST request failed";
    return {
      verified: false,
      reason,
    };
  }
};

export default {
  getFirebaseAdmin,
  verifyFirebaseIdToken,
  isFirebaseEmailPasswordVerified,
};
