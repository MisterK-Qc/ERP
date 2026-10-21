const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

createApp({ dataDir }).listen(port, () => {
  console.log(`ArchiDoc démarré sur http://localhost:${port}`);
});
