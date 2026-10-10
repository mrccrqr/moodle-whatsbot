'use strict';

const path = require("path");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

// Pasta da sessao do WhatsApp, sempre dentro do projeto (independe de onde o bot e iniciado)
const AUTH_DIR = path.join(__dirname, "..", "auth");

// Inicializa estado de autenticacao do Baileys (persiste em auth/)
async function iniciarAutenticacao() {
    return useMultiFileAuthState(AUTH_DIR);
}

module.exports = { iniciarAutenticacao, AUTH_DIR };
