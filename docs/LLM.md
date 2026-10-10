# Assistente com LLM — desenho

Objetivo: responder no WhatsApp, de forma natural e humana, qualquer pergunta sobre **o curso** (prazos,
aulas, avisos, atividades, como usar o Moodle) — **sem inventar**.

Nada disto esta implementado ainda. O desenho abaixo junta as decisoes tomadas e as observacoes coletadas com
requisicoes reais (out/2026, contas de ADS e Pedagogia na UESB).

## 0. Decisoes tomadas

| Tema | Decisao |
|---|---|
| Quem pergunta | Alunos da turma, no privado do bot **ou** no grupo |
| Grupo | So responde quando **mencionado** (`@bot`) ou quando alguem **responde a uma mensagem do bot** (para continuar a conversa). Responde como mensagem normal, **sem citar** a pergunta |
| Que informacao | **So o que e igual para todos** (prazos, aulas, avisos, atividades, materiais publicados). O bot usa a conta Moodle do admin: nada individual (notas, entregas, pendencias pessoais) |
| Conteudo das disciplinas | **Nao responde** ("o que e normalizacao?"). So sobre o curso e o Moodle |
| Fora do curso | Recusa curta e educada |
| Tom | Natural, frases curtas, **sem emojis** |
| Modelo | A decidir por teste (secao 6) |

## 1. Arquitetura: resumo do dia + poucas ferramentas

Dados do Moodle mudam o tempo todo e sao estruturados: o modelo nao "decora" nada, ele recebe os dados na hora.

**Resumo pronto a cada pergunta** (~2–4 mil tokens), montado pelo bot:
- data/hora atual em America/Sao_Paulo ("hoje e sabado, 10/10/2026, 14:30");
- disciplinas do semestre com apelidos ("Banco de Dados II" = "BD II", "BD 2", "banco");
- agenda dos proximos 14 dias (prazos de qualquer tipo + aulas), com links;
- ultimos avisos dos professores (titulo + inicio do texto).

A maioria das perguntas ("tem atividade pra hoje?", "quando e a proxima aula de Web?") se responde so com o
resumo — sem o modelo precisar escolher ferramenta, que e onde modelos baratos mais erram.

**Ferramentas** (todas somente leitura) para o que nao cabe no resumo:

| Ferramenta | Fonte na API | Para que |
|---|---|---|
| `agenda(inicio, fim)` | `core_calendar_get_calendar_events` (1 requisicao, todas as disciplinas, intervalo de datas) | Periodos fora dos 14 dias |
| `atividade(nome ou cmid)` | `mod_assign_get_assignments` / `core_course_get_contents` | Descricao, anexos, datas de uma atividade |
| `avisos(disciplina, n)` | `mod_forum_get_forums_by_courses` (news) + `mod_forum_get_forum_discussions` | Texto completo de avisos |
| `materiais(disciplina)` | `core_course_get_contents` | O que foi publicado (links, arquivos, gravacoes) |

Como o modelo escolhe: junto com a pergunta ele recebe a lista de ferramentas (nome, descricao, parametros) e
responde pedindo uma chamada, ex. `agenda(inicio: "2026-10-11", fim: "2026-10-13")`. O bot executa, devolve um
JSON enxuto e o modelo escreve a resposta. Poucas ferramentas, sem sobreposicao e bem descritas = menos erro.

As funcoes de `comandos/moodle/api.js` ja fazem quase tudo — o assistente as reutiliza.

## 2. So informacao igual para todos (conta unica)

O bot le o Moodle com a conta do admin. Por isso:

- **Fora:** notas, status de entrega, "o que falta eu entregar" (`core_calendar_get_action_events_by_timesort`
  depende do progresso de quem e dono da conta), feedback. Pergunta sobre nota ->
  "Nao tenho acesso as notas de cada aluno, so as informacoes gerais da turma."
- **Eventos pessoais do calendario** (`eventtype: "user"`) do admin: filtrar sempre.
- **Cuidado — dados que parecem gerais mas podem ser do admin:**
  - prorrogacao individual de prazo (override) concedida ao admin aparece como prazo da tarefa;
  - eventos de **grupo** (`eventtype: "group"`) podem ser do polo do admin e nao do aluno que pergunta.
  Nesses casos, preferir o prazo geral da atividade e, na duvida, mandar o link.
- O monitor de notas que ja existe continua mandando as notas **do admin** so para o admin (nao muda).

## 3. Escopo: o que responde e o que recusa

| Tipo | Exemplo | Comportamento |
|---|---|---|
| Dados do curso | "tem atividade hoje?", "quando e a aula de Web?", "o professor de BD II avisou algo?" | Responde com os dados reais |
| Uso do Moodle | "como envio arquivo na tarefa?" | Responde (conhecimento geral sobre o Moodle) |
| Conteudo das disciplinas | "o que e normalizacao?" | Recusa: so ajuda com informacoes do curso |
| Fazer a atividade pelo aluno | "responde a atividade III pra mim" | Recusa |
| Notas/entregas individuais | "qual minha nota em BD II?" | Explica que nao tem acesso a dados individuais |
| Fora do curso | "quem ganhou o jogo?" | Recusa curta e educada |

Camadas do isolamento:
1. **Instrucoes** com o escopo acima e exemplos dos dois lados. Na duvida, tenta ajudar com o que tem do curso
   (recusar demais tambem e ruim).
2. **Ferramentas** so de leitura do Moodle: mesmo convencido a "sair do papel", o modelo nao tem acesso a mais nada.
3. **Limite de perguntas** por pessoa por dia (custo e abuso).
4. Um "porteiro" separado (chamada barata que so classifica a pergunta) **nao** entra de inicio: dobra a demora.
   Entra se o teste mostrar respostas fora do escopo.

## 4. Grupo: mencao e continuacao

- A mencao chega em `message.extendedTextMessage.contextInfo.mentionedJid`. Os grupos usam ID de privacidade
  (`addressingMode: lid`), entao a mencao ao bot vem pelo LID dele (ex.: `180724254687283@lid`) — aceitar o
  ID por numero **e** por LID (`sock.user.id` e `sock.user.lid`).
- **Continuacao:** resposta a uma mensagem do bot (`contextInfo.participant` = bot, com `stanzaId`) conta como
  chamar o bot, sem nova mencao. A mensagem citada entra como contexto.
- Responde como mensagem normal no grupo, **sem citar** a pergunta.
- O nome que aparece na mencao e o nome de perfil do WhatsApp do bot: definir no celular do bot (ex.: "Moodle Bot").
- Memoria curta por conversa (ultimas trocas), separada por grupo/privado e por pessoa.

## 5. Estilo (o que faz soar humano)

- Portugues do dia a dia, frases curtas, direto ao ponto. **Sem emojis.**
- Datas relativas: "amanha", "sexta", "semana que vem" (com a data quando ajudar: "sexta (16/10)").
- Nomes curtos das disciplinas ("BD II", "Web II").
- Formatacao do WhatsApp: *negrito* com moderacao, sem titulos nem listas longas.
- Resposta longa -> 2 ou 3 mensagens com "digitando..." (`enviarDigitando` em `utils/wa.js`).
- Sem "Ola! Como posso ajudar?" no comeco nem "Espero ter ajudado!" no fim.
- **Exemplos de boas respostas nas instrucoes** (few-shot): pesam mais no tom do que trocar de modelo.
- **Nunca inventar:** responder so com o que veio do resumo/ferramentas; se nao houver, dizer que nao encontrou
  e mandar o link do Moodle da disciplina.

## 6. Escolha do modelo (por teste, nao por ranking)

Rankings publicos medem outras coisas. Aqui importam: escolher a ferramenta certa, nao inventar, entender datas
relativas e escrever portugues natural.

**Plano:**
1. Juntar 30–50 perguntas reais da turma (o admin esta coletando).
2. Congelar um retrato do Moodle (agenda, avisos, atividades) para todos responderem sobre os mesmos dados.
3. Rodar todas as perguntas em cada candidato, com as mesmas ferramentas e instrucoes.
4. Pontuar:

| Criterio | Como medir | Peso |
|---|---|---|
| Nao inventar | Datas, links e nomes batem com os dados? Disse "nao encontrei" quando nao havia? | Maior |
| Acerto | Respondeu o que foi perguntado? | Alto |
| Naturalidade | Nota 1–5 dada pelo admin lendo as respostas | Alto |
| Escopo | Recusou o que devia e nao recusou o que nao devia? | Medio |
| Custo e tempo | Medidos automaticamente | Desempate |

Custo do teste: menos de US$ 2 para 50 perguntas em 5–6 modelos.

**Candidatos e precos** (out/2026, conferir antes):

| Modelo | Entrada / Saida por 1M tokens | ~Custo por pergunta | Turma (~650 perguntas/mes) |
|---|---|---|---|
| Claude Haiku 4.5 | US$ 1 / US$ 5 | US$ 0,01 | ~US$ 6/mes |
| Claude Sonnet 5.5 | US$ 2 / US$ 10 | US$ 0,02–0,03 | ~US$ 15/mes |
| GPT-5.4 mini (OpenAI) | US$ 0,75 / US$ 4,50 | US$ 0,008 | ~US$ 5/mes |
| Grok 4.1 Fast (xAI) | US$ 0,20 / US$ 0,50 | US$ 0,002 | ~US$ 1,50/mes |
| Gemini Flash (Google) | camada gratis com limite diario | US$ 0 ate o limite | — |
| Modelo aberto via Groq | gratis com limites | US$ 0 | — |

Estimativa: ~8 mil tokens de entrada e ~0,5–1 mil de saida por pergunta. Instrucoes e definicao das
ferramentas podem ser cacheadas (leitura de cache ~10% do preco de entrada).

Hipotese antes do teste: Claude Haiku 4.5 como melhor custo-beneficio, Sonnet 5.5 como reserva se faltar
naturalidade. O teste decide.

Observacoes:
- Assinatura Claude Pro/Max (chat) nao e chave de API: o bot precisa de creditos da API, pagos a parte.
- Camadas gratis tem limite por minuto/dia; no Google, dados da camada gratis podem ser usados para melhorar os
  produtos — atencao com mensagens de alunos.

## 7. Particularidades dos dados (aprendidas na pratica)

- **Fuso:** timestamps sao Unix (UTC); converter sempre para America/Sao_Paulo.
- **Nomes de eventos** vem com moldes ("X está marcado(a) para esta data", "Término de X", "X é devido"):
  limpar com `nomeDoEvento` (`verificacoes.js`).
- **Aulas:** em ADS ficam no calendario; em Pedagogia nao (so salas LTI). Algumas aulas so existem como texto
  em aviso ("quinzenais, sextas as 20h30") — ver ROADMAP item 2.
- **Descricoes longas** (5+ mil caracteres): mandar ao modelo so o necessario.
- **Tamanho da API:** `mod_assign_get_assignments` sem filtro ~390 KB, com `courseids` ~38 KB;
  `core_course_get_contents` ~42 KB por disciplina. Nunca mandar resposta crua: montar JSON enxuto.

## 8. Seguranca

- **Prompt injection:** avisos e descricoes sao texto de terceiros dentro do contexto — delimitar e tratar como
  dados. Em grupo, alguem vai tentar "ignore suas regras": o pior caso deve ser uma resposta fora do tema,
  nunca uma acao (as ferramentas so leem).
- **Nada individual** sai (secao 2); credenciais e token nunca entram no contexto do modelo.
- **Limites:** perguntas por pessoa/dia e tamanho maximo de resposta.
