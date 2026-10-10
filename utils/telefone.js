'use strict';

// Numeros de telefone e IDs do WhatsApp (funcoes puras).
//
// Aceita o numero do jeito que a pessoa escreve: "77998765432", "7798765432", "(77) 99876-5432",
// "+55 77 99876-5432", "5577998765432" ou um JID completo ("557798765432@s.whatsapp.net").
//
// O "nono digito": no Brasil o 9 foi acrescentado aos celulares, mas contas antigas do WhatsApp
// continuam registradas SEM ele (ex.: o numero 55 77 9 9876-5432 tem o ID 557798765432).
// Nao da para saber so pelo numero; por isso geramos as duas variantes e perguntamos ao WhatsApp
// qual existe (ver utils/jid.js).

const soDigitos = s => String(s || "").replace(/\D/g, "");

const ehGrupo = jid => /@g\.us$/.test(jid || "");
const ehLid   = jid => /@lid$/.test(jid || "");

// Variantes de um numero brasileiro (com e sem o nono digito), so digitos, comecando pela informada
function variantesNumero(entrada) {
    let d = soDigitos(String(entrada).split("@")[0].split(":")[0]);
    if (!d) return [];
    if (d.length === 10 || d.length === 11) d = "55" + d;          // so DDD + numero
    if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return [d]; // estrangeiro/fora do padrao

    const ddd = d.slice(2, 4);
    if (d.length === 13 && d[4] === "9") return [d, `55${ddd}${d.slice(5)}`];          // com 9 -> sem 9
    if (d.length === 12 && /[6-9]/.test(d[4])) return [d, `55${ddd}9${d.slice(4)}`];  // sem 9 -> com 9 (so celular)
    return [d];
}

// JID padrao (sem consultar o WhatsApp). Grupos e LIDs passam direto.
function paraJid(entrada) {
    const s = String(entrada || "").trim();
    if (!s) return null;
    if (ehGrupo(s) || ehLid(s)) return s;
    const [d] = variantesNumero(s);
    return d ? `${d}@s.whatsapp.net` : null;
}

// Chave para comparar numeros ignorando o nono digito (celular BR vira a forma de 12 digitos)
function chaveNumero(entrada) {
    const v = variantesNumero(entrada);
    return v.find(x => x.length === 12 && x.startsWith("55")) || v[0] || "";
}

const mesmoNumero = (a, b) => !!a && !!b && !ehGrupo(a) && !ehGrupo(b) && !ehLid(a) && !ehLid(b)
    && chaveNumero(a) === chaveNumero(b);

module.exports = { soDigitos, variantesNumero, paraJid, chaveNumero, mesmoNumero, ehGrupo, ehLid };
