let capturedPublicationCredential: string | undefined;

/**
 * Move the workflow-dispatch bearer out of process.env before any repository
 * code or model subprocess can inherit it. The runner keeps it only in memory
 * until the first successful exchange.
 */
export function getPublicationCredential(): string | undefined {
  if (capturedPublicationCredential) return capturedPublicationCredential;
  const token = process.env.RUN_PUBLICATION_TOKEN?.trim();
  delete process.env.RUN_PUBLICATION_TOKEN;
  if (token) capturedPublicationCredential = token;
  return capturedPublicationCredential;
}

export function clearPublicationCredential(): void {
  capturedPublicationCredential = undefined;
  delete process.env.RUN_PUBLICATION_TOKEN;
}

export function __resetPublicationCredentialForTests(): void {
  capturedPublicationCredential = undefined;
}
