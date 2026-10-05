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
      try {
        // 先终止页面遗留网络等待，再收尾取证；取消请求的 Header RPC 会随 Page 关闭而结束。
        // 保留全部脱敏步骤，不用超时跳过仍在进行的敏感值采集。
        if (!page.isClosed()) await page.close();
        await flushNetworkCapture();
      } finally {
        await saveWorkerValues();
      }
    }
  },
});
