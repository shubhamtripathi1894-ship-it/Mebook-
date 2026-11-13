const admin = require("firebase-admin");

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const fb = getAdmin();
    const bodyData = req.body || {};

    // 1. Call Decline from Lock Screen
    if (bodyData.action === "decline") {
      const { callId, uid } = bodyData;
      if (!callId || !uid) return res.status(400).json({ error: "Invalid" });
      const ref = fb.firestore().collection("calls").doc(callId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const d = snap.data() || {};
      if (d.to !== uid && d.from !== uid) return res.status(403).json({ error: "Forbidden" });
      await ref.update({ status: "declined" });
      return res.status(200).json({ ok: true });
    }

    // 2. Send Notification / Call Push
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ error: "Unauthorized" });

    const decoded = await fb.auth().verifyIdToken(idToken);
    const { toUid, title, body, data } = bodyData;
    if (!toUid) return res.status(400).json({ error: "Missing toUid" });

    const userDoc = await fb.firestore().collection("users").doc(toUid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Receiver not found" });

    const userData = userDoc.data() || {};
    const androidToken = userData.androidFcmToken || "";
    const webToken = userData.fcmToken || "";
    const payloadData = {
      type: String((data && data.type) || "chat"),
      title: String(title || "MeBook"),
      body: String(body || "New message"),
      fromUid: String(decoded.uid),
      callId: String((data && data.callId) || ""),
      callType: String((data && data.callType) || "voice"),
    };

    const results = [];
    if (androidToken) {
      try {
        const msgId = await fb.messaging().send({
          token: androidToken,
          data: payloadData,
          android: {
            priority: "high",
            ttl: payloadData.type === "call" ? 30000 : 86400000,
          },
        });
        results.push({ target: "android", ok: true, msgId });
      } catch (err) {
        results.push({ target: "android", ok: false, error: err.message });
      }
    }
    if (webToken && webToken !== androidToken) {
      try {
        const msgId = await fb.messaging().send({
          token: webToken,
          notification: { title: payloadData.title, body: payloadData.body },
          data: payloadData,
        });
        results.push({ target: "web", ok: true, msgId });
      } catch (err) {
        results.push({ target: "web", ok: false, error: err.message });
      }
    }
    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
