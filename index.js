require("dotenv").config();
const admin = require("firebase-admin");
const TelegramBot = require('node-telegram-bot-api');

process.stdin.resume();
process.on('SIGTERM', () => { console.log('⚠️ SIGTERM - IGNORING'); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT - IGNORING');  });

setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  const fs = require('fs');
  try { fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString()); } catch(e) {}
}, 5 * 60 * 1000);

// ==========================
// 🔹 Logging
// ==========================
let logCounter = 0;
function smartLog(...args) { if (++logCounter <= 50) console.log(...args); }
setInterval(() => { logCounter = 0; }, 5 * 60 * 1000);

// ==========================
// 🔹 إعدادات الأدمن
// ==========================
const ADMIN_CHAT_ID = "6970148965";
const ADMIN_CHAT_IDS = ["6970148965", "8250574282"];
const isAdminId = (id) => ADMIN_CHAT_IDS.includes(String(id));

// ==========================
// 🔹 إعدادات المعالجة
// ==========================
const MAX_RETRIES         = 3;
const RETRY_DELAY         = 10000;
let BAMBOO_TO_TON_RATE    = 50000;
let systemPaused          = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseLogLimitArg(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (['all', 'كل', 'الجميع', 'جميع'].includes(raw)) return 'all';
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return null;
  return Math.min(n, 1000);
}

function getLogLimitLabel(limit) {
  return limit === 'all' ? 'جميع النشاطات' : `آخر ${limit} نشاط`;
}

function getActivityTimestamp(entry) {
  if (entry?.ts) return Number(entry.ts) || 0;
  if (entry?.timestamp) return Number(entry.timestamp) || 0;
  if (entry?.date) {
    const parsed = Date.parse(entry.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function formatCompactNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function firstNumeric(entry, keys) {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      const n = Number(entry[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function formatActivityValue(entry) {
  const lines = [];

  const tonReward = firstNumeric(entry, ['rewardTon', 'tonReward', 'reward_ton', 'ton_reward', 'tonPrize', 'earnedTon']);
  if (tonReward !== null) lines.push(`🎁 <b>مكافأة TON:</b> ${formatCompactNumber(tonReward)} TON`);

  const bambooReward = firstNumeric(entry, ['rewardBamboo', 'bambooReward', 'reward_bamboo', 'bamboo_reward', 'bambooEarned']);
  if (bambooReward !== null) lines.push(`🎍 <b>مكافأة Bamboo:</b> ${formatCompactNumber(bambooReward, 0)}`);

  const coinsReward = firstNumeric(entry, ['rewardCoins', 'coinsReward', 'reward_coins', 'coins_reward', 'coinsEarned']);
  if (coinsReward !== null) lines.push(`🪙 <b>مكافأة Coins:</b> ${formatCompactNumber(coinsReward, 0)}`);

  const genericReward = firstNumeric(entry, ['reward', 'rewardAmount', 'amountReward', 'prize', 'earned']);
  if (genericReward !== null && tonReward === null && bambooReward === null && coinsReward === null) {
    const unit = entry.rewardUnit || entry.unit || entry.currency || '';
    lines.push(`🎁 <b>المكافأة:</b> ${formatCompactNumber(genericReward)}${unit ? ' ' + escapeHtml(unit) : ''}`);
  }

  const price = firstNumeric(entry, ['price', 'cost']);
  if (price !== null) lines.push(`💳 <b>السعر:</b> ${formatCompactNumber(price)} TON`);

  if (!lines.length) return '🎁 <b>المكافأة:</b> —';
  return lines.join('\n  ');
}

function formatActivityBalances(entry) {
  const lines = [];
  const tonBefore = firstNumeric(entry, ['tonBalance_before', 'ton_before']);
  const tonAfter = firstNumeric(entry, ['tonBalance_after', 'ton_after']);
  if (tonBefore !== null || tonAfter !== null) {
    lines.push(`💰 <b>رصيد TON:</b> ${tonBefore !== null ? formatCompactNumber(tonBefore) : '—'} → ${tonAfter !== null ? formatCompactNumber(tonAfter) : '—'}`);
  }
  const bambooBefore = firstNumeric(entry, ['bamboo_before', 'bambooBalance_before']);
  const bambooAfter = firstNumeric(entry, ['bamboo_after', 'bambooBalance_after']);
  if (bambooBefore !== null || bambooAfter !== null) {
    lines.push(`🎍 <b>Bamboo:</b> ${bambooBefore !== null ? formatCompactNumber(bambooBefore, 0) : '—'} → ${bambooAfter !== null ? formatCompactNumber(bambooAfter, 0) : '—'}`);
  }
  const coinsBefore = firstNumeric(entry, ['coins_before', 'coinsBalance_before']);
  const coinsAfter = firstNumeric(entry, ['coins_after', 'coinsBalance_after']);
  if (coinsBefore !== null || coinsAfter !== null) {
    lines.push(`🪙 <b>Coins:</b> ${coinsBefore !== null ? formatCompactNumber(coinsBefore, 0) : '—'} → ${coinsAfter !== null ? formatCompactNumber(coinsAfter, 0) : '—'}`);
  }
  return lines.join('\n  ');
}

async function showLogLimitChooser(bot, chatId, userId) {
  await adminReply(bot, chatId,
    `📋 <b>سجل المستخدم</b> <code>${escapeHtml(userId)}</code>\n\n` +
    `اختر عدد النشاطات التي تريد عرضها أو استخدم:\n` +
    `<code>/logs ${escapeHtml(userId)} 100</code>\n` +
    `<code>/logs ${escapeHtml(userId)} all</code>`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'آخر 30', callback_data: `log_limit:${userId}:30` },
            { text: 'آخر 100', callback_data: `log_limit:${userId}:100` },
          ],
          [
            { text: 'آخر 200', callback_data: `log_limit:${userId}:200` },
            { text: 'جميع النشاطات', callback_data: `log_limit:${userId}:all` },
          ],
        ],
      },
    }
  );
}

async function sendUserLogs(bot, chatId, userId, limitOption = 30) {
  const limit = limitOption === 'all' ? 'all' : (parseLogLimitArg(limitOption) || 30);
  await adminReply(bot, chatId, `🔍 جاري جلب ${getLogLimitLabel(limit)} للمستخدم <code>${escapeHtml(userId)}</code>...`);

  const logRef = db.ref(`users/${userId}/log`);
  const logSnap = await (limit === 'all' ? logRef.once('value') : logRef.limitToLast(limit).once('value'));

  const logs = logSnap.val() || {};

  let text =
    `📊 <b>السجل — المستخدم <code>${escapeHtml(userId)}</code></b>\n` +
    `${'━'.repeat(30)}\n\n` +
    `${'─'.repeat(30)}\n` +
    `📋 <b>${getLogLimitLabel(limit)}:</b>\n\n`;

  const logEntries = Object.entries(logs)
    .sort((a, b) => getActivityTimestamp(b[1]) - getActivityTimestamp(a[1]));

  if (!logEntries.length) {
    text += `<i>لا يوجد سجل نشاط</i>`;
  } else {
    logEntries.forEach(([, entry]) => {
      const ts = getActivityTimestamp(entry);
      const date = ts ? new Date(ts).toISOString().substring(0, 16).replace('T', ' ') : (entry.date ? String(entry.date).substring(0, 16).replace('T', ' ') : '—');
      const type = escapeHtml(entry.type || entry.activityName || entry.name || 'نشاط');
      const cat  = entry.taskCategory || entry.category ? escapeHtml(entry.taskCategory || entry.category) : '';
      const tid  = entry.taskId || entry.activityId || '';
      const valueLine = formatActivityValue(entry);
      const balanceLine = formatActivityBalances(entry);
      text += `• <b>${type}</b>${cat ? ' | ' + cat : ''}${tid ? ' | <code>' + escapeHtml(tid) + '</code>' : ''}\n`;
      text += `  🕐 ${date}\n`;
      text += `  ${valueLine}\n`;
      if (balanceLine) text += `  ${balanceLine}\n`;
      text += `\n`;
    });
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 3500) {
    let cut = remaining.lastIndexOf('\n', 3500);
    if (cut < 1000) cut = 3500;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut);
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await adminReply(bot, chatId, chunk);
    await new Promise(r => setTimeout(r, 300));
  }
}

// ==========================
// 🔹 Firebase
// ==========================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (e) { console.error("❌ Firebase error:", e.message); process.exit(1); }
const db = admin.database();

// ==========================
// 🔹 متغيرات عامة
// ==========================
let botInstance = null;

// ==========================
// 🔹 فحص الحظر
// ==========================
async function isUserBanned(userId) {
  try {
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    return snap.exists();
  } catch { return false; }
}

// ==========================
// 🔹 دالة مساعدة للرد على الأدمن
// ==========================
async function adminReply(bot, chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) { console.log(`❌ adminReply: ${e.message}`); }
}

// ==========================
// 🔹 بوت الترحيب + أوامر الأدمن
// ==========================
function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log("⚠️ TELEGRAM_BOT_TOKEN missing"); return; }

  const bot = new TelegramBot(botToken, { polling: true });
  botInstance = bot;
  bot.setMyCommands([
    { command: 'start', description: 'رسالة الترحيب' },
    { command: 'help', description: 'كل أوامر الأدمن' },
    { command: 'logs', description: 'سجل نشاط مستخدم مع المكافآت' },
    { command: 'stats', description: 'إحصائيات كاملة' },
    { command: 'pause', description: 'إيقاف النظام' },
    { command: 'resume', description: 'استئناف النظام' },
    { command: 'setrate', description: 'تعيين سعر Bamboo' },
    { command: 'userinfo', description: 'معلومات مستخدم' },
    { command: 'banuser', description: 'حظر مستخدم' },
    { command: 'unbanuser', description: 'رفع حظر مستخدم' },
    { command: 'banwallet', description: 'حظر محفظة' },
    { command: 'unwallet', description: 'رفع حظر محفظة' },
    { command: 'addcoins', description: 'إضافة Coins' },
    { command: 'addbamboo', description: 'إضافة Bamboo' },
    { command: 'addton', description: 'إضافة TON' },
    { command: 'sendmsg', description: 'إرسال رسالة لمستخدم' },
    { command: 'broadcast', description: 'إرسال رسالة للجميع' },
    { command: 'broadcast_status', description: 'حالة البث' },
    { command: 'broadcast_debug', description: 'فحص البث' },
    { command: 'cancel', description: 'إلغاء جلسة الرسائل' },
    { command: 'check_suspicious', description: 'كشف محافظ مشتركة' },
    { command: 'reject_suspicious', description: 'رفض المشبوهين' },
    { command: 'top_referrals', description: 'أفضل 50 — إجمالي الإحالات' },
    { command: 'top_deposited_referrals', description: 'أفضل 50 — إحالات أودعوا' },
  ]).catch(e => console.log(`⚠️ setMyCommands: ${e.message}`));

  const isAdmin = (msg) => isAdminId(msg.chat.id);
  const unauth  = async (msg) => await bot.sendMessage(msg.chat.id, "⛔ Unauthorized");

  // ─── /start ───────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`👋 /start: ${chatId}`);
    const caption =
      `🏍️🔥 <b>Welcome to RaseenRacing!</b>\n\n` +
      `Race REAL players in intense 3D PvP battles and win TON rewards 💎\n\n` +
      `🏁 Upgrade your bike\n` +
      `⛏️ Mine daily TON rewards\n` +
      `👥 Invite friends &amp; earn commissions\n\n` +
      `🚀 Start now and become a racing legend!`;
    try {
      await bot.sendPhoto(chatId,
        "https://res.cloudinary.com/dktppfipy/image/upload/v1779047977/image_potboz.jpg",
        {
          caption,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open", url: "https://t.me/RaseenRacing_bot/app?startapp=" }],
              [
                { text: "📢 Channel", url: "https://t.me/RaseenRacing" },
                { text: "💬 Community", url: "https://t.me/RaseenRacing_chat" }
              ]
            ]
          }
        }
      );
    } catch (e) {
      console.log(`❌ /start sendPhoto error: ${e.message}`);
    }
  });

  // ─── /help ────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🐼 <b>RaseenRacing — لوحة الأدمن</b>\n` +
      `${'═'.repeat(32)}\n\n` +
      `👋 <b>أساسي</b>\n` +
      `/start — رسالة الترحيب\n` +
      `/help — عرض كل الأوامر\n` +
      `/my — لوحة التحكم الخاصة\n\n` +
      `📊 <b>المعلومات والمراقبة</b>\n` +
      `/stats — إحصائيات كاملة\n\n` +
      `⚙️ <b>إعدادات النظام</b>\n` +
      `/setrate [رقم] — تعيين سعر Bamboo\n` +
      `/pause — إيقاف النظام\n` +
      `/resume — استئناف النظام\n\n` +
      `👤 <b>إدارة المستخدمين</b>\n` +
      `/userinfo [userId] — معلومات مستخدم\n` +
      `/banuser [userId] — حظر مستخدم\n` +
      `/unbanuser [userId] — رفع حظر مستخدم\n` +
      `/banwallet [address] — حظر محفظة\n` +
      `/unwallet [address] — رفع حظر محفظة\n` +
      `/addcoins [userId] [كمية] — إضافة Coins\n` +
      `/addbamboo [userId] [كمية] — إضافة Bamboo\n` +
      `/addton [userId] [كمية] — إضافة TON\n\n` +
      `📋 <b>السجلات</b>\n` +
      `/logs [userId] [30|100|200|all] — سجل النشاطات\n\n` +
      `📨 <b>إرسال رسائل</b>\n` +
      `/sendmsg [userId] — إرسال رسالة لمستخدم\n` +
      `/broadcast — إرسال رسالة للجميع\n` +
      `/broadcast_status — حالة البث\n` +
      `/broadcast_debug — فحص مسار المستخدمين\n` +
      `/cancel — إلغاء جلسة إرسال الرسائل\n\n` +
      `🕵️ <b>كشف التلاعب</b>\n` +
      `/check_suspicious — كشف محافظ مشتركة (+3 مستخدمين)\n` +
      `/reject_suspicious — رفض وحظر المشبوهين\n\n` +
      `📊 <b>تقارير الإحالات</b>\n` +
      `/top_referrals — أفضل 50 مستخدم بأكثر إحالات إجمالاً\n` +
      `/top_deposited_referrals — أفضل 50 مستخدم بأكثر إحالات أودعوا`
    );
  });

  // ─── /my ──────────────────────────────────────────────
  bot.onText(/\/my/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🎛 <b>RaseenRacing — لوحة التحكم الخاصة</b>\n` +
      `${'═'.repeat(32)}\n\n` +
      `📊 <b>الإحصائيات والمراقبة</b>\n` +
      `/stats — إحصائيات كاملة\n\n` +
      `🔍 <b>معلومات المستخدمين</b>\n` +
      `/userinfo [userId] — معلومات مستخدم كاملة\n` +
      `/logs [userId] [30|100|200|all] — سجل النشاطات مع المكافآت\n\n` +
      `👤 <b>إدارة المستخدمين</b>\n` +
      `/banuser [userId] — حظر مستخدم\n` +
      `/unbanuser [userId] — رفع حظر مستخدم\n\n` +
      `💎 <b>إضافة رصيد</b>\n` +
      `/addton [userId] [كمية] — إضافة TON\n\n` +
      `⚙️ <b>إعدادات السعر</b>\n` +
      `/setrate [رقم] — سعر Bamboo→TON`
    );
  });

  // ─── /stats ───────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("users").once("value");
      const users = snap.val() || {};
      const userCount = Object.keys(users).length;
      await adminReply(bot, msg.chat.id,
        `📊 <b>إحصائيات الوضع الحالي</b>\n\n` +
        `👥 عدد المستخدمين: <b>${userCount}</b>\n\n` +
        `💱 Rate: <b>1 TON = ${BAMBOO_TO_TON_RATE} Bamboo</b>\n` +
        `⏸ Paused: <b>${systemPaused ? 'نعم' : 'لا'}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /setrate ─────────────────────────────────────────
  bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    BAMBOO_TO_TON_RATE = v;
    await adminReply(bot, msg.chat.id, `✅ السعر: <b>1 TON = ${v} Bamboo</b>`);
  });

  // ─── /pause ───────────────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = true;
    await adminReply(bot, msg.chat.id, `⏸ <b>تم إيقاف النظام</b>`);
  });

  // ─── /resume ──────────────────────────────────────────
  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = false;
    await adminReply(bot, msg.chat.id, `▶️ <b>تم استئناف النظام</b>`);
  });

  // ─── /banuser ─────────────────────────────────────────
  bot.onText(/\/banuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const uid = match[1].trim();
    if (!uid) { await adminReply(bot, msg.chat.id, "❌ أدخل userId"); return; }
    await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'admin' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المستخدم: <code>${escapeHtml(uid)}</code>`);
  });

  // ─── /unbanuser ───────────────────────────────────────
  bot.onText(/\/unbanuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const uid = match[1].trim();
    if (!uid) { await adminReply(bot, msg.chat.id, "❌ أدخل userId"); return; }
    await db.ref(`bannedUsers/${uid}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المستخدم: <code>${escapeHtml(uid)}</code>`);
  });

  // ─── /banwallet ───────────────────────────────────────
  bot.onText(/\/banwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    if (!addr) { await adminReply(bot, msg.chat.id, "❌ أدخل عنوان المحفظة"); return; }
    await db.ref(`bannedWallets/${addr.replace(/[.$#[\]/]/g, '_')}`).set({ bannedAt: Date.now(), by: 'admin' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المحفظة:\n<code>${escapeHtml(addr)}</code>`);
  });

  // ─── /unwallet ────────────────────────────────────────
  bot.onText(/\/unwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    if (!addr) { await adminReply(bot, msg.chat.id, "❌ أدخل عنوان المحفظة"); return; }
    await db.ref(`bannedWallets/${addr.replace(/[.$#[\]/]/g, '_')}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المحفظة:\n<code>${escapeHtml(addr)}</code>`);
  });

  // ─── /addcoins ────────────────────────────────────────
  bot.onText(/\/addcoins (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) { await adminReply(bot, msg.chat.id, "❌ الاستخدام: /addcoins [userId] [كمية]"); return; }
    const uid = parts[0]; const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) { await adminReply(bot, msg.chat.id, "❌ كمية غير صحيحة"); return; }
    try {
      const snap = await db.ref(`users/${uid}/coins`).once("value");
      const current = Number(snap.val() || 0);
      await db.ref(`users/${uid}/coins`).set(current + amount);
      await adminReply(bot, msg.chat.id, `✅ تمت إضافة <b>${amount.toLocaleString()} Coins</b>\n👤 User: <code>${uid}</code>\n🪙 الجديد: <b>${(current + amount).toLocaleString()}</b>`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addbamboo ───────────────────────────────────────
  bot.onText(/\/addbamboo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) { await adminReply(bot, msg.chat.id, "❌ الاستخدام: /addbamboo [userId] [كمية]"); return; }
    const uid = parts[0]; const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) { await adminReply(bot, msg.chat.id, "❌ كمية غير صحيحة"); return; }
    try {
      const snap = await db.ref(`users/${uid}/bamboo`).once("value");
      const current = Number(snap.val() || 0);
      await db.ref(`users/${uid}/bamboo`).set(current + amount);
      await adminReply(bot, msg.chat.id, `✅ تمت إضافة <b>${amount.toLocaleString()} Bamboo</b>\n👤 User: <code>${uid}</code>\n🎍 الجديد: <b>${(current + amount).toLocaleString()}</b>`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addton ──────────────────────────────────────────
  bot.onText(/\/addton (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) { await adminReply(bot, msg.chat.id, "❌ الاستخدام: /addton [userId] [كمية]"); return; }
    const uid = parts[0]; const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) { await adminReply(bot, msg.chat.id, "❌ كمية غير صحيحة"); return; }
    try {
      const snap = await db.ref(`users/${uid}/tonBalance`).once("value");
      const current = Number(snap.val() || 0);
      await db.ref(`users/${uid}/tonBalance`).set(current + amount);
      await adminReply(bot, msg.chat.id, `✅ تمت إضافة <b>${amount} TON</b>\n👤 User: <code>${uid}</code>\n💎 الجديد: <b>${(current + amount).toFixed(4)} TON</b>`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /logs ────────────────────────────────────────────
  bot.onText(/\/logs(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (!match[1]) { await adminReply(bot, msg.chat.id, "❌ الاستخدام: /logs [userId] [عدد|all]"); return; }
    const parts = match[1].trim().split(/\s+/);
    const userId = parts[0];
    const limit = parseLogLimitArg(parts[1]) || 30;
    await sendUserLogs(bot, msg.chat.id, userId, limit);
  });

  // ─── /userinfo ────────────────────────────────────────
  bot.onText(/\/userinfo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const uid = match[1].trim();
    try {
      const snap = await db.ref(`users/${uid}`).once("value");
      const user = snap.val();
      if (!user) { await adminReply(bot, msg.chat.id, `❌ المستخدم غير موجود: <code>${escapeHtml(uid)}</code>`); return; }
      const banned = await isUserBanned(uid);
      await adminReply(bot, msg.chat.id,
        `👤 <b>معلومات المستخدم</b>\n\n` +
        `🆔 ID: <code>${uid}</code>\n` +
        `💎 TON Balance: <b>${Number(user.tonBalance || 0).toFixed(4)}</b>\n` +
        `🎍 Bamboo: <b>${Number(user.bamboo || 0).toLocaleString()}</b>\n` +
        `🪙 Coins: <b>${Number(user.coins || 0).toLocaleString()}</b>\n` +
        `🚫 محظور: <b>${banned ? 'نعم' : 'لا'}</b>\n` +
        (user.wallet ? `📬 Wallet: <code>${escapeHtml(user.wallet)}</code>\n` : ``)
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /sendmsg & /broadcast ────────────────────────────
  const activeSessions = {};
  const broadcastState = {};

  bot.onText(/\/sendmsg (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const uid = match[1].trim();
    activeSessions[msg.chat.id] = { type: 'sendmsg', targetId: uid };
    await adminReply(bot, msg.chat.id, `📨 اكتب الرسالة للمستخدم <code>${escapeHtml(uid)}</code>\nاستخدم /cancel للإلغاء`);
  });

  bot.onText(/\/broadcast$/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    activeSessions[msg.chat.id] = { type: 'broadcast' };
    await adminReply(bot, msg.chat.id, `📢 اكتب الرسالة للبث لجميع المستخدمين\nاستخدم /cancel للإلغاء`);
  });

  bot.onText(/\/broadcast_status/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const state = broadcastState[msg.chat.id];
    if (!state) { await adminReply(bot, msg.chat.id, "📭 لا يوجد بث نشط"); return; }
    await adminReply(bot, msg.chat.id, `📊 <b>حالة البث</b>\n\n✅ نجح: ${state.success || 0}\n❌ فشل: ${state.failed || 0}\n📤 إجمالي: ${state.total || 0}`);
  });

  bot.onText(/\/broadcast_debug/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap = await db.ref("users").once("value");
      const users = snap.val() || {};
      const count = Object.keys(users).length;
      await adminReply(bot, msg.chat.id, `🔍 إجمالي المستخدمين في قاعدة البيانات: <b>${count}</b>`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (activeSessions[msg.chat.id]) {
      delete activeSessions[msg.chat.id];
      await adminReply(bot, msg.chat.id, "✅ تم إلغاء الجلسة");
    } else {
      await adminReply(bot, msg.chat.id, "ℹ️ لا توجد جلسة نشطة");
    }
  });

  // ─── /check_suspicious ────────────────────────────────
  bot.onText(/\/check_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("users").once("value");
      const users = snap.val() || {};
      const walletMap = {};
      for (const [uid, user] of Object.entries(users)) {
        const wallet = user.wallet;
        if (!wallet) continue;
        if (!walletMap[wallet]) walletMap[wallet] = [];
        walletMap[wallet].push(uid);
      }
      const suspicious = Object.entries(walletMap).filter(([, ids]) => ids.length >= 3);
      if (!suspicious.length) { await adminReply(bot, msg.chat.id, "✅ لا توجد محافظ مشتركة بين 3+ مستخدمين"); return; }
      let text = `🕵️ <b>محافظ مشتركة (3+ مستخدمين)</b>\n\n`;
      for (const [wallet, ids] of suspicious.slice(0, 20)) {
        text += `📬 <code>${escapeHtml(wallet.substring(0, 20))}...</code>\n`;
        text += `👥 ${ids.length} مستخدمين: ${ids.slice(0, 5).map(id => `<code>${id}</code>`).join(', ')}\n\n`;
      }
      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /reject_suspicious ───────────────────────────────
  bot.onText(/\/reject_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("users").once("value");
      const users = snap.val() || {};
      const walletMap = {};
      for (const [uid, user] of Object.entries(users)) {
        const wallet = user.wallet;
        if (!wallet) continue;
        if (!walletMap[wallet]) walletMap[wallet] = [];
        walletMap[wallet].push(uid);
      }
      const suspicious = Object.entries(walletMap).filter(([, ids]) => ids.length >= 3);
      if (!suspicious.length) { await adminReply(bot, msg.chat.id, "✅ لا توجد مشبوهين"); return; }
      let banned = 0;
      for (const [wallet, ids] of suspicious) {
        await db.ref(`bannedWallets/${wallet.replace(/[.$#[\]/]/g, '_')}`).set({ bannedAt: Date.now(), by: 'auto' });
        for (const uid of ids) {
          await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'auto_suspicious' });
          banned++;
        }
      }
      await adminReply(bot, msg.chat.id, `🚫 تم حظر <b>${banned}</b> مستخدم مشبوه`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /top_referrals ───────────────────────────────────
  bot.onText(/\/top_referrals/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("users").once("value");
      const users = snap.val() || {};
      const list = Object.entries(users)
        .map(([uid, u]) => ({ uid, count: Number(u.referralCount || u.totalReferrals || 0) }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      if (!list.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد إحالات"); return; }
      let text = `🏆 <b>أفضل 50 إحالة</b>\n\n`;
      list.forEach((x, i) => { text += `${i + 1}. <code>${x.uid}</code> — <b>${x.count}</b>\n`; });
      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /top_deposited_referrals ─────────────────────────
  bot.onText(/\/top_deposited_referrals/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("users").once("value");
      const users = snap.val() || {};
      const list = Object.entries(users)
        .map(([uid, u]) => ({ uid, count: Number(u.depositedReferrals || u.referralDeposited || 0) }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      if (!list.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد إحالات بإيداع"); return; }
      let text = `🏆 <b>أفضل 50 إحالة (بإيداع)</b>\n\n`;
      list.forEach((x, i) => { text += `${i + 1}. <code>${x.uid}</code> — <b>${x.count}</b>\n`; });
      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── معالجة الرسائل النصية (sendmsg/broadcast) ────────
  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId  = msg.chat.id;
    const session = activeSessions[chatId];
    if (!session) return;
    if (msg.text && msg.text.startsWith('/')) return;

    if (session.type === 'sendmsg') {
      delete activeSessions[chatId];
      const targetId = session.targetId;
      try {
        await bot.sendMessage(targetId, msg.text || '', { parse_mode: 'HTML' });
        await adminReply(bot, chatId, `✅ تم إرسال الرسالة للمستخدم <code>${escapeHtml(targetId)}</code>`);
      } catch (e) { await adminReply(bot, chatId, `❌ فشل الإرسال: ${e.message}`); }
    } else if (session.type === 'broadcast') {
      delete activeSessions[chatId];
      const text = msg.text || '';
      try {
        const snap  = await db.ref("users").once("value");
        const users = snap.val() || {};
        const ids   = Object.keys(users);
        broadcastState[chatId] = { total: ids.length, success: 0, failed: 0 };
        await adminReply(bot, chatId, `📢 جاري البث لـ <b>${ids.length}</b> مستخدم...`);
        for (const uid of ids) {
          try {
            await bot.sendMessage(uid, text, { parse_mode: 'HTML' });
            broadcastState[chatId].success++;
          } catch { broadcastState[chatId].failed++; }
          await new Promise(r => setTimeout(r, 50));
        }
        await adminReply(bot, chatId, `✅ اكتمل البث\n✅ نجح: ${broadcastState[chatId].success}\n❌ فشل: ${broadcastState[chatId].failed}`);
      } catch (e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
    }
  });

  // ─── Callback Queries ─────────────────────────────────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;

    if (!isAdminId(chatId)) { await bot.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' }); return; }

    // ── اختيار عدد اللوج ─────────────────────────────────
    if (data.startsWith('log_limit:')) {
      const parts = data.split(':');
      const userId = parts[1];
      const limit = parseLogLimitArg(parts[2]) || 30;
      await bot.answerCallbackQuery(query.id, { text: `📋 جاري جلب ${getLogLimitLabel(limit)}...` });
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        await sendUserLogs(bot, chatId, userId, limit);
      } catch(e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
      return;
    }

    if (data.startsWith('wd_logs:')) {
      const userId = data.replace('wd_logs:', '').trim();
      if (!userId) { await bot.answerCallbackQuery(query.id, { text: '❌ لا يوجد userId' }); return; }
      await bot.answerCallbackQuery(query.id, { text: '📋 اختر عدد النشاطات' });
      await showLogLimitChooser(bot, chatId, userId);
      return;
    }

    if (data.startsWith('ban_user:')) {
      const uid = data.replace('ban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'admin' });
      await bot.answerCallbackQuery(query.id, { text: `🚫 تم حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "✅ رفع الحظر", callback_data: `unban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('unban_user:')) {
      const uid = data.replace('unban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).remove();
      await bot.answerCallbackQuery(query.id, { text: `✅ تم رفع حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "🚫 حظر المستخدم", callback_data: `ban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
  });

  bot.on('polling_error', () => {});
  console.log("✅ Bot running");
}

// ==========================
// 🔹 Start
// ==========================
console.log("\n" + "=".repeat(50));
console.log("🐼 PANDA BAMBOO BOT — NO WITHDRAWAL / NO DEPOSIT");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);

startWelcomeBot();

db.ref(".info/connected").on("value", (snap) => { if (snap.val()) console.log("📡 Firebase connected"); });

console.log("💬 Running | @PandaBambooPayouts | 👤 Admin:", ADMIN_CHAT_ID);
console.log("=".repeat(50) + "\n");
