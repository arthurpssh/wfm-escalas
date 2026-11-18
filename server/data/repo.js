// Camada de acesso a dados: o servidor só fala com um "repo". Duas implementações, escolhidas por DATA_SOURCE:
//   mock   (padrão) → server/data/mockRepo.js   (memória; simula também o Apps Script em tick())
//   sheets          → server/data/sheetsRepo.js (planilha de escalas; Fase 2 = somente leitura)
//
// Contrato (todas as funções são assíncronas, exceto `drafts` e `audit`, que seguem a API síncrona de core/):
//   kind                      'mock' | 'sheets'
//   catalog()                 { activities, reasons, standardScales, teams, agents, orphanAgentIds, ctx, logins }
//                             teams[]: { id, name, coordinator, defaultTaskId, agentIds }
//                             agents[]: { id, email, name, team, scaleId, def }   (Teams.agents_ids × Users)
//   settings()                aba Config como { chave: valor } (sheets; mock = {}): ex.: access_mode
//   cells(month)              { [email]: { [dia]: Shift[] } }  — publicado, extraído do WFM
//   applyExpected(month, expected)   só mock (em produção, quem atualiza o publicado é a extração do Apps Script)
//   timeoffs.list(month) / get(id) / add(t) / addMany(list) / update(id, patch) / remove(id) / removeMany(ids) / lots()   (lote = folgas com o mesmo loteId; lots() devolve [{ loteId, items[] }] com status agendada | enviada | erro | cancelada)
//   swaps.list() / get(id) / add(s) / update(id, patch)   trocas de dia extra (aba Trocas, dona: o app)
//   holidays.list()           [{ date, name, type, source, team }] (sheets: aba Feriados, só leitura; mock: feriados nacionais fixos)
//   access.list() / add(row) / remove(id)
//   batches.list() / add(b)
//   exports.list() / get(id) / add(e) / addMany(list) / update(id, patch) / csvOf(e)   (sheets: o CSV vai para o Drive se houver DRIVE_FOLDER_ID, senão para a aba Arquivos)
//   genConfig.get(team) / set(team, cfg)
//   drafts, audit             rascunhos e histórico (Fase 3 persiste nas abas Rascunhos/RascunhoItens/Histórico)
//   consolidate(e)            consolida uma exportação (mock); em produção, vira um pedido ao Apps Script
//   capabilities              (só sheets) o que já grava: drafts, generator, audit, checkout, timeoffs, access, exports
//   init() / flush()          (só sheets) carrega do Sheets ao iniciar / grava o pendente ao encerrar
//   tick()                    mock: simula o Apps Script; sheets: no-op
//   reset()                   só mock
import { createMockRepo } from './mockRepo.js';
import { createSheetsRepo } from './sheetsRepo.js';
import { createSheetsGateway } from './sheetsGateway.js';

export async function createRepo(env = process.env) {
  const source = (env.DATA_SOURCE ?? 'mock').toLowerCase();
  if (source === 'mock') return createMockRepo({ consolidateAfterSec: Number(env.CONSOLIDATE_AFTER_SEC ?? 0) });
  if (source === 'sheets') {
    const repo = createSheetsRepo({ gateway: createSheetsGateway(env), cacheSec: Number(env.SHEETS_CACHE_SEC ?? 60), catalogCacheSec: Number(env.SHEETS_CATALOG_CACHE_SEC ?? 300) });
    const r = await repo.init();
    console.log('[sheets]', r.writable ? `escrita ligada · ${r.drafts} rascunho(s), ${r.exports} exportação(ões), ${r.batches} lote(s), ${r.historyEntries} registro(s) de histórico carregados · arquivos: ${env.DRIVE_FOLDER_ID ? 'Drive' : 'aba Arquivos da planilha'}` : 'somente leitura (SHEETS_WRITE não definido)');
    return repo;
  }
  throw new Error(`DATA_SOURCE inválido: ${source} (use mock ou sheets)`);
}
