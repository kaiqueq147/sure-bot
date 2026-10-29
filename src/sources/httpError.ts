/** User-Agent de navegador: alguns WAFs barram o padrão do Node ("node") em IPs de datacenter. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Resumo de uma resposta de erro para o painel de saúde: quem respondeu (Cloudflare, CloudFront…),
 * se é desafio anti-bot e o título/trecho da página. Em produção é o que diferencia bloqueio de
 * região, de IP de datacenter ou queda da casa.
 */
export function describeHttpError(status: number, headers: Headers, body: string): string {
  const parts = [`HTTP ${status}`];
  const server = headers.get('server');
  if (server) parts.push(`servidor ${server}`);
  if (headers.get('cf-mitigated') === 'challenge') parts.push('desafio da Cloudflare');
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim();
  const snippet = title ?? body.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (snippet) parts.push(`"${snippet}"`);
  return parts.join(' · ');
}
