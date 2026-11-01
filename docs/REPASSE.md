# Acesso ao Moodle: direto, repasse ou proxy

**Quem roda o bot no Brasil nao precisa de nada disto.** O padrao e acessar o Moodle direto.

## Por que existe

Desde 23/10/2026 a UESB bloqueia o acesso ao Moodle a partir de fora do Brasil: o firewall descarta a
conexao antes de ela abrir (testado em 40 paises; Sao Paulo responde). Por isso, um bot rodando numa VPS no
exterior nao consegue falar com o Moodle. Cabecalhos como `X-Forwarded-For` nao resolvem: eles so seriam
enviados depois da conexao aberta, e ela nunca abre.

A solucao e fazer **so as chamadas do bot ao Moodle** sairem por um IP brasileiro. O WhatsApp e o resto
continuam saindo pela VPS, e os links enviados aos alunos continuam apontando para o Moodle de verdade.

## As tres opcoes (`MOODLE_ACESSO` no `moodle/.env`)

| `MOODLE_ACESSO` | Quando usar | Configuracao |
|---|---|---|
| `direto` (padrao) | Bot rodando no Brasil, ou Moodle sem bloqueio | nenhuma |
| `repasse` | Bot fora do Brasil (ex.: VPS na Europa) | `MOODLE_REPASSE_URL` |
| `proxy` | Voce ja tem um proxy SOCKS com saida no Brasil | `MOODLE_PROXY=socks5://host:porta` |

**Desligar o repasse sem apagar nada:** `MOODLE_ACESSO=direto` (ou `npm run repasse -- desligar`).
Para voltar: `MOODLE_ACESSO=repasse` (ou `npm run repasse -- ligar`). Reinicie o bot depois de mudar.

## O repasse: API Gateway da AWS em Sao Paulo

E um **API Gateway (HTTP API)** na regiao `sa-east-1` (Sao Paulo) que repassa qualquer caminho para o
Moodle (`/{proxy+}` -> `https://moodle4.uesb.br/{proxy}`). Nao tem codigo nem servidor para manter.

- **Custo:** o bot faz ~200 chamadas por dia (~6 mil por mes). O API Gateway da 1 milhao por mes gratis no
  primeiro ano; depois, ~US$ 1 por milhao -> menos de US$ 0,01 por mes.
- **Limite:** 5 requisicoes por segundo (o bot nunca chega perto). Evita custo se alguem descobrir o endereco.
- **Tamanho:** respostas de ate 10 MB (anexos maiores que isso nao baixam pelo repasse).
- **Nomes de arquivo com espaco:** o API Gateway decodifica o caminho (`%20` vira espaco) e o Moodle
  responde 400. Por isso, pelo repasse, o bot baixa anexos com o caminho no parametro
  (`tokenpluginfile.php?file=/...`) em vez de no caminho da URL (`http.js`, `urlViaRepasse`).

### Chaves da AWS: onde ficam?

**O bot nao usa chave nenhuma da AWS.** O repasse e so um endereco
(`https://xxxxxxxx.execute-api.sa-east-1.amazonaws.com`), que vai no `.env` como `MOODLE_REPASSE_URL`.
As chaves da AWS (as do `aws configure`) sao usadas **uma vez, no seu computador, para criar** o repasse,
e ficam na configuracao da AWS CLI (`~/.aws/credentials`), nunca no projeto.

### Cada usuario cria o proprio repasse

Quem usa um repasse manda a senha e o token do Moodle por ele (protegidos por HTTPS ate a AWS, mas
visiveis para o dono da conta AWS que o criou). Por isso **nao compartilhe o seu repasse**: cada pessoa
que rodar o bot fora do Brasil cria o seu, na propria conta AWS.

### Criar (3 passos)

1. Instale a [AWS CLI](https://aws.amazon.com/cli/) e rode `aws configure` com uma chave que tenha
   permissao de API Gateway (ex.: politica `AmazonAPIGatewayAdministrator`), regiao `sa-east-1`.
2. Na pasta do bot:
   ```bash
   npm run repasse -- criar
   ```
   Isso cria o repasse na sua conta (ou reaproveita, se ja existir), testa se o Moodle responde por ele e
   grava no `moodle/.env`:
   ```env
   MOODLE_ACESSO=repasse
   MOODLE_REPASSE_URL=https://xxxxxxxx.execute-api.sa-east-1.amazonaws.com
   ```
3. Reinicie o bot. O log mostra: `Acesso ao Moodle pelo repasse xxxxxxxx.execute-api...`

Se o bot roda numa VPS sem AWS CLI, crie o repasse no seu computador (passos 1 e 2) e copie as duas linhas
acima para o `moodle/.env` da VPS.

**Sem CLI, pelo painel da AWS:** API Gateway -> Create API -> HTTP API -> integracao HTTP com URL
`https://moodle4.uesb.br/{proxy}` e metodo ANY -> rota `ANY /{proxy+}` -> estagio `$default` com
implantacao automatica. Copie o endereco "Invoke URL" para `MOODLE_REPASSE_URL`.

### Outros comandos

```bash
npm run repasse -- status                # modo atual + teste do acesso direto e pelo repasse
npm run repasse -- desligar              # MOODLE_ACESSO=direto (mantem a URL)
npm run repasse -- ligar                 # MOODLE_ACESSO=repasse
npm run repasse -- remover --confirmar   # apaga o repasse da AWS e volta para direto
```

Opcoes: `--regiao sa-east-1`, `--nome moodle-whatsbot-repasse`, `--env caminho/do/.env`.

## Aviso quando o acesso cai

Independente do modo: se o bot ficar mais de 30 min sem conseguir falar com o Moodle, ele avisa o admin
**uma vez**, dizendo se o Moodle esta fora do ar ou se esta bloqueando o servidor (ele testa a partir do
Brasil), e **uma vez** quando o acesso volta. As verificacoes nesse periodo ficam em silencio.

## Se a AWS tambem for bloqueada

O bot avisa ("bloqueando o servidor do bot"). Alternativas: um servidor no Brasil (ex.: Oracle Cloud em
Sao Paulo, com a ressalva de que maquinas gratuitas ociosas podem ser recolhidas) rodando o bot inteiro, ou
servindo de proxy SOCKS (`MOODLE_ACESSO=proxy`).
