/**
 * CrypStore 🏹 Backend — Express + Firebase Admin SDK
 * ------------------------------------------------
 * هذا السيرفر هو المكان الوحيد المسموح له بالكتابة على Firestore.
 * الواجهة الأمامية (index.html) لا تكتب على قاعدة البيانات مباشرة أبدًا.
 *
 * متغيرات البيئة المطلوبة (Render → Environment، أو Railway → Variables):
 * - BOT_TOKEN               : توكن بوت تيليجرام من BotFather
 * - FIREBASE_SERVICE_ACCOUNT : محتوى ملف JSON الكامل (كنص) من
 *                               Firebase Console > Project settings > Service accounts
 * - COIN_PER_AD             : (اختياري) مكافأة $_$ لكل إعلان، افتراضي 10
 * - COIN_PER_REFERRAL       : (اختياري) مكافأة $_$ لكل إحالة نشطة، افتراضي 15
 * - COINS_PER_GRAM          : (اختياري) معدل التحويل، افتراضي 10000 (10,000 $_$ = 1 GRAM)
 * - DAILY_AD_LIMIT          : (اختياري) الحد اليومي للمشاهدات، افتراضي 20
 * - MIN_WITHDRAW            : (اختياري) حد أدنى السحب بـ GRAM، افتراضي 0.2
 * - WEBAPP_URL              : رابط GitHub Pages (مثلاً https://samsamytff33.github.io/WEB/)
 * - BOT_USERNAME            : يوزر البوت بدون @ (لبناء روابط الإحالة) — الآن CrypStorebot
 * - TELEGRAM_WEBHOOK_SECRET : نص عشوائي من اختيارك، يُستخدم للتحقق من أن
 *                               الطلبات الواردة على /api/telegram/webhook
 *                               فعليًا من تيليجرام وليس من أي جهة أخرى
 */

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

// ---------- عملة $_$ (العملة الافتراضية داخل التطبيق) ----------
// كل الأرصدة اليومية (إعلانات، إحالات، مهام) تُمنح بعملة $_$.
// GRAM لا يظهر إلا في صفحة السحب، بعد تحويل $_$ إليه.
const COIN_PER_AD = parseFloat(process.env.COIN_PER_AD || "10");
const COIN_PER_REFERRAL = parseFloat(process.env.COIN_PER_REFERRAL || "15");
const COINS_PER_GRAM = parseFloat(process.env.COINS_PER_GRAM || "10000"); // 10,000 $_$ = 1 GRAM

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =========================================================
// Tasks — defined here so new tasks can be added later by
// editing only this array (no frontend changes needed).
// Each task's `type` decides how /api/tasks/verify checks it.
// Currently supported type: "telegram_channel".
// =========================================================
const TASKS = [
  {
    id: "join_crypstore_channel",
    type: "telegram_channel",
    title: "Subscribe to CrypStore 🪶",
    description: "Join our official channel and stay updated.",
    icon: "🪶",
    actionUrl: "https://t.me/CrypStore1",
    channelUsername: "CrypStore1", // without @ — bot must be a member/admin of this channel
    reward: parseFloat(process.env.TASK_JOIN_CHANNEL_REWARD || "15"), // بعملة $_$
  },
];

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================
// التحقق من صحة Telegram initData
// المرجع الرسمي: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
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

  // تحقق اختياري إضافي: رفض initData أقدم من ساعة (يمنع إعادة استخدام قديمة)
  const authDate = parseInt(urlParams.get("auth_date") || "0", 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > 3600) return null;

  const userJson = urlParams.get("user");
  if (!userJson) return null;

  return JSON.parse(userJson); // { id, first_name, username, ... }
}

// Middleware: يتحقق من initData ويحط user بالـ request
function requireTelegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"] || (req.body && req.body.initData) || "";
  const user = verifyInitData(initData);
  if (!user) {
    return res.status(401).json({ error: "invalid or missing initData" });
  }
  req.tgUser = user;
  next();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// =========================================================
// توليد كود إحالة قصير وفريد (6 محارف، بدون رموز ملتبسة زي 0/O أو 1/l/I)
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
// POST /api/auth/verify
// يتحقق من initData وينشئ مستند المستخدم إذا ما كان موجود
// =========================================================
app.post("/api/auth/verify", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const ref = db.collection("users").doc(userId);
    const doc = await ref.get();

    if (!doc.exists) {
      const myCode = await createUniqueReferralCode();

      // إذا فتح هذا المستخدم البوت عبر رابط إحالة (مسجل مسبقًا وقت /start)
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
          firstName: req.tgUser.first_name || "",
          username: req.tgUser.username || "",
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
            refereeName: req.tgUser.first_name || "",
            refereeUsername: req.tgUser.username || "",
            status: "active", // نشطة فورًا لأنه هذا الاستدعاء بحد ذاته يعني المستخدم فتح التطبيق فعليًا
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
          `Name: ${req.tgUser.first_name || "N/A"}\n` +
          `Username: ${req.tgUser.username ? "@" + req.tgUser.username : "N/A"}\n` +
          `Telegram ID: ${userId}\n\n` +
          `Go to the Friends section and claim your reward.`;
        await sendTelegramMessage(referrerId, notif);
      }
    } else if (!doc.data().referralCode) {
      // مستخدم قديم أُنشئ قبل إضافة نظام الإحالة — نولّد له كود الآن
      const myCode = await createUniqueReferralCode();
      await db.runTransaction(async (tx) => {
        tx.update(ref, { referralCode: myCode, referralCount: doc.data().referralCount || 0 });
        tx.set(db.collection("referralCodes").doc(myCode), { userId });
      });
    }

    const fresh = await ref.get();
    res.json({ ok: true, user: fresh.data() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/ads/confirm
// ⚠️ هذا endpoint مؤقت للتطوير. بالنشر الفعلي، يُستحسن استبداله
// أو تعزيزه بـ Reward Postback URL من AdsGram (server-to-server)
// حتى لا يعتمد منح المكافأة على حدث المتصفح فقط.
// =========================================================
app.post("/api/ads/confirm", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const ref = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("user not found");
      const data = doc.data();

      // إعادة تصفير العداد اليومي إذا تغير اليوم
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
// POST /api/withdraw/request
// ينشئ طلب سحب بحالة "pending" فقط — لا تحويل تلقائي هنا.
// التنفيذ الفعلي (إرسال TON) يجب أن يتم يدويًا أو بمنطق منفصل
// تراجعه بنفسك قبل التنفيذ.
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

      // خصم فوري لمنع طلبات سحب مكررة لنفس الرصيد
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
// POST /api/convert
// يحوّل رصيد $_$ إلى GRAM بمعدل ثابت (COINS_PER_GRAM). فقط هنا
// يظهر GRAM؛ باقي التطبيق يتعامل بعملة $_$ حصرًا.
// body: { amount } — بعملة $_$
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
      if (coinsAmount > coins) throw new Error("insufficient $_$ balance");

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
// POST /api/telegram/webhook
// يستقبل تحديثات البوت من تيليجرام (رسائل، أوامر). عند /start
// يرد برسالة ترحيب احترافية وزر يفتح الـ Web App.
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
  return data.result; // includes .photo[] with a file_id per resolution
}

// =========================================================
// Cache Telegram's own file_id for the /start welcome photo.
// Sending the SAME external URL on every /start makes Telegram
// treat it as a brand-new upload each time, forcing a fresh
// download on the user's device (hence the visible "KB" size
// badge, every single time). Sending by file_id instead reuses
// the file already stored on Telegram's servers, so the app can
// serve it from its own cache — no repeated download.
// Cached in memory + Firestore so it survives server restarts.
// =========================================================
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
  // تحقق أن الطلب فعليًا من تيليجرام (Secret Token الذي تضبطه أنت عند تسجيل الـ webhook)
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
                // يُخزَّن مؤقتًا؛ يتحول لإحالة "نشطة" فقط عند أول فتح فعلي للتطبيق (/api/auth/verify)
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

        // رسالة ترحيب مختصرة واحترافية عند /start — تحمل اسم وهوية CrypStore 🏹
        const welcomeCaption =
          `🏹 <b>Welcome to CrypStore, ${firstName}!</b>\n\n` +
          `⛏ Earn ${COIN_PER_AD} $_$ per ad\n` +
          `🤝 ${COIN_PER_REFERRAL} $_$ per invite\n` +
          `💸 Convert $_$ to GRAM and withdraw anytime`;

        const replyMarkup = {
          inline_keyboard: [
            [{ text: "🚀 Start CrypStore", web_app: { url: WEBAPP_URL } }],
            [{ text: "🌐 Community", url: "https://t.me/CrypStore1" }],
          ],
        };

        // استخدام file_id المخزَّن مسبقًا إن وُجد، بدل رابط الصورة الخام،
        // حتى لا يُعاد تحميل الصورة من جديد في كل مرة يضغط فيها أي مستخدم /start
        const cachedFileId = await getStartPhotoFileId();
        const photoSource = cachedFileId || `${WEBAPP_URL}assets/logo_2.png`;

        const sendResult = await sendTelegramPhoto(chatId, photoSource, welcomeCaption, replyMarkup);

        // أول إرسال ناجح عبر الرابط فقط: نخزّن الـ file_id الذي يرجعه تيليجرام
        // لاستخدامه في كل الطلبات القادمة من أي مستخدم
        if (!cachedFileId && sendResult?.photo?.length) {
          const largest = sendResult.photo[sendResult.photo.length - 1];
          await saveStartPhotoFileId(largest.file_id);
        }
      }
    }

    res.sendStatus(200); // لازم ترد 200 دائمًا، وإلا تيليجرام بيعيد المحاولة بشكل متكرر
  } catch (e) {
    console.error("webhook error", e);
    res.sendStatus(200);
  }
});

// =========================================================
// POST /api/referrals/list
// يرجّع كود/رابط الإحالة الخاص بالمستخدم، وقائمة إحالاته، والمكافآت غير المطالب بها
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
// يجمع كل الإحالات النشطة غير المُطالَب بمكافأتها ويضيفها للرصيد دفعة واحدة
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
// Tasks — helper: checks Telegram channel membership via getChatMember.
// ⚠️ The bot must be a member (ideally admin) of the channel, or this
// call fails with "chat not found" / "member list is inaccessible".
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
// يرجّع كل المهام المتاحة مع حالة كل واحدة بالنسبة لهذا المستخدم
// (مكتملة أم لا) — إضافة مهمة جديدة تتم فقط بتعديل مصفوفة TASKS بالأعلى
// =========================================================
app.post("/api/tasks/list", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const userDoc = await db.collection("users").doc(userId).get();
    const tasksClaimed = (userDoc.exists && userDoc.data().tasksClaimed) || {};

    const tasks = TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      icon: t.icon,
      actionUrl: t.actionUrl,
      reward: t.reward,
      completed: !!tasksClaimed[t.id],
    }));

    res.json({ ok: true, tasks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// =========================================================
// POST /api/tasks/verify
// يتحقق من إنجاز مهمة معيّنة، ويمنح المكافأة مرة واحدة فقط لكل مستخدم
// body: { taskId }
// =========================================================
app.post("/api/tasks/verify", requireTelegramAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { taskId } = req.body;
    const task = TASKS.find((t) => t.id === taskId);
    if (!task) return res.status(404).json({ error: "task not found" });

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "user not found" });

    const tasksClaimed = userDoc.data().tasksClaimed || {};
    if (tasksClaimed[task.id]) {
      return res.json({ ok: true, verified: true, alreadyClaimed: true });
    }

    let verified = false;
    if (task.type === "telegram_channel") {
      verified = await isSubscribedToChannel(task.channelUsername, userId);
    }

    if (!verified) {
      return res.json({ ok: true, verified: false });
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const freshClaimed = fresh.data().tasksClaimed || {};
      if (freshClaimed[task.id]) return; // already claimed by a concurrent request
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

// ---------- health check ----------
app.get("/", (req, res) => res.send("CrypStore backend is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
