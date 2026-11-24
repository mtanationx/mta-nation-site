# MTA POS — notas técnicas

Sistema de vendas da loja (Glória Mall) em **mz.mtanation.com/pos**.

## Arquitetura
- `pos/index.html` — app (uma página). Funciona em tablet, telemóvel e computador.
- `pos/products.json` — lista de artigos (gerada a partir do catálogo `index.html`; preço de tabela sem desconto).
- `functions/api/[[path]].js` — API (Cloudflare Pages Functions). Base de dados D1 com binding **`DB`** (base `mta-pos`). As tabelas criam-se sozinhas.
- O site do catálogo lê o stock em `/api/stock` (CSV no mesmo formato da Google Sheet antiga).

## Regras
- Login por PIN (4–8 dígitos, único por pessoa). Funções: Vendedor; Gerente (caixa/recolhas, anular vendas, apagar despesas); Admin (tudo: stock, relatórios, equipa).
- Clientes: criados automaticamente em cada venda com telefone (normalizado +258). Telefone validado no POS e no servidor: Moçambique = 9 dígitos 82–87 (ou 258 + 9); estrangeiro = + ou 00 e 8–15 dígitos. Ficha com aniversário, tamanhos, Instagram, notas e histórico. Exportação CSV.
- Marketing → Anúncios Meta: /api/ads lê Marketing API v26 (segredos Cloudflare META_TOKEN e META_ACT), por mês: investido, conversas iniciadas (messaging_conversation_started_7d), contactos novos, custo por conversa, alcance, cliques, por campanha; cache 30 min em settings; cruza com vendas de origem "Anúncio" no POS (taxa USD em settings.usd_rate).
- Marketing → Mensagens WhatsApp: registo (tipo, datas, custo, mensagem). Na venda, "Veio de onde?" é obrigatório (campanhas ativas + origens fixas). Resultados: vendas, receita, clientes novos, custo por venda, retorno. Envio WhatsApp semi-manual por segmentos (todos, VIP 5000+, inativos 60d, aniversário, compraram categoria), com registo de quem recebeu e compras nos 14 dias seguintes.
- Givings (mensal; código interno "gastos"): tabela giving (+ recibo em foto na tabela receipts, comprimido no telemóvel). Inclui automaticamente as despesas da caixa. Resultado do mês = vendas (produtos) − gastos. "Copiar fixos" duplica os gastos recorrentes do mês anterior. Inclui automaticamente da Logística: pagamento da encomenda no mês da encomenda (mzn) e levantamento no mês da chegada (pickup). Estado Pago/Por pagar (por pagar não conta no total; "Copiar fixos" cria-os como Por pagar com o último valor como previsto). Meta Ads entra automaticamente (gasto do mês via Marketing API, convertido a settings.usd_rate). Novembro 2026 importado do Notion (functions/_lib/seed-giving.js, flag giving_seeded_nov26).
- Logística: encomendas da China (tabela logistics; pay_method = pagamento da encomenda, pickup_method = pagamento do levantamento + anexo em logistics_files). Importação única do Notion via functions/_lib/seed-logistics.js (flag settings.logistics_seeded). Estados: Por receber, Em trânsito, Chegou (por levantar), Recebido. KPIs: em curso, investido no ano, levantamento médio %, tempo médio de entrega por via.
- Ponto: clock in/out com PIN só em dispositivos autorizados (tabela devices; token em localStorage posDevice; admin autoriza em Equipa). Horários por pessoa/dia (schedules), tolerância settings.late_tolerance (10), valor hora extra users.ot_rate. Relatório /api/attendance: atrasos, faltas (só desde attendance_start e criação do utilizador), saídas antecipadas, extra (dia de folga trabalhado = tudo extra), sem saída. Correções pela gerência ficam marcadas (edited_by).
- Avaliações com foto opcional (review_photos, comprimida no telemóvel, servida em /api/reviews/:id/photo). Design estilo Gasper: estrelas verdes #2E7D4F, grelha 2 colunas (4 no desktop na página inicial), selo ✓ Verificado. (também formulário aberto no site: /api/reviews/open, máx. 3/dia por IP, por aprovar; selo “Compra verificada” se veio de venda, senão “Verificada pela MTA” após aprovação): tabela reviews (status pending/approved/rejected, featured). Clientes avaliam via link no recibo WhatsApp (/avaliar/?s=ID&k=review_token; “compra verificada”), ficam por aprovar. Gerência regista elogios do WhatsApp em Marketing → Avaliações (publicados logo). Site: secção “O que dizem os clientes” (destaques primeiro) e avaliações na página de cada produto.
- Caixa: saldo = vendas cash (+transporte) − despesas pagas com cash − recolhas ± ajustes. Na recolha, a diferença contado−esperado vira ajuste automático. A recolha gera mensagem para o grupo de WhatsApp.
- Cada venda baixa o stock da variante (produto · cor · tamanho) se essa linha tiver número. Anular devolve o stock.
- Preço por defeito = tabela − desconto da promoção do site (público; VIP com a caixa "Cliente VIP"). Conjuntos sem desconto. O preço pode ser alterado em cada linha.
- Desconto extra por venda (sales.discount; botões −50/−100/−150/−200/Outro no carrinho). subtotal já vem com o desconto descontado. Fecho mostra "Descontos dados"; recibo mostra a linha.
- Fecho: produtos, transporte, despesas, comissão (% por pessoa, sobre produtos sem transporte), totais por pagamento e por local.
- Dia = data de Maputo (UTC+2).

## Endpoints
`GET /api/status` · `POST /api/setup` · `POST /api/login` · `POST /api/logout` · `GET /api/boot` · `GET|POST /api/sales` · `POST /api/sales/:id/void` · `POST /api/expenses` · `DELETE /api/expenses/:id` · `GET|PUT /api/stock` · `POST /api/stock/import` · `GET /api/stock/log` · `POST /api/users` · `PUT /api/users/:id` · `PUT /api/settings` · `GET /api/report?from&to`

## Teste local
`wrangler pages dev . --d1 DB=pos-local --port 8788`

## Entregas (motoboy)
- Separador **Entregas** (todos os papéis). O resumo semanal/mensal e o custo só aparecem a gerente/admin; as ⚙️ Regras só ao admin.
- **📍 Calcular taxa:**
  - Pesquisa de endereço (Nominatim), coordenadas coladas ou um toque no mapa (Leaflet + OSM).
  - Rota pela estrada a partir da loja (OSRM). Sem serviço de rotas, usa linha reta × 1,35.
  - Taxa = base até X km + valor/km extra, arredondada. Settings: `dlv_base`, `dlv_base_km`, `dlv_km`, `dlv_round`.
  - Origem da loja em `dlv_origin`; o admin pode corrigi-la com "★ A loja é aqui".
- Tabela `deliveries`:
  - Tipo: Entrega / Levantamento / Outro.
  - Guarda km de ida e `km_total` (ida e volta) e a taxa.
  - Estado: Pendente / Entregue / Cancelada; `delivered_at` regista a hora.
- **Vendas com local "Delivery":** criam automaticamente uma entrega Pendente. No checkout, o botão 📍 calcula a taxa e guarda o endereço e os km. Anular a venda cancela a entrega pendente.
- **Motoboy:** `courier_name` (Azevedo) e `courier_weekly` (2.500 MT).
  - As semanas vão de segunda a domingo e cada semana conta no mês em que termina.
  - O resumo alerta para semanas sem voltas.
  - As semanas antes de `dlv_start`, a data do primeiro uso, ficam fora das contas.

## Avaliações: uma só por compra (24/11)
- `/avaliar/?s&k`: o cliente dá 1 classificação, 1 comentário e 1 foto para a compra toda, com as peças compradas mostradas como contexto.
- `/reviews/submit` cria 1 avaliação pendente com `products` (JSON com os ids da venda). Se a venda tem só 1 peça, o `product_id` já fica preenchido.
- No POS (Marketing → Avaliações), cada avaliação pendente mostra chips "Juntar a:", todos ligados por defeito. Ao aprovar, `POST /reviews/:id/approve {products}` faz o seguinte:
  - a avaliação original fica com o 1.º produto;
  - para cada produto seguinte cria uma cópia aprovada, com `photo_of` a apontar para a foto original (a foto não é duplicada).
- Se se apagar a avaliação original, a foto mantém-se enquanto houver cópias que a usam.
- O botão "📩 Pedir avaliação" lista as vendas dos últimos 60 dias (`/reviews/requests`) e abre o WhatsApp do cliente com o link.
