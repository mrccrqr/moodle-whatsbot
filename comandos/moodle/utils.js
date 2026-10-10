'use strict';

const fs           = require("fs");
const path         = require("path");
const { DateTime } = require("luxon");
const { ZONA, LOG_PATH } = require("./config");

const sleep = ms => new Promise(r => setTimeout(r, ms));

const agora = () => DateTime.now().setZone(ZONA);

// Log com nivel e rotacao automatica (trunca acima de 1MB)
function log(nivel, ...args) {
    const emoji = { ok: "✓", erro: "✗", aviso: "!", info: "ℹ" }[nivel] ?? " ";
    const linha = `[${agora().toFormat("dd/MM HH:mm:ss")}] [${emoji}] ${args.join(" ")}\n`;
    process.stdout.write(linha);
    try {
        const dir = path.dirname(LOG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1024 * 1024)
            fs.writeFileSync(LOG_PATH, linha);
        else
            fs.appendFileSync(LOG_PATH, linha);
    } catch {}
}

module.exports = { sleep, agora, log };
