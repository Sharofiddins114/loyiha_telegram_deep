require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const redis = require('redis');
const moment = require('moment');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 120000
});
const doc = new GoogleSpreadsheet(process.env.SHEET_ID, {
  timeout: 120000
});
const redisClient = redis.createClient({
  socket: {
    connectTimeout: 10000,
    reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
  }
});

// Google Sheets ulanishi
async function setupSheet() {
  const credentials = JSON.parse(process.env.CREDENTIALS_JSON); // ✅ BU YANGI QATOR
  await doc.useServiceAccountAuth(credentials);                 // ✅ JSON'dan o‘qiladi
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

// Smart duplicate tekshirish
async function checkVideo(userId, fileUniqueId, duration) {
  if (!redisClient.isOpen) await redisClient.connect();
  
  const userKey = `user:${userId}`;
  const fileKey = `${userKey}:${fileUniqueId}`;
  const durationKey = `${userKey}:duration:${duration}`;

  // 1. Fayl ID bo'yicha tekshirish
  const fileExists = await redisClient.exists(fileKey);
  if (fileExists) return { isDuplicate: true, reason: 'file_id' };

  // 2. Davomiylik bo'yicha tekshirish (5 soniya farq bilan)
  const similarDuration = await redisClient.get(durationKey);
  if (similarDuration) return { isDuplicate: true, reason: 'duration' };

  // 3. 1 soat ichida 3 tadan ko'p video tekshirish
  const recentVideos = await redisClient.lRange(`${userKey}:recent`, 0, -1);
  if (recentVideos.length >= 3) {
    return { isDuplicate: true, reason: 'too_many_videos' };
  }

  // Ma'lumotlarni saqlash
  await redisClient.multi()
  .set(fileKey, '1', { EX: 86400 })
  .set(durationKey, '1', { EX: 86400 })
  .lPush(`${userKey}:recent`, Date.now().toString())
  .lTrim(`${userKey}:recent`, 0, 2)
  .expire(`${userKey}:recent`, 3600)
  .exec();

  return { isDuplicate: false };
}

// Anomaliyalarni aniqlash
async function detectAnomalies(userId, duration, fileSize, nowDate) {
  const sheet = await setupSheet();
  const rows = await sheet.getRows();
  const userRows = rows.filter(row => row['Telegram ID'] === userId.toString());

  if (userRows.length < 5) return [];

  const durations = userRows.map(r => parseInt(r['Duration']));
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

  const anomalies = [];

  if (Math.abs(duration - avg) > 2) anomalies.push('🟡 G‘alati davomiylik');
  if (fileSize < 20000) anomalies.push('🔴 Juda kichik fayl');

  const now = new Date(nowDate);
  const recent = userRows.filter(row => {
    const time = new Date(`${row['Sana']} ${row['Vaqt']}`);
    return (now - time) / (1000 * 60) < 30;
  });
  if (recent.length >= 3) anomalies.push('🔴 Juda tez yuborilmoqda');

  return anomalies;
}

// Video note qayta ishlash
bot.on('video_note', async (ctx) => {
  try {
    const { file_id, file_unique_id, file_size, duration } = ctx.message.video_note;
    const user = ctx.from;
    const isForwarded = !!ctx.message.forward_date;
    
    const { isDuplicate, reason } = await checkVideo(user.id, file_unique_id, duration);
    const anomalies = await detectAnomalies(user.id, duration, file_size, new Date());
    if (anomalies.length >= 2) {
      await ctx.telegram.sendMessage(
        process.env.ADMIN_ID,
        `⚠️ *Shubhali xodim!* \n` +
        `👤 @${user.username || 'no_username'} (ID: ${user.id}) \n` +
        `🚨 Anomaliyalar: ${anomalies.join(', ')} \n` +
        `📅 ${moment().format('YYYY-MM-DD HH:mm:ss')}`,
        { parse_mode: 'Markdown' }
      );
    
      // Istasangiz auto-ban: await ctx.banChatMember(user.id);
    }
    const sheet = await setupSheet();
    await sheet.addRow({
      'Sana': moment().format('YYYY-MM-DD'),
      'Vaqt': moment().format('HH:mm:ss'),
      'Username': user.username || user.first_name || 'Nomaʼlum',
      'Telegram ID': user.id,
      'File ID': file_id,
      'File Unique ID': file_unique_id,
      'File Size': file_size,
      'Duration': duration,
      'Status': isDuplicate ? `Takroriy (${reason})` : 'Yangi',
      'Forwarded': isForwarded ? 'Ha' : 'Yoʻq',
      'Anomalies': anomalies.join(', ') || 'Yoʻq'
    });

    // Foydalanuvchiga javob
    await ctx.reply('✅ Video muvaffaqiyatli qabul qilindi!');

    // Admin uchun xabar
    let adminMsg = `🎥 ${isDuplicate ? '⚠️ Takroriy video' : '🆕 Yangi video'}\n` +
      `👤 ${user.username ? '@' + user.username : user.first_name} (ID: ${user.id})\n` +
      `⏱ ${duration} soniya | ${Math.round(file_size/1024)} KB\n` +
      `📅 ${moment().format('YYYY-MM-DD HH:mm:ss')}\n`;
    
    if (anomalies.length > 0) {
      adminMsg += `\n🚨 Anomaliyalar: ${anomalies.join(', ')}`;
    }
    
    await ctx.telegram.sendMessage(process.env.ADMIN_ID, adminMsg);
    await ctx.forwardMessage(process.env.ADMIN_ID);

  } catch (err) {
    console.error('Xatolik:', err);
    await ctx.reply('❌ Xatolik yuz berdi, iltimos qayta urinib koʻring');
  }
});

// Admin buyruqlari
bot.command('stats', async (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  
  const sheet = await setupSheet();
  const rows = await sheet.getRows();
  const today = moment().format('YYYY-MM-DD');
  
  const stats = {
    total: rows.length,
    today: rows.filter(row => row['Sana'] === today).length,
    duplicates: rows.filter(row => (row['Status'] || '').includes('Takroriy')).length,
    anomalies: rows.filter(row => row['Anomalies'] !== 'Yoʻq').length
  };
  
  await ctx.replyWithMarkdown(
    `📊 *Bot statistikasi*\n\n` +
    `📅 Bugun: *${stats.today}* ta video\n` +
    `🔄 Takroriy: *${stats.duplicates}* ta\n` +
    `⚠️ Anomaliyalar: *${stats.anomalies}* ta\n` +
    `📈 Jami: *${stats.total}* ta video`
  );
});

bot.command('find', async (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  
  const searchQuery = ctx.message.text.split(' ').slice(1).join(' ');
  if (!searchQuery) return ctx.reply('Iltimos, qidirish uchun soʻz yoki ID kiriting');
  
  const sheet = await setupSheet();
  const rows = await sheet.getRows();
  const results = rows.filter(row => 
    (row['Username'] || '').includes(searchQuery) ||
    (row['Telegram ID'] || '').includes(searchQuery)
  ).slice(0, 5);
  
  if (results.length === 0) return ctx.reply('Natija topilmadi');
  
  let response = `🔍 *Qidiruv natijalari* (${results.length} ta):\n\n`;
  results.forEach(row => {
    response += `👤 ${row['Username']} (ID: ${row['Telegram ID']})\n` +
      `📅 ${row['Sana']} ${row['Vaqt']}\n` +
      `🆔 ${row['File Unique ID']}\n\n`;
  });
  
  await ctx.replyWithMarkdown(response);
});

// Xodimlar uchun buyruq
bot.command('my_stats', async (ctx) => {
  const sheet = await setupSheet();
  const rows = await sheet.getRows();
  const userVideos = rows.filter(row => row['Telegram ID'] === ctx.from.id.toString());
  
  if (userVideos.length === 0) {
    return ctx.reply('📭 Siz hali hech qanday video yubormagansiz');
  }
  
  const lastWeekVideos = userVideos.filter(row => 
    moment(row['Sana']).isAfter(moment().subtract(7, 'days'))
  );
  
  await ctx.replyWithMarkdown(
    `📊 *Sizning statistikangiz*\n\n` +
    `🎥 Jami videolar: *${userVideos.length}* ta\n` +
    `📅 Oxirgi 7 kun: *${lastWeekVideos.length}* ta\n` +
    `⏱ Oʻrtacha davomiylik: *${Math.round(
      lastWeekVideos.reduce((sum, row) => sum + parseInt(row['Duration']), 0) / 
      (lastWeekVideos.length || 1)
    )}* soniya`
  );
});

// Redis xatolari
redisClient.on('error', (err) => console.error('Redis xatosi:', err));

// Ishga tushirish
async function start() {
  try {
    await redisClient.connect();
    await bot.launch();
    console.log('🤖 Bot ishga tushdi');
    
    // Har kungi hisobot
    setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 18 && now.getMinutes() === 0) {
        const sheet = await setupSheet();
        const rows = await sheet.getRows();
        const today = moment().format('YYYY-MM-DD');
        const todayVideos = rows.filter(row => row['Sana'] === today);
        
        await bot.telegram.sendMessage(
          process.env.ADMIN_ID,
          `🌙 *Kunlik hisobot*\n\n` +
          `📅 Sana: ${today}\n` +
          `🎥 Videolar: ${todayVideos.length} ta\n` +
          `⚠️ Anomaliyalar: ${todayVideos.filter(row => row['Anomalies'] !== 'Yoʻq').length} ta`
        );
      }
    }, 60000); // Har minut tekshirish
    
  } catch (err) {
    console.error('Ishga tushirish xatosi:', err);
    process.exit(1);
  }
}

// To'xtatish
process.once('SIGINT', async () => {
  await redisClient.quit();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await redisClient.quit();
  bot.stop('SIGTERM');
});

bot.command('panel', async (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;

  await ctx.reply('🔧 Admin Paneli:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Bugungi Statistika', callback_data: 'stats_today' }],
        [{ text: '📈 Oylik Hisobot', callback_data: 'monthly_report' }],
        [{ text: '🔍 Video Qidirish', callback_data: 'find_start' }]
      ]
    }
  });
});

bot.action('stats_today', async (ctx) => {
  const sheet = await setupSheet();
  const rows = await sheet.getRows();
  const today = moment().format('YYYY-MM-DD');
  const count = rows.filter(row => row['Sana'] === today).length;
  await ctx.answerCbQuery();
  await ctx.reply(`📅 Bugungi videolar: ${count} ta`);
});

bot.action('monthly_report', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('📤 Oylik hisobot hozircha mavjud emas (tez orada qo‘shiladi)');
});

bot.action('find_start', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🔍 Iltimos, qidirilayotgan foydalanuvchi ID yoki username ni yozing:');
});

start();