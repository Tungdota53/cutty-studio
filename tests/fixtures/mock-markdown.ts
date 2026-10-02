export const MOCK_MARKDOWN = {
  standard: `# System Status

Here is the current implementation status:
- Task A: completed
- Task B: running
- Task C: pending

Use \`run_tests\` to execute:
\`\`\`typescript
import { test } from 'vitest';
console.log('Running test suite...');
\`\`\`

**Note**: All changes are **strictly validated** before merge.`,

  empty: '',

  plainText: 'This is plain text without any markdown tags or formatting whatsoever.',

  unclosedCodeFence: `Here is some unfinished code:
\`\`\`typescript
const unfinished = true;
function doWork() {
`,

  nestedFormatting: `### Analysis Report
1. Feature **Alpha**: \`alpha_handler()\` is *operational*.
2. Feature **Beta**: \`beta_handler()\` is *deprecated*.
3. Feature **Gamma**: contains [nested link](https://example.com) and \`inline_code\`.`,

  longDocument: Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\nItem ${i} details with **bold** text and \`code_${i}\`.\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\``).join('\n\n')
};
