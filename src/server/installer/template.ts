// QuoteBridge.tpl substitution: only TerminalId and ServerEndpoint change. Everything else
// (flags, EnableRealTrading=false, the root-level expert, no symbol/period/account) stays as bundled.

const TERMINAL_ID_LINE = /^TerminalId=[^\r\n]*/gm;
const SERVER_ENDPOINT_LINE = /^ServerEndpoint=[^\r\n]*/gm;

/** Throws unless the template has exactly one TerminalId and one ServerEndpoint line. */
export function checkTemplate(template: string): void {
  for (const [name, line] of [["TerminalId", TERMINAL_ID_LINE], ["ServerEndpoint", SERVER_ENDPOINT_LINE]] as const) {
    const count = template.match(line)?.length ?? 0;
    if (count !== 1) throw new Error(`Bridge bundle: QuoteBridge.tpl must have one ${name}= line, found ${count}`);
  }
}

export function serverEndpointFor(eaPort: number): string {
  return `tcp://127.0.0.1:${eaPort}`;
}

export function substituteTemplate(template: string, values: { terminalId: string; serverEndpoint: string }): string {
  checkTemplate(template);
  return template
    .replace(TERMINAL_ID_LINE, () => `TerminalId=${values.terminalId}`)
    .replace(SERVER_ENDPOINT_LINE, () => `ServerEndpoint=${values.serverEndpoint}`);
}

/** The TerminalId a template carries (e.g. a legacy `mt4-main`), if any. */
export function templateTerminalId(template: string): string | undefined {
  return template.match(/^TerminalId=([^\r\n]*)/m)?.[1];
}
