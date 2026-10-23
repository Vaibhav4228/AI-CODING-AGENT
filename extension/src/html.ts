function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function renderHtml(options: { nonce: string; cspSource: string; scriptUri: string; styleUri: string }): string {
  const csp = `default-src 'none'; script-src 'nonce-${options.nonce}'; style-src ${options.cspSource}; img-src ${options.cspSource}; font-src ${options.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace Agent Preview</title><link rel="stylesheet" href="${escape(options.styleUri)}"></head><body><div id="root"></div><script nonce="${escape(options.nonce)}" src="${escape(options.scriptUri)}"></script></body></html>`;
}
