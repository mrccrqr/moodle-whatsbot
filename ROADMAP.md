# Roadmap

Funcionalidades planejadas e pontos de atencao levantados durante os testes (out/2026).
Notas para o assistente com LLM ficam em [docs/LLM.md](docs/LLM.md).

## 1. Verificar se a aula ao vivo comecou (proxima implementacao)

**Problema:** o link real da sala (Mconf/ConferenciaWeb) muitas vezes so existe perto do horario. Hoje o bot
avisa as 18h com o link do Moodle (LTI) e nao reenvia quando a sala de fato abre.

**Descoberta:** a ConferenciaWeb (RNP) tem um endpoint **publico, sem login**, que diz se a sala esta ao vivo:

```
GET https://conferenciaweb.rnp.br/conference/rooms/<sala>/running.json
-> {"running":"false","meeting_info":null}     (ou "true" quando a aula comecou)
```

A `<sala>` vem do link de convite (`https://conferenciaweb.rnp.br/sala/<sala>`), que aparece em avisos,
descricoes de eventos e em `linksFixos`. A pagina de convite redireciona para
`/conference/rooms/<sala>/invite_userid` e referencia o `running.json` no atributo `data-url`.

Para salas Mconf via LTI (`lti.mconf.rnp.br`), o `lti.js` ja abre a sala e encontra
`/scheduled_meetings/<id>/join`; falta descobrir o equivalente de "esta rodando" (provavelmente um JSON
parecido na pagina da sala) — investigar no proximo passo.

**Desenho proposto:**
- Para cada aula prevista no dia (calendario, `aulasExtras` ou aula recorrente detectada, ver item 2),
  consultar a sala a cada ~2 min, de 10 min antes ate 40 min depois do horario.
- Quando `running` virar `true`: enviar `*AULA DE X COMECOU*` com o link publico e marcar no cache.
- Se nao abrir na janela: nao avisar nada (ou avisar so o admin, para depuracao).
- Custo: poucas requisicoes leves por aula; nenhuma credencial.

## 2. Aulas recorrentes/quinzenais detectadas automaticamente

**Problema:** algumas disciplinas nao colocam a aula no calendario do Moodle. Exemplo real (Projeto Integrador):
o professor publicou no forum de Avisos "Link das aulas sincronas quinzenais (sextas-feiras as 20h30min)"
com o link da ConferenciaWeb. Hoje isso depende de configurar `aulasExtras` na mao (e o horario pode ficar
errado: estava 20:00, o aviso diz 20h30).

**Desenho proposto (depende do item 1):**
- Ao receber um aviso/descricao, extrair: dia da semana ("sextas-feiras"), horario ("20h30", "20:30"),
  frequencia ("quinzenal", "semanal") e link de sala. Regex resolve a maioria; o LLM (docs/LLM.md) pode
  resolver os casos dificeis.
- Guardar como "aula recorrente detectada" no cache, com a fonte (link do aviso).
- **Quinzenal nao precisa saber qual semana:** em todo dia candidato, o item 1 consulta a sala; se ela abrir,
  avisa. Nas semanas sem aula a sala nao abre e nada e enviado.
- `aulasExtras` continua existindo como ajuste manual.

## 3. Pontos que ainda dependem de configuracao manual

Testado com duas contas reais (ADS 2026.2 e Pedagogia 2026.1): com so usuario/senha, o bot descobre sozinho
semestre, disciplinas, cursos permanentes (ex.: ATPA, Informes da Coordenacao), tarefas, modulos, foruns,
avisos, prazos, aulas do calendario, salas LTI e notas. O que ainda nao e automatico:

| Ponto | Situacao | Ideia |
|---|---|---|
| ~~`ADMIN_JID` / `DESTINOS`~~ | **Resolvido:** numero so com DDD (nono digito resolvido com `onWhatsApp`); grupos e pessoas gerenciados no privado (`/add-grupo`, `/add-pessoa`, `/remover`, SAIR) | — |
| ~~Grupo do Mconf (`lti.js`)~~ | **Resolvido:** antes escolhia o grupo cujo nome nao continha "brumado". Agora procura o grupo que tem reuniao agendada (o aluno esta em varios grupos, ex.: "Aula Virtual", "Brumado", "Jacaraci"; a aula fica no "Aula Virtual"). O polo do aluno nao e confiavel: `core_group_get_course_user_groups` mostra o aluno em mais de um grupo de polo, e o perfil nao expoe cidade/polo | — |
| `MOODLE_HOST` | Padrao `moodle4.uesb.br` | Ok para UESB; outras instituicoes informam no .env |
| Semestre | Detectado por `(AAAA.S)` no nome do curso | Instituicoes sem esse padrao caem no fallback por data de inicio (testado so na UESB). O filtro nativo "em andamento" do Moodle nao serve na UESB (cursos sem data de termino: 28 cursos "em andamento" na conta de teste) |
| Aulas sem calendario | Disciplinas que so publicam link em aviso | Itens 1 e 2 |
| Nomes curtos | `disciplinas.json` | Opcional; o nome sem "(AAAA.S)" ja e legivel |

## 4. Multiplos alunos (Projeto Integrador, depois)

Hoje e uma conta Moodle por instancia do bot; notas e "seu progresso" sao do dono da conta.
Para varios alunos: token por usuario (nunca senha), cache e preferencias por usuario (SQLite), notas so no
privado de cada um, consentimento. A troca de conta no `.env` ja descarta o token antigo
(`MOODLE_TOKEN_USER`).

## 5. Outras melhorias anotadas

- Feedback de tarefas pode ter **arquivos** (area `feedback` em `mod_assign_get_submission_status`); hoje so o texto e enviado.
- Notas de forum nao informam o corretor (a API de notas nao traz; investigar `mod_forum` grading).
- `core_course_get_updates_since` pode substituir a leitura completa dos cursos (~42 KB por disciplina) se a carga crescer.
- Os cenarios do `npm run simular` usam IDs da turma de ADS 2026.2; em outra conta eles nao tem efeito (so os dados reais sao simulados).
