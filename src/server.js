const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const reminderMinutes = Number(process.env.REMINDER_INTERVAL_MINUTES) || 15;

const app = createApp({ dataDir });

app.listen(port, () => {
  console.log(`ArchiDoc démarré sur http://localhost:${port}`);
});

setInterval(() => {
  try {
    const sent = app.locals.runReminders();
    if (sent) console.log(`${sent} relance(s) envoyée(s) pour des étapes en retard`);
  } catch (err) {
    console.error('Échec des relances :', err);
  }
}, reminderMinutes * 60_000).unref();
