// Inisialisasi Firebase (SDK modular dari CDN resmi Google).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.languageCode = "id";

// Cache lokal (IndexedDB) membuat aplikasi terasa instan & hemat kuota baca.
// Cache dibersihkan saat logout (lihat logout() di app.js).
let firestore;
try {
  firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  console.warn("Persistent cache tidak tersedia, memakai cache memori.", e);
  firestore = initializeFirestore(app, {});
}
export const db = firestore;

export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updateProfile, sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

export {
  collection, doc, getDoc, getDocFromServer, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit,
  serverTimestamp, writeBatch, Bytes, terminate, clearIndexedDbPersistence, Timestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
