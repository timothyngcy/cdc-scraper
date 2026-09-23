// Prints the chat IDs your bot can see. Message your bot once, then run this.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const body = await res.json();
if (!body.ok) { console.error('telegram error:', body); process.exit(1); }
if (!body.result.length) {
  console.log('No updates. Open Telegram, send your bot any message, then run this again.');
  process.exit(0);
}
const seen = new Map();
for (const u of body.result) {
  const chat = u.message?.chat ?? u.channel_post?.chat;
  if (chat) seen.set(chat.id, chat);
}
for (const [id, chat] of seen) {
  console.log(`chat_id: ${id}  (${chat.type}${chat.username ? ` @${chat.username}` : ''}${chat.title ? ` "${chat.title}"` : ''})`);
}
