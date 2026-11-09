import { readFile, writeFile } from 'node:fs/promises';
import { extractHistoryWorkbook } from '../services/customerServiceHistoryWorkbook.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node scripts/extractCustomerServiceHistory.js INPUT.xlsx OUTPUT.private.json (read-only extraction; no database writes)');
const result=extractHistoryWorkbook(await readFile(input));
await writeFile(output,JSON.stringify(result),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({workbookSha256:result.workbookSha256,...result.report},null,2));
