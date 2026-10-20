'use strict';

const V = require("./verificacoes");
const { verificarNovidades } = require("./novidades");

// Agenda diaria de verificacoes: [hora, minuto, nome, funcao]
// Fica num lugar so para ser usada pelo bot (index.js) e pelos testes de simulacao.
const AGENDA = [];

// Novidades (atividades, prazos alterados, materiais) e avisos dos professores: varias vezes ao dia.
// Novidades saem numa mensagem por disciplina; se o professor estiver mexendo, esperam ele terminar.
for (const h of [6, 9, 12, 15, 18, 21]) {
    AGENDA.push([h, 0, `Novidades ${h}h`, verificarNovidades]);
    AGENDA.push([h, 5, `Avisos ${h}h`,    V.verificarAvisos]);
}

AGENDA.push(
    [12, 0, "Vencimentos",      V.verificarVencimentos],
    [12, 0, "Lembretes",        V.verificarLembretes],
    [14, 0, "Foruns do dia",    V.verificarForuns],
    [18, 0, "Aulas do dia 18h", V.verificarAulasHoje],
    [19, 0, "Aulas do dia 19h", V.verificarAulasHoje],
    [20, 0, "Aulas do dia 20h", V.verificarAulasHoje],
);

// Notas: de hora em hora (das 7h as 23h), so para o admin
for (let h = 7; h <= 23; h++) AGENDA.push([h, 30, `Notas ${h}h`, V.verificarNotas]);

AGENDA.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));

// Rodam uma vez ao iniciar: na primeira execucao registram o que ja existe (sem avisar);
// depois de um periodo desligado, avisam o que apareceu enquanto o bot estava fora.
// Os avisos do dia (vencimentos, foruns, aulas) so rodam se o horario normal deles ja passou;
// o cache impede envio em dobro caso ja tenham sido enviados hoje.
// [nome, funcao, a partir de que hora do dia]
const AO_INICIAR = [
    ["Novidades",     verificarNovidades,     0],
    ["Avisos",        V.verificarAvisos,      0],
    ["Notas",         V.verificarNotas,       0],
    ["Vencimentos",   V.verificarVencimentos, 12],
    ["Lembretes",     V.verificarLembretes,   12],
    ["Foruns do dia", V.verificarForuns,      14],
    ["Aulas do dia",  V.verificarAulasHoje,   18],
];

module.exports = { AGENDA, AO_INICIAR };
