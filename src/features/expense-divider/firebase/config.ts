// Firebase bootstrap for the trip-debt-calculator feature.
//
// The site must never white-screen when Firebase env vars are absent (e.g. on
// GitHub Pages before secrets are configured, or in local dev without a
// .env.local). Every export here is safe to import unconditionally; callers
// must check `firebaseReady` before relying on `db` / `auth` being defined.

import { initializeApp, type FirebaseApp } from "firebase/app";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

const apiKey: string | undefined = import.meta.env.VITE_FIREBASE_API_KEY;
const authDomain: string | undefined = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
const projectId: string | undefined = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const storageBucket: string | undefined = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
const messagingSenderId: string | undefined = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
const appId: string | undefined = import.meta.env.VITE_FIREBASE_APP_ID;

/** True when the minimum config needed to initialize Firebase is present. */
export const firebaseReady = Boolean(apiKey && projectId && appId);

/**
 * Site key for App Check, which Firebase AI Logic requires. Like the values
 * above it is a public identifier: the reCAPTCHA key is bound to our domain in
 * the Google Cloud console, so a copy of it is no use elsewhere.
 */
export const recaptchaEnterpriseKey: string | undefined = import.meta.env
  .VITE_RECAPTCHA_ENTERPRISE_KEY;

/**
 * 拍收據 is offered only when both Firebase and App Check are configured, so a
 * build without the key behaves exactly as before the feature existed.
 */
export const receiptScanReady = firebaseReady && Boolean(recaptchaEnterpriseKey);

/**
 * `yarn dev` sets this and starts the Auth and Firestore emulators, so trying
 * things out locally never writes to the live database (`yarn dev:live` does).
 * Dead code in a production build. Ports match `firebase.json` → emulators.
 * 拍收據 still calls the real Gemini: AI Logic has no emulator, and reading a
 * receipt writes nothing until the expense is saved, which goes to the emulator.
 */
export const usingEmulators =
  import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "true";

let app: FirebaseApp | undefined;
let db: Firestore | undefined;
let auth: Auth | undefined;

if (apiKey && projectId && appId) {
  app = initializeApp({
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
  });
  db = getFirestore(app);
  auth = getAuth(app);
  if (usingEmulators) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    // Leaves the SDK's "Running in emulator mode" banner on, so a local tab is
    // never mistaken for the live site.
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
  }
}

export { app, db, auth };

/**
 * Ensure there is a signed-in Firebase user and return their uid, signing in
 * anonymously if nobody is signed in yet. Throws when Firebase isn't
 * configured — callers should check `firebaseReady` first.
 */
let signInPromise: Promise<string> | undefined;

export async function ensureAuth(): Promise<string> {
  if (!firebaseReady || !auth) {
    throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars.");
  }
  if (auth.currentUser) {
    return auth.currentUser.uid;
  }
  // Dedupe concurrent sign-ins (e.g. create + join clicked before the first
  // resolves) so the tab never mints two anonymous uids for one session.
  if (!signInPromise) {
    const activeAuth = auth;
    signInPromise = signInAnonymously(activeAuth)
      .then((cred) => cred.user.uid)
      .finally(() => {
        signInPromise = undefined;
      });
  }
  return signInPromise;
}

export interface AccountInfo {
  uid: string;
  /** True while the visitor is the throwaway per-device identity. */
  anonymous: boolean;
  name: string | null;
  email: string | null;
}

function toAccountInfo(user: User | null): AccountInfo | null {
  if (!user) return null;
  return {
    uid: user.uid,
    anonymous: user.isAnonymous,
    name: user.displayName,
    email: user.email,
  };
}

/** Subscribe to the signed-in account. Returns a no-op when unconfigured. */
export function onAccountChange(cb: (account: AccountInfo | null) => void): () => void {
  if (!firebaseReady || !auth) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => cb(toAccountInfo(user)));
}

/**
 * Attach a Google account to the identity this device already uses.
 *
 * Linking rather than signing in fresh is the point: group membership,
 * `createdBy` on every expense, and the settled ticks are all keyed by uid, so
 * a new uid would silently orphan this device's whole history. The one case
 * where the uid must change is when that Google account is already a Firebase
 * user — then the account being signed into wins, and the anonymous identity
 * is abandoned rather than merged (merging two member rows across every group
 * is not something this app can do safely).
 */
export async function signInWithGoogle(): Promise<AccountInfo> {
  if (!firebaseReady || !auth) {
    throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars.");
  }
  const activeAuth = auth;
  const provider = new GoogleAuthProvider();
  await ensureAuth();
  const current = activeAuth.currentUser;

  if (current && current.isAnonymous) {
    try {
      const cred = await linkWithPopup(current, provider);
      return toAccountInfo(cred.user) as AccountInfo;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "auth/credential-already-in-use") {
        const credential = GoogleAuthProvider.credentialFromError(err as never);
        if (credential) {
          const cred = await signInWithCredential(activeAuth, credential);
          return toAccountInfo(cred.user) as AccountInfo;
        }
      }
      throw err;
    }
  }

  const cred = await signInWithPopup(activeAuth, provider);
  return toAccountInfo(cred.user) as AccountInfo;
}

/**
 * Sign out. The next Firestore call signs back in anonymously, so the app keeps
 * working — but as a different uid, which is why the trips this device joined
 * still come from the local identity map rather than the account alone.
 */
export async function signOutAccount(): Promise<void> {
  if (!firebaseReady || !auth) return;
  await signOut(auth);
}
