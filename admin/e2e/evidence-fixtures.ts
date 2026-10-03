import { expect, test as base } from '@playwright/test';
import { installEvidenceProtection, observeEvidencePage, persistSensitiveValues } from './evidence-redaction.mjs';

export { expect };

const redactionFile = process.env.MODELRY_EVIDENCE_REDACTION_FILE;

async function saveWorkerValues() {
  await persistSensitiveValues(redactionFile);
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installEvidenceProtection(context);
    try {
      await use(context);
    } finally {
      await saveWorkerValues();
    }
  },
  page: async ({ page }, use) => {
    const flushNetworkCapture = observeEvidencePage(page);
    try {
      await use(page);
    } finally {
      await flushNetworkCapture();
      await saveWorkerValues();
    }
  },
});
