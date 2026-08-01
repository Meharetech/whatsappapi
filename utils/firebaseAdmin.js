import admin from "firebase-admin";

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

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );

  const data = await response.json();
  if (!response.ok || !Array.isArray(data?.users) || data.users.length === 0) {
    const reason = data?.error?.message || "Unable to validate Firebase token";
    throw new Error(`Firebase REST verification failed: ${reason}`);
  }

  const profile = data.users[0];
  return {
    uid: profile.localId,
    email: profile.email,
    email_verified: !!profile.emailVerified,
    name: profile.displayName || "",
    picture: profile.photoUrl || "",
  };
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

  const signInResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  const signInData = await signInResponse.json();
  if (!signInResponse.ok || !signInData?.idToken) {
    return {
      verified: false,
      reason: signInData?.error?.message || "Unable to sign in with Firebase",
    };
  }

  const lookupResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: signInData.idToken }),
    },
  );

  const lookupData = await lookupResponse.json();
  if (!lookupResponse.ok || !Array.isArray(lookupData?.users)) {
    return {
      verified: false,
      reason:
        lookupData?.error?.message || "Unable to fetch Firebase user profile",
    };
  }

  const profile = lookupData.users[0];
  return { verified: !!profile?.emailVerified };
};

export default {
  getFirebaseAdmin,
  verifyFirebaseIdToken,
  isFirebaseEmailPasswordVerified,
};
