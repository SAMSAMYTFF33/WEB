const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

// ---------- إعداد Firebase Admin ----------
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountRaw) {
  console.error("FIREBASE_SERVICE_ACCOUNT env var is missing.");
  process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountRaw);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---------- إعدادات عامة ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN env var is missing.");
  process.exit(1);
}

const DAILY_AD_LIMIT = parseInt(process.env.DAILY_AD_LIMIT || "20", 10);
const MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || "0.2");
const WEBAPP_URL = process.env.WEBAPP_URL || "https://samsamytff33.github.io/WEB/";
const BOT_USERNAME = process.env.BOT_USERNAME || "CrypStorebot";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// ---------- عملة BUX ----------
const COIN_PER_AD = parseFloat(process.env.COIN_PER_AD || "10");
const COIN_PER_REFERRAL = parseFloat(process.env.COIN_PER_REFERRAL || "15");
const COINS_PER_GRAM = parseFloat(process.env.COINS_PER_GRAM || "10000"); // 10,000 BUX = 1 GRAM

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =========================================================
// Tasks — إضافة مهمة جديدة تتم بتعديل هذه المصفوفة فقط.
// الأنواع المدعومة:
//   "telegram_channel" → تحقق من الاشتراك عبر getChatMember
//   "website"          → فتح موقع خارجي + انتظار minSeconds ثانية
// =========================================================
const WEBSITE_TASK_WAIT = parseInt(process.env.WEBSITE_TASK_WAIT || "35", 10); // ثواني

const TASKS = [
  {
    id: "join_crypstore_channel",
    type: "telegram_channel",
    title: "Subscribe to CrypStore 🪶",
    description: "Join our official channel and stay updated.",
    icon: "🪶",
    actionUrl: "https://t.me/CrypStore1",
    channelUsername: "CrypStore1", // without @ — bot must be a member/admin of this channel
    reward: parseFloat(process.env.TASK_JOIN_CHANNEL_REWARD || "15"), // BUX
  },
  {
    id: "forumok_register",
    type: "website",
    title: "Register on forumok",
    description: "Create an account on forumok.com",
    icon: "🌐",
    actionUrl: "https://forumok.com",
    minSeconds: WEBSITE_TASK_WAIT,
    reward: parseFloat(process.env.TASK_FORUMOK_REWARD || "500"), // BUX
  },
];

// شكل المهمة المرسل للواجهة (لا نرسل أي حقول داخلية)
function publicTask(t, claimed) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    description: t.description,
    icon: t.icon,
    actionUrl: t.actionUrl,
    reward: t.reward,
    minSeconds: t.minSeconds || 0,
    completed: !!(claimed && claimed[t.id]),
  };
}

// ---------- الأدمن ----------
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "gz_73").toLowerCase();

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================
// التحقق من صحة Telegram initData
// =========================================================
function verifyInitData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return null;
  urlParams.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of [...urlParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  // رفض initData أقدم من ساعة
  const authDate = parseInt(urlParams.get("auth_date") || "0", 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > 3600) return null;

  const userJson = urlParams.get("user");
  if (!userJson) return null;

  return JSON.parse(userJson); // { id, first_name, username, ... }
}

function requireTelegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"] || (req.body && req.body.initData) || "";
  const user = verifyInitData(initData);
  if (!user) {
    return res.status(401).json({ error: "invalid or missing initData" });
  }
  req.tgUser = user;
  next();
}

// يُستخدم دائمًا بعد requireTelegramAuth
function requireAdmin(req, res, next) {
  const username = (req.tgUser?.username || "").toLowerCase();
  if (!username || username !== ADMIN_USERNAME) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// =========================================================
// توليد كود إحالة قصير وفريد
// =========================================================
const REF_CODE_CHARS = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
function generateReferralCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += REF_CODE_CHARS[crypto.randomInt(REF_CODE_CHARS.length)];
  }
  return code;
}

async function createUniqueReferralCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateReferralCode();
    const doc = await db.collection("referralCodes").doc(code).get();
    if (!doc.exists) return code;
  }
  throw new Error("could not generate unique referral code");
}

// =========================================================
// ensureUserDoc(tgUser)
// =========================================================
async function ensureUserDoc(tgUser) {
  const userId = String(tgUser.id);
  const ref = db.collection("users").doc(userId);
  const doc = await ref.get();

  if (!doc.exists) {
    const myCode = await createUniqueReferralCode();

    let referrerId = null;
    const pendingRef = await db.collection("pendingReferrals").doc(userId).get();
    if (pendingRef.exists) {
      const candidateReferrer = pendingRef.data().referrerId;
      if (candidateReferrer && candidateReferrer !== userId) {
        referrerId = candidateReferrer;
      }
    }

    await db.runTransaction(async (tx) => {
      tx.set(ref, {
        firstName: tgUser.first_name || "",
        username: tgUser.username || "",
        coins: 0,
        balance: 0,
        viewsToday: 0,
        totalViews: 0,
        lastViewDate: todayKey(),
        referredBy: referrerId,
        referralCode: myCode,
        referralCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("referralCodes").doc(myCode), { userId });

      if (referrerId) {
        const referralDocRef = db.collection("referrals").doc();
        tx.set(referralDocRef, {
          referrerId,
          refereeId: userId,
          refereeName: tgUser.first_name || "",
          refereeUsername: tgUser.username || "",
          status: "active",
          rewardClaimed: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(db.collection("users").doc(referrerId), {
          referralCount: admin.firestore.FieldValue.increment(1),
        });
      }
    });

    if (pendingRef.exists) {
      await db.collection("pendingReferrals").doc(userId).delete();
    }

    if (referrerId) {
      const notif =
        `A referral has been confirmed and is now Active!\n\n` +
        `Name: ${tgUser.first_name || "N/A"}\n` +
        `Username: ${tgUser.username ? "@" + tgUser.username : "N/A"}\n` +
        `Telegram ID: ${userId}\n\n` +
        `Go to the Friends section and claim your reward.`;
      await sendTelegramMessage(referrerId, notif);
    }
  } else if (!doc.data().referralCode) {
    const myCode = await createUniqueReferralCode();
    await db.runTransaction(async (tx) => {
      tx.update(ref, { referralCode: myCode, referralCount: doc.data().referralCount || 0 });
      tx.set(db.collection("referralCodes").doc(myCode), { userId });
    });
  }

  const fresh = await ref.get();
  return fresh.data();
}

// =========================================================
// POST /api/auth/verify
// =========================================================
app.post("/api/auth/verify", requireTelegramAuth, async (req, res) => {
  try {
    const user = await ensureUserDoc(req.tgUser);
    res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/bootstrap
// auth/verify + tasks/list + referrals/list في طلب واحد
// =========================================================
app.post("/api/bootstrap", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const userData = await ensureUserDoc(req.tgUser);

    const referralsSnap = await db.collection("referrals").where("referrerId", "==", userId).get();
    const referrals = [];
    let unclaimedCount = 0;
    referralsSnap.forEach((d) => {
      const r = d.data();
      referrals.push({
        id: d.id,
        name: r.refereeName,
        username: r.refereeUsername,
        status: r.status,
        rewardClaimed: r.rewardClaimed,
      });
      if (r.status === "active" && !r.rewardClaimed) unclaimedCount++;
    });

    const tasksClaimed = userData.tasksClaimed || {};
    const tasks = TASKS.map((t) => publicTask(t, tasksClaimed));

    res.json({
      ok: true,
      user: userData,
      referralsData: {
        referralCode: userData.referralCode || null,
        referralLink: userData.referralCode ? `https://t.me/${BOT_USERNAME}?start=${userData.referralCode}` : null,
        referralCount: userData.referralCount || 0,
        referrals,
        unclaimedReward: +(unclaimedCount * COIN_PER_REFERRAL).toFixed(6),
        rewardPerReferral: COIN_PER_REFERRAL,
      },
      tasks,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/ads/confirm
// ⚠️ مؤقت للتطوير — يُفضّل ربطه بـ postback من Monetag/AdsGram.
// =========================================================
app.post("/api/ads/confirm", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const ref = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("user not found");
      const data = doc.data();

      const today = todayKey();
      let viewsToday = data.viewsToday || 0;
      if (data.lastViewDate !== today) viewsToday = 0;

      if (viewsToday >= DAILY_AD_LIMIT) {
        throw new Error("daily limit reached");
      }

      tx.update(ref, {
        coins: admin.firestore.FieldValue.increment(COIN_PER_AD),
        viewsToday: viewsToday + 1,
        totalViews: admin.firestore.FieldValue.increment(1),
        lastViewDate: today,
      });
    });

    res.json({ ok: true, reward: COIN_PER_AD });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "could not confirm ad view" });
  }
});

// =========================================================
// POST /api/withdraw/request — طلب بحالة pending فقط، لا تحويل تلقائي
// =========================================================
app.post("/api/withdraw/request", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { wallet, amount } = req.body;

    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "invalid wallet address" });
    }
    const amt = parseFloat(amount);
    if (!amt || amt < MIN_WITHDRAW) {
      return res.status(400).json({ error: `minimum withdraw is ${MIN_WITHDRAW} TON` });
    }

    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);
      if (!doc.exists) throw new Error("user not found");
      const balance = doc.data().balance || 0;
      if (amt > balance) throw new Error("insufficient balance");

      tx.update(userRef, { balance: admin.firestore.FieldValue.increment(-amt) });

      const withdrawRef = db.collection("withdrawals").doc();
      tx.set(withdrawRef, {
        userId,
        wallet,
        amount: amt,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ ok: true, message: "withdraw request submitted" });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "could not submit withdraw request" });
  }
});

// =========================================================
// POST /api/convert — BUX → GRAM
// =========================================================
app.post("/api/convert", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const coinsAmount = parseFloat(req.body.amount);
    if (!coinsAmount || coinsAmount <= 0) {
      return res.status(400).json({ error: "invalid amount" });
    }

    const userRef = db.collection("users").doc(userId);
    const gramAmount = +(coinsAmount / COINS_PER_GRAM).toFixed(6);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);
      if (!doc.exists) throw new Error("user not found");
      const coins = doc.data().coins || 0;
      if (coinsAmount > coins) throw new Error("insufficient BUX balance");

      tx.update(userRef, {
        coins: admin.firestore.FieldValue.increment(-coinsAmount),
        balance: admin.firestore.FieldValue.increment(gramAmount),
      });
    });

    res.json({ ok: true, converted: coinsAmount, gram: gramAmount });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "could not convert" });
  }
});

// =========================================================
// Telegram helpers + webhook
// =========================================================
async function sendTelegramMessage(chatId, text, replyMarkup) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
  });
}

async function sendTelegramPhoto(chatId, photoUrlOrFileId, caption, replyMarkup) {
  const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrlOrFileId,
      caption,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("sendPhoto failed, falling back to text:", data.description);
    await sendTelegramMessage(chatId, caption, replyMarkup);
    return null;
  }
  return data.result;
}

// تخزين file_id لصورة /start لتفادي إعادة تحميلها في كل مرة
let cachedStartPhotoFileId = null;

async function getStartPhotoFileId() {
  if (cachedStartPhotoFileId) return cachedStartPhotoFileId;
  try {
    const doc = await db.collection("config").doc("assets").get();
    if (doc.exists && doc.data().startPhotoFileId) {
      cachedStartPhotoFileId = doc.data().startPhotoFileId;
    }
  } catch (e) {
    console.warn("could not read cached start photo file_id", e);
  }
  return cachedStartPhotoFileId;
}

async function saveStartPhotoFileId(fileId) {
  cachedStartPhotoFileId = fileId;
  try {
    await db.collection("config").doc("assets").set({ startPhotoFileId: fileId }, { merge: true });
  } catch (e) {
    console.warn("could not persist start photo file_id", e);
  }
}

app.post("/api/telegram/webhook", async (req, res) => {
  if (TELEGRAM_WEBHOOK_SECRET) {
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (incomingSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }
  }

  try {
    const update = req.body;
    const message = update.message;

    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.trim();

      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const payload = parts.length > 1 ? parts[1].trim() : null;

        if (payload) {
          try {
            const codeDoc = await db.collection("referralCodes").doc(payload).get();
            if (codeDoc.exists) {
              const referrerId = codeDoc.data().userId;
              if (referrerId !== String(chatId)) {
                await db.collection("pendingReferrals").doc(String(chatId)).set({
                  referrerId,
                  code: payload,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            }
          } catch (e) {
            console.error("referral payload error", e);
          }
        }

        const firstName = message.from?.first_name || "there";

        const welcomeCaption =
          `🏹 <b>Welcome to CrypStore, ${firstName}!</b>\n\n` +
          `⛏ Earn ${COIN_PER_AD} BUX per ad\n` +
          `🤝 ${COIN_PER_REFERRAL} BUX per invite\n` +
          `💸 Convert BUX to GRAM and withdraw anytime`;

        const replyMarkup = {
          inline_keyboard: [
            [{ text: "🚀 Start CrypStore", web_app: { url: WEBAPP_URL } }],
            [{ text: "🌐 Community", url: "https://t.me/CrypStore1" }],
          ],
        };

        const cachedFileId = await getStartPhotoFileId();
        const photoSource = cachedFileId || `${WEBAPP_URL}assets/logo_2.png`;

        const sendResult = await sendTelegramPhoto(chatId, photoSource, welcomeCaption, replyMarkup);

        if (!cachedFileId && sendResult?.photo?.length) {
          const largest = sendResult.photo[sendResult.photo.length - 1];
          await saveStartPhotoFileId(largest.file_id);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error", e);
    res.sendStatus(200);
  }
});

// =========================================================
// POST /api/referrals/list
// =========================================================
app.post("/api/referrals/list", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "user not found" });
    const userData = userDoc.data();

    const snap = await db.collection("referrals").where("referrerId", "==", userId).get();
    const referrals = [];
    let unclaimedCount = 0;
    snap.forEach((d) => {
      const r = d.data();
      referrals.push({
        id: d.id,
        name: r.refereeName,
        username: r.refereeUsername,
        status: r.status,
        rewardClaimed: r.rewardClaimed,
      });
      if (r.status === "active" && !r.rewardClaimed) unclaimedCount++;
    });

    res.json({
      ok: true,
      referralCode: userData.referralCode || null,
      referralLink: userData.referralCode ? `https://t.me/${BOT_USERNAME}?start=${userData.referralCode}` : null,
      referralCount: userData.referralCount || 0,
      referrals,
      unclaimedReward: +(unclaimedCount * COIN_PER_REFERRAL).toFixed(6),
      rewardPerReferral: COIN_PER_REFERRAL,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/referrals/claim
// =========================================================
app.post("/api/referrals/claim", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const snap = await db
      .collection("referrals")
      .where("referrerId", "==", userId)
      .where("status", "==", "active")
      .where("rewardClaimed", "==", false)
      .get();

    if (snap.empty) {
      return res.json({ ok: true, claimed: 0, amount: 0 });
    }

    const amount = +(snap.size * COIN_PER_REFERRAL).toFixed(6);
    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const docs = await Promise.all(snap.docs.map((d) => tx.get(d.ref)));
      docs.forEach((d) => tx.update(d.ref, { rewardClaimed: true }));
      tx.update(userRef, { coins: admin.firestore.FieldValue.increment(amount) });
    });

    res.json({ ok: true, claimed: snap.size, amount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// Tasks — التحقق من الاشتراك في قناة تيليجرام
// ⚠️ يجب أن يكون البوت عضوًا (يفضّل أدمن) في القناة.
// =========================================================
async function isSubscribedToChannel(channelUsername, userId) {
  const url = `${TELEGRAM_API}/getChatMember?chat_id=@${encodeURIComponent(channelUsername)}&user_id=${userId}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    console.warn("getChatMember failed:", data.description);
    return false;
  }
  const status = data.result?.status;
  return ["member", "administrator", "creator"].includes(status);
}

// =========================================================
// POST /api/tasks/list
// =========================================================
app.post("/api/tasks/list", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const userDoc = await db.collection("users").doc(userId).get();
    const tasksClaimed = (userDoc.exists && userDoc.data().tasksClaimed) || {};

    const tasks = TASKS.map((t) => publicTask(t, tasksClaimed));
    res.json({ ok: true, tasks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/tasks/start
// تسجّل لحظة فتح المستخدم لمهمة موقع (الساعة هنا ساعة السيرفر،
// فلا يمكن التلاعب بها من الواجهة). تُسجَّل أول مرة فقط.
// body: { taskId }
// =========================================================
app.post("/api/tasks/start", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const task = TASKS.find((t) => t.id === req.body.taskId);
    if (!task || !task.minSeconds) return res.status(404).json({ error: "task not found" });

    const userRef = db.collection("users").doc(userId);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);
      if (!doc.exists) throw new Error("user not found");
      const started = (doc.data().tasksStarted || {})[task.id];
      if (!started) tx.update(userRef, { [`tasksStarted.${task.id}`]: Date.now() });
    });

    res.json({ ok: true, wait: task.minSeconds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/tasks/verify
// يتحقق من إنجاز مهمة ويمنح المكافأة مرة واحدة فقط لكل مستخدم
// body: { taskId, proof? }
// =========================================================
app.post("/api/tasks/verify", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { taskId, proof } = req.body;
    const task = TASKS.find((t) => t.id === taskId);
    if (!task) return res.status(404).json({ error: "task not found" });

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "user not found" });

    const userData = userDoc.data();
    const tasksClaimed = userData.tasksClaimed || {};
    if (tasksClaimed[task.id]) {
      return res.json({ ok: true, verified: true, alreadyClaimed: true });
    }

    let verified = false;
    if (task.type === "telegram_channel") {
      verified = await isSubscribedToChannel(task.channelUsername, userId);
    } else if (task.type === "website") {
      const startedAt = (userData.tasksStarted || {})[task.id];
      if (!startedAt) {
        return res.json({ ok: true, verified: false, notStarted: true });
      }
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed < task.minSeconds) {
        return res.json({ ok: true, verified: false, wait: Math.ceil(task.minSeconds - elapsed) });
      }
      verified = true;

      // اختياري: حفظ اسم المستخدم المُدخل (إن وُجد) لمراجعته لاحقًا
      if (typeof proof === "string" && proof.trim()) {
        await db.collection("taskSubmissions").add({
          userId,
          taskId: task.id,
          proof: proof.trim().slice(0, 100),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    if (!verified) {
      return res.json({ ok: true, verified: false });
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const freshClaimed = fresh.data().tasksClaimed || {};
      if (freshClaimed[task.id]) return; // مُطالَب بها بالفعل من طلب متزامن
      tx.update(userRef, {
        coins: admin.firestore.FieldValue.increment(task.reward),
        [`tasksClaimed.${task.id}`]: true,
      });
    });

    res.json({ ok: true, verified: true, reward: task.reward });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/admin/users — للأدمن فقط
// =========================================================
app.post("/api/admin/users", requireTelegramAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection("users").orderBy("createdAt", "desc").get();
    const users = [];
    snap.forEach((d) => {
      const u = d.data();
      users.push({
        id: d.id,
        firstName: u.firstName || "",
        username: u.username || "",
        referralCount: u.referralCount || 0,
        coins: +(u.coins || 0).toFixed(2),     // BUX
        balance: +(u.balance || 0).toFixed(4), // GRAM
      });
    });

    res.json({ ok: true, count: users.length, users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------- health check ----------
app.get("/", (req, res) => res.send("CrypStore backend is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
