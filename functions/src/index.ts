/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { DateTime } from "luxon";
// import { onCall } from "firebase-functions/v2/https";
// import * as logger from "firebase-functions/logger";

// import {onRequest} from "firebase-functions/https";
// import * as logger from "firebase-functions/logger";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

setGlobalOptions({ maxInstances: 10 });

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

admin.initializeApp();

const BATCH_SIZE = 400;
const FCM_BATCH_SIZE = 500;
const SCAN_READ_PAGE_SIZE = 800;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_WEEKS = 4;

type ScanDocData = {
  dateOfScan?: unknown;
  imageUrl?: string;
};

type StorageReference = {
  bucketName: string | null;
  objectPath: string;
};

type CleanupResult = {
  deleted: number;
  chunks: number;
  deleteAttempted: number;
  scanned: number;
  missingDate: number;
  invalidDate: number;
  storageDeleteAttempted: number;
  storageDeleteFailed: number;
  storageDeleted: number;
};

function getDefaultBucketSafe() {
  try {
    return admin.storage().bucket();
  } catch (error) {
    console.warn(
      "Default Storage bucket is unavailable. Firestore records will still be deleted.",
      error,
    );
    return null;
  }
}

function parseStorageReferenceFromImageUrl(imageUrl: string): StorageReference | null {
  const rawValue = imageUrl.trim();
  if (!rawValue) {
    return null;
  }

  if (rawValue.startsWith("gs://")) {
    try {
      const withoutScheme = rawValue.slice("gs://".length);
      const slashIndex = withoutScheme.indexOf("/");
      if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
        return null;
      }

      const bucketName = decodeURIComponent(withoutScheme.slice(0, slashIndex));
      const objectPath = decodeURIComponent(withoutScheme.slice(slashIndex + 1));
      if (!bucketName || !objectPath) {
        return null;
      }

      return {
        bucketName,
        objectPath,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsedUrl = new URL(rawValue);

    // Example:
    // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodedPath>?alt=media&token=...
    const firebaseApiMatch = parsedUrl.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (firebaseApiMatch) {
      const bucketName = decodeURIComponent(firebaseApiMatch[1]);
      const objectPath = decodeURIComponent(firebaseApiMatch[2]);
      if (!bucketName || !objectPath) {
        return null;
      }

      return {
        bucketName,
        objectPath,
      };
    }

    // Example:
    // https://<bucket>.firebasestorage.app/o/<encodedPath>?...
    const firebaseAppHostMatch = parsedUrl.hostname.match(
      /^(.+)\.firebasestorage\.app$/,
    );
    const firebaseAppPathMatch = parsedUrl.pathname.match(/^\/o\/(.+)$/);
    if (firebaseAppHostMatch && firebaseAppPathMatch) {
      const bucketName = decodeURIComponent(firebaseAppHostMatch[1]);
      const objectPath = decodeURIComponent(firebaseAppPathMatch[1]);
      if (!bucketName || !objectPath) {
        return null;
      }

      return {
        bucketName,
        objectPath,
      };
    }

    // Example:
    // https://storage.googleapis.com/<bucket>/<objectPath>
    if (parsedUrl.hostname === "storage.googleapis.com") {
      const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
      if (pathSegments.length >= 2) {
        const bucketName = decodeURIComponent(pathSegments[0]);
        const objectPath = decodeURIComponent(pathSegments.slice(1).join("/"));
        if (!bucketName || !objectPath) {
          return null;
        }

        return {
          bucketName,
          objectPath,
        };
      }
    }

    // Fallback: parse path only and use default bucket.
    const genericObjectMatch = parsedUrl.pathname.match(/\/o\/(.+)$/);
    if (genericObjectMatch) {
      const objectPath = decodeURIComponent(genericObjectMatch[1]);
      if (!objectPath) {
        return null;
      }

      return {
        bucketName: null,
        objectPath,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function getStartOfUtcDayMs(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

function getStartOfCurrentWeekUtcMs(date: Date): number {
  // Monday = week start (ISO-like), Sunday = end of week.
  const dayOfWeek = date.getUTCDay(); // 0..6 (Sun..Sat)
  const daysFromMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return getStartOfUtcDayMs(date) - daysFromMonday * DAY_MS;
}

function getRetentionWindowStartUtcMs(date: Date): number {
  const startOfCurrentWeekUtcMs = getStartOfCurrentWeekUtcMs(date);
  // Keep current week + previous 3 weeks => total 4 weeks.
  return startOfCurrentWeekUtcMs - (RETENTION_WEEKS - 1) * 7 * DAY_MS;
}

function parseScanDate(rawValue: unknown): Date | null {
  if (!rawValue) {
    return null;
  }

  if (rawValue instanceof admin.firestore.Timestamp) {
    return rawValue.toDate();
  }

  if (rawValue instanceof Date) {
    return Number.isNaN(rawValue.getTime()) ? null : rawValue;
  }

  if (typeof rawValue === "number") {
    // Support both seconds and milliseconds unix timestamps.
    const milliseconds = rawValue > 1_000_000_000_000 ? rawValue : rawValue * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof rawValue === "string") {
    const date = new Date(rawValue);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof rawValue === "object") {
    const objectValue = rawValue as {
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
      nanoseconds?: number;
      _nanoseconds?: number;
    };

    if (typeof objectValue.toDate === "function") {
      const date = objectValue.toDate();
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const seconds =
      typeof objectValue.seconds === "number" ?
        objectValue.seconds :
        typeof objectValue._seconds === "number" ?
          objectValue._seconds :
          null;
    const nanoseconds =
      typeof objectValue.nanoseconds === "number" ?
        objectValue.nanoseconds :
        typeof objectValue._nanoseconds === "number" ?
          objectValue._nanoseconds :
          0;

    if (seconds !== null) {
      const date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000));
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  return null;
}

function isScanOlderThanRetentionWindow(
  scanDate: Date,
  retentionWindowStartUtcMs: number,
): boolean {
  const scanStartOfDayUtcMs = getStartOfUtcDayMs(scanDate);
  return scanStartOfDayUtcMs < retentionWindowStartUtcMs;
}

function mapToHttpsErrorCode(error: unknown): functions.https.FunctionsErrorCode {
  const err = error as {
    code?: unknown;
    message?: unknown;
  };

  const code = String(err?.code ?? "").toLowerCase();
  const message = String(err?.message ?? "").toLowerCase();

  if (
    code.includes("unauthenticated") ||
    code.startsWith("16") ||
    message.includes("unauthenticated")
  ) {
    return "unauthenticated";
  }

  if (
    code.includes("permission-denied") ||
    code.includes("permission_denied") ||
    code.startsWith("7") ||
    message.includes("permission_denied")
  ) {
    return "permission-denied";
  }

  if (
    code.includes("failed-precondition") ||
    code.includes("failed_precondition") ||
    code.startsWith("9") ||
    message.includes("failed_precondition")
  ) {
    return "failed-precondition";
  }

  if (
    code.includes("not-found") ||
    code.includes("not_found") ||
    code.startsWith("5") ||
    message.includes("not_found")
  ) {
    return "not-found";
  }

  if (
    code.includes("deadline-exceeded") ||
    code.includes("deadline_exceeded") ||
    code.startsWith("4") ||
    message.includes("deadline exceeded")
  ) {
    return "deadline-exceeded";
  }

  if (
    code.includes("resource-exhausted") ||
    code.includes("resource_exhausted") ||
    code.startsWith("8") ||
    message.includes("resource_exhausted")
  ) {
    return "resource-exhausted";
  }

  return "internal";
}

async function getOldScanDocs(
  db: admin.firestore.Firestore,
  retentionWindowStartUtcMs: number,
) {
  const oldScanDocs: admin.firestore.QueryDocumentSnapshot[] = [];
  let scannedCount = 0;
  let missingDateCount = 0;
  let invalidDateCount = 0;
  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let query = db
      .collectionGroup("scans")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(SCAN_READ_PAGE_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    for (const doc of snapshot.docs) {
      scannedCount += 1;
      const data = doc.data() as ScanDocData;
      const scanDate = parseScanDate(data.dateOfScan);

      if (data.dateOfScan === undefined || data.dateOfScan === null) {
        missingDateCount += 1;
        continue;
      }

      if (!scanDate) {
        invalidDateCount += 1;
        continue;
      }

      if (isScanOlderThanRetentionWindow(scanDate, retentionWindowStartUtcMs)) {
        oldScanDocs.push(doc);
      }
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < SCAN_READ_PAGE_SIZE) {
      break;
    }
  }

  return {
    docs: oldScanDocs,
    scannedCount,
    missingDateCount,
    invalidDateCount,
  };
}

async function deleteScanDocsInChunks(
  db: admin.firestore.Firestore,
  docs: admin.firestore.QueryDocumentSnapshot[],
  defaultBucket: ReturnType<typeof getDefaultBucketSafe>,
) {
  let deletedCount = 0;
  let chunkCount = 0;
  let storageDeleteAttempted = 0;
  let storageDeleteFailed = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    const storageDeletes: Promise<void>[] = [];

    chunk.forEach((doc) => {
      const data = doc.data() as ScanDocData;
      batch.delete(doc.ref);

      if (!data.imageUrl) {
        return;
      }

      const storageRef = parseStorageReferenceFromImageUrl(data.imageUrl);
      if (!storageRef) {
        return;
      }

      const targetBucket =
        storageRef.bucketName ?
          admin.storage().bucket(storageRef.bucketName) :
          defaultBucket;

      if (!targetBucket) {
        return;
      }

      storageDeleteAttempted += 1;
      storageDeletes.push(
        targetBucket
          .file(storageRef.objectPath)
          .delete()
          .then(() => undefined)
          .catch((error: { code?: unknown }) => {
            const code = String(error?.code ?? "").toLowerCase();
            if (
              code === "404" ||
              code.includes("not-found") ||
              code.includes("not_found")
            ) {
              return;
            }
            throw error;
          }),
      );
    });

    await batch.commit();

    const storageResults = await Promise.allSettled(storageDeletes);
    for (const result of storageResults) {
      if (result.status === "rejected") {
        storageDeleteFailed += 1;
        console.warn("Failed to delete scan image from Storage", result.reason);
      }
    }

    deletedCount += chunk.length;
    chunkCount += 1;
  }

  return {
    deletedCount,
    chunkCount,
    storageDeleteAttempted,
    storageDeleteFailed,
  };
}

async function cleanupOldScansAndImages(
  db: admin.firestore.Firestore,
  bucket: ReturnType<typeof getDefaultBucketSafe>,
  retentionWindowStartUtcMs: number,
): Promise<CleanupResult> {
  const {
    docs,
    scannedCount,
    missingDateCount,
    invalidDateCount,
  } = await getOldScanDocs(db, retentionWindowStartUtcMs);

  if (docs.length === 0) {
    return {
      deleted: 0,
      chunks: 0,
      deleteAttempted: 0,
      scanned: scannedCount,
      missingDate: missingDateCount,
      invalidDate: invalidDateCount,
      storageDeleteAttempted: 0,
      storageDeleteFailed: 0,
      storageDeleted: 0,
    };
  }

  const {
    deletedCount,
    chunkCount,
    storageDeleteAttempted,
    storageDeleteFailed,
  } = await deleteScanDocsInChunks(db, docs, bucket);

  return {
    deleted: deletedCount,
    chunks: chunkCount,
    deleteAttempted: docs.length,
    scanned: scannedCount,
    missingDate: missingDateCount,
    invalidDate: invalidDateCount,
    storageDeleteAttempted,
    storageDeleteFailed,
    storageDeleted: storageDeleteAttempted - storageDeleteFailed,
  };
}

async function runDeleteOldScansCleanup(): Promise<CleanupResult> {
  const db = admin.firestore();
  const bucket = getDefaultBucketSafe();
  const retentionWindowStartUtcMs = getRetentionWindowStartUtcMs(new Date());
  return cleanupOldScansAndImages(db, bucket, retentionWindowStartUtcMs);
}

export const deleteUserCompletely = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User not authenticated",
    );
  }

  const uid = request.auth.uid;

  try {
    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    // Видаляємо scans
    const scansRef = db.collection("users").doc(uid).collection("scans");

    const scansSnapshot = await scansRef.get();

    const batch = db.batch();
    scansSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    // Видаляємо всі файли зі Storage
    await bucket.deleteFiles({
      prefix: `users/${uid}/`,
    });

    // Видаляємо user document
    await db.collection("users").doc(uid).delete();

    // Видаляємо Auth user
    await admin.auth().deleteUser(uid);

    // ОЦЕ КЛЮЧОВЕ
    return {
      success: true,
    };
  } catch (error) {
    console.error("Delete user failed:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to delete user data",
    );
  }
});

export const deleteOldScansCallable = functions.https.onCall(
  async (request) => {
    // Перевірка авторизації
    if (!request.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    try {
      return {
        success: true,
        ...await runDeleteOldScansCleanup(),
      };
    } catch (error) {
      console.error("deleteOldScansCallable failed", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }

      const err = error as {
        code?: unknown;
        message?: unknown;
      };

      throw new functions.https.HttpsError(
        mapToHttpsErrorCode(error),
        "Failed to delete old scans",
        {
          code: err?.code ?? null,
          cause: String(err?.message ?? error),
        },
      );
    }
  },
);

export const deleteOldScansScheduler = onSchedule(
  {
    schedule: "48 9 * * 2",
    timeZone: "UTC",
  },
  async () => {
    try {
      const result = await runDeleteOldScansCleanup();
      console.info("deleteOldScansScheduler completed", result);
    } catch (error) {
      console.error("deleteOldScansScheduler failed", error);
      throw error;
    }
  },
);

const DAILY_NOTIFICATIONS: Record<number, { title: string; body: string }> = {
  9: {
    title: "Good morning ☀️",
    body: "Scan your breakfast and start your day skin-smart with Glora.",
  },
  13: {
    title: "Lunchtime check-in 🥗",
    body: "What's on your plate? Snap a quick scan to keep your acne risk in check.",
  },
  19: {
    title: "Dinner time 🌙",
    body: "One last scan to wrap up your day — see how today's meals affect your skin.",
  },
};

export const sendDailyScanReminders = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "UTC",
  },
  async (event) => {
    const nowUtc = DateTime.fromISO(event.scheduleTime, { setZone: true }).toUTC();
    const usersSnapshot = await admin.firestore().collection("users").get();
    const messages: admin.messaging.TopicMessage[] = [];
    let missingTimezone = 0;
    let invalidTimezone = 0;

    for (const user of usersSnapshot.docs) {
      const timezone = user.get("timezone");
      if (typeof timezone !== "string" || !timezone.trim()) {
        missingTimezone += 1;
        continue;
      }

      const localTime = nowUtc.setZone(timezone);
      if (!localTime.isValid) {
        invalidTimezone += 1;
        continue;
      }

      const notification = DAILY_NOTIFICATIONS[localTime.hour];
      if (!notification) {
        continue;
      }

      messages.push({
        topic: user.id,
        notification,
      });
    }

    let sent = 0;
    let failed = 0;

    for (let offset = 0; offset < messages.length; offset += FCM_BATCH_SIZE) {
      const batch = messages.slice(offset, offset + FCM_BATCH_SIZE);
      const response = await admin.messaging().sendEach(batch);
      sent += response.successCount;
      failed += response.failureCount;

      response.responses.forEach((result, index) => {
        if (!result.success) {
          console.error("Daily reminder send failed", {
            uid: batch[index].topic,
            error: result.error,
          });
        }
      });
    }

    console.info("sendDailyScanReminders completed", {
      utcTime: nowUtc.toISO(),
      usersRead: usersSnapshot.size,
      eligible: messages.length,
      sent,
      failed,
      missingTimezone,
      invalidTimezone,
    });
  },
);
